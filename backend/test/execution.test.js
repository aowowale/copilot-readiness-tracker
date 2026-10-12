import test from "node:test";
import assert from "node:assert/strict";
import { executeAction, ExecutionRuleError, proposeMemberRemovals, REMOVAL_LIMIT } from "../src/lib/execution.js";

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const actor = { id: id(1), name: "Owner" };
const task = { taskId: "team-1-c1", workspaceId: "team-1", workspaceName: "Finance", status: "open" };

function fakeGraph({ members, owners = [{ id: id(1) }], writable = true } = {}) {
  const state = { members: [...members], removed: [] };
  const graph = {
    state,
    getAll: async (path) => {
      if (path.includes("/owners?")) return owners;
      return state.members.concat(owners);
    }
  };
  if (writable) {
    graph.remove = async (path) => {
      const userId = path.split("/members/")[1].split("/")[0];
      state.members = state.members.filter((member) => member.id !== userId);
      state.removed.push(userId);
    };
  }
  return graph;
}

const people = [
  { id: id(2), displayName: "Guest Gail", userType: "Guest" },
  { id: id(3), displayName: "Member Max", userType: "Member" }
];

test("only current non-owner members can be proposed, and the actor cannot remove themselves", async () => {
  const graph = fakeGraph({ members: people });
  const result = await proposeMemberRemovals({ task, userIds: [id(2), id(1), id(9)], actor, graph, reason: " cleanup " });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].targetUserType, "Guest");
  assert.equal(result.actions[0].reason, "cleanup");
  assert.equal(result.actions[0].status, "proposed");
  assert.deepEqual(result.rejected.map((item) => item.userId).sort(), [id(1), id(9)].sort());
});

test("proposals enforce the request limit, valid ids and an open task", async () => {
  const graph = fakeGraph({ members: people });
  await assert.rejects(() => proposeMemberRemovals({ task, userIds: [], actor, graph }), ExecutionRuleError);
  await assert.rejects(() => proposeMemberRemovals({ task, userIds: ["not-an-id"], actor, graph }), /not valid/);
  const many = Array.from({ length: REMOVAL_LIMIT + 1 }, (_, index) => id(100 + index));
  await assert.rejects(() => proposeMemberRemovals({ task, userIds: many, actor, graph }), /at most/);
  await assert.rejects(() => proposeMemberRemovals({ task: { ...task, status: "decided" }, userIds: [id(2)], actor, graph }), /already decided/);
});

test("dry run verifies membership but changes nothing", async () => {
  const graph = fakeGraph({ members: people, writable: false });
  const { actions } = await proposeMemberRemovals({ task, userIds: [id(2)], actor, graph });
  const result = await executeAction({ action: actions[0], actor, graph, mode: "dry-run" });
  assert.equal(result.action.status, "simulated");
  assert.equal(result.action.executionStatus, "not-executed");
  assert.equal(result.verification.result, "dry-run");
  assert.equal(graph.state.members.length, 2);
  assert.equal(result.audit.mode, "dry-run");
});

test("live execution removes the member and verifies by reading again", async () => {
  const graph = fakeGraph({ members: people });
  const { actions } = await proposeMemberRemovals({ task, userIds: [id(2)], actor, graph });
  const result = await executeAction({ action: actions[0], actor, graph, mode: "live" });
  assert.deepEqual(graph.state.removed, [id(2)]);
  assert.equal(result.action.status, "verified");
  assert.equal(result.action.executionStatus, "executed");
  assert.equal(result.verification.result, "absent");
  assert.equal(result.audit.outcome, "verified");
});

test("a removal that does not take effect is reported as failed, not verified", async () => {
  const graph = fakeGraph({ members: people });
  graph.remove = async () => {};
  const { actions } = await proposeMemberRemovals({ task, userIds: [id(2)], actor, graph });
  const result = await executeAction({ action: actions[0], actor, graph, mode: "live" });
  assert.equal(result.action.status, "failed");
  assert.equal(result.verification.result, "still-present");
});

test("a Graph error fails the action without throwing and can be retried", async () => {
  const graph = fakeGraph({ members: people });
  graph.remove = async () => { const error = new Error("denied"); error.status = 403; throw error; };
  const { actions } = await proposeMemberRemovals({ task, userIds: [id(2)], actor, graph });
  const failed = await executeAction({ action: actions[0], actor, graph, mode: "live" });
  assert.equal(failed.action.status, "failed");
  assert.match(failed.action.resultDetail, /403/);

  const working = fakeGraph({ members: people });
  const retried = await executeAction({ action: failed.action, actor, graph: working, mode: "live" });
  assert.equal(retried.action.status, "verified");
});

test("an already-removed member is verified without a second removal", async () => {
  const graph = fakeGraph({ members: people });
  const { actions } = await proposeMemberRemovals({ task, userIds: [id(2)], actor, graph });
  graph.state.members = graph.state.members.filter((member) => member.id !== id(2));
  const result = await executeAction({ action: actions[0], actor, graph, mode: "live" });
  assert.equal(result.verification.result, "already-absent");
  assert.deepEqual(graph.state.removed, []);
});

test("live mode without a writable client is refused, and completed actions cannot rerun", async () => {
  const readOnly = fakeGraph({ members: people, writable: false });
  const { actions } = await proposeMemberRemovals({ task, userIds: [id(2)], actor, graph: readOnly });
  await assert.rejects(() => executeAction({ action: actions[0], actor, graph: readOnly, mode: "live" }), /executor identity/);

  const graph = fakeGraph({ members: people });
  const done = (await executeAction({ action: actions[0], actor, graph, mode: "live" })).action;
  await assert.rejects(() => executeAction({ action: done, actor, graph, mode: "live" }), /already verified/);
});

test("the default graph client cannot delete", async () => {
  const { createGraphClient } = await import("../src/lib/graph.js");
  const config = { graphBaseUrl: "https://graph.example", graphScope: "x/.default" };
  assert.equal(typeof createGraphClient(config).remove, "undefined");
  assert.equal(typeof createGraphClient(config, { clientId: "abc", writable: true }).remove, "function");
});
