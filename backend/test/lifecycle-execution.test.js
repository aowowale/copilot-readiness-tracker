import test from "node:test";
import assert from "node:assert/strict";
import { executeLifecycleDecision, lifecycleConfirmation } from "../src/lib/lifecycle-execution.js";
import { buildOwnerTasks, STEPS, submitDecision, reviewDecision } from "../src/lib/owner-tasks.js";

const NOW = new Date("2026-10-10T00:00:00Z");
const owner = { id: "owner", name: "Owner" };
const approver = { id: "approver", name: "Approver" };
const executor = { id: "executor", name: "Executor" };
const complete = (task) => ({ ...task, steps: Object.fromEntries(STEPS.map(step => [step, { done: true, savedAt: NOW.toISOString(), savedBy: owner.id }])) });
const workspace = (overrides = {}) => ({ id: "team-1", name: "Finance", type: "Private team", legalHold: false, retentionLocked: false, evidence: { generatedAt: NOW.toISOString() }, ...overrides });

function approvedDecision(choice, ws = workspace()) {
  const task = complete(buildOwnerTasks({ workspaces: [ws], now: NOW }).tasks[0]);
  const request = submitDecision(task, { choice, reason: `Reviewed the proposed ${choice} with the business owner.` }, owner, ws, NOW);
  assert.equal(request.decision.status, "pending-approval");
  return reviewDecision(request.decision, request.task, { outcome: "approve", reason: "Approved after independent review." }, approver, NOW).decision;
}

test("archive/delete submissions require a reason and second approval", () => {
  const task = complete(buildOwnerTasks({ workspaces: [workspace()], now: NOW }).tasks[0]);
  assert.throws(() => submitDecision(task, { choice: "archive" }, owner, workspace(), NOW), /reason/);
  const result = submitDecision(task, { choice: "archive", reason: "No longer an active collaboration." }, owner, workspace(), NOW);
  assert.equal(result.decision.status, "pending-approval");
  assert.equal(result.decision.requiresSecondApprover, true);
});

test("dry-run archive requires the exact typed phrase and records, but does not change, the tenant", async () => {
  const decision = approvedDecision("archive");
  const graph = { post: async () => assert.fail("dry run must not call Graph") };
  const opts = { decision, workspace: workspace(), actor: executor, graph, mode: "dry-run", lifecycleEnabled: false, confirmation: "ARCHIVE Finance", now: NOW };
  await assert.rejects(() => executeLifecycleDecision({ ...opts, confirmation: "yes" }), /Type exactly/);
  const result = await executeLifecycleDecision(opts);
  assert.equal(result.decision.executionStatus, "simulated");
  assert.equal(result.verification.result, "dry-run");
  assert.equal(result.audit.outcome, "simulated");
  await assert.rejects(() => executeLifecycleDecision({ ...opts, decision: { ...decision, reviewedBy: null } }), /independent second-approver/);
});

test("live archive requires the explicit feature flag, separate actors, and Graph readback", async () => {
  const decision = approvedDecision("archive");
  const callLog = [];
  let archived = false;
  const graph = {
    post: async (path, body) => { callLog.push([path, body]); archived = true; },
    get: async () => ({ id: "team-1", isArchived: archived }),
    remove: async () => {}
  };
  const opts = { decision, workspace: workspace(), actor: executor, graph, mode: "live", lifecycleEnabled: true, confirmation: "ARCHIVE Finance", now: NOW };
  await assert.rejects(() => executeLifecycleDecision({ ...opts, lifecycleEnabled: false }), /not explicitly enabled/);
  await assert.rejects(() => executeLifecycleDecision({ ...opts, actor: approver }), /Approver cannot also execute/);
  const result = await executeLifecycleDecision(opts);
  assert.equal(result.decision.executionStatus, "executed-and-verified");
  assert.equal(result.verification.result, "archived-and-verified");
  assert.deepEqual(callLog[0], ["/teams/team-1/archive", {}]);
});

test("delete remains blocked when evidence is missing, stale, or hold/retention are not explicitly clear", async () => {
  const decision = approvedDecision("delete");
  const base = { decision, workspace: workspace(), actor: executor, graph: { remove: async () => {}, get: async () => { const e = new Error("gone"); e.status = 404; throw e; } }, mode: "dry-run", lifecycleEnabled: false, confirmation: "DELETE Finance", now: NOW };
  await assert.rejects(() => executeLifecycleDecision({ ...base, workspace: workspace({ legalHold: null }) }), /legal-hold status is unknown/);
  await assert.rejects(() => executeLifecycleDecision({ ...base, workspace: workspace({ evidence: null }) }), /missing or stale/);
  await assert.rejects(() => executeLifecycleDecision({ ...base, workspace: workspace({ evidence: { generatedAt: "2020-01-01T00:00:00Z" } }) }), /missing or stale/);
  await assert.rejects(() => executeLifecycleDecision({ ...base, workspace: workspace({ retentionLocked: true }) }), /Retention or a records label applies/);
  assert.equal((await executeLifecycleDecision(base)).verification.result, "dry-run");
});

test("live deletion is a verified soft delete and not a content-purge claim", async () => {
  const decision = approvedDecision("delete");
  const calls = [];
  const graph = { remove: async path => calls.push(path), get: async () => { const e = new Error("gone"); e.status = 404; throw e; } };
  const result = await executeLifecycleDecision({ decision, workspace: workspace(), actor: executor, graph, mode: "live", lifecycleEnabled: true, confirmation: "DELETE Finance", now: NOW });
  assert.deepEqual(calls, ["/groups/team-1"]);
  assert.equal(result.verification.result, "soft-deleted-and-verified");
  assert.equal(result.verification.method, "group-404-after-soft-delete");
});
