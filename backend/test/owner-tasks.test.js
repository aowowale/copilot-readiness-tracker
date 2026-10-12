import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEscalation,
  buildOwnerTasks,
  canActOnTask,
  deleteGate,
  escalationLevel,
  GOVERNANCE_QUEUE,
  reviewDecision,
  saveStep,
  STEPS,
  submitDecision,
  TaskRuleError
} from "../src/lib/owner-tasks.js";
import { syncOwnerTasks } from "../src/lib/owner-task-sync.js";

const now = new Date("2026-03-01T00:00:00Z");
const day = (n) => new Date(now.getTime() + n * 86_400_000);
const owner = { id: "o1", name: "Owner One" };
const workspace = {
  id: "team-1",
  name: "Finance",
  owners: ["Owner One"],
  ownerDetails: [{ id: "o1", displayName: "Owner One", managerId: "m1", managerName: "Manager" }],
  guests: 2,
  shadowUsers: { count: 1 },
  risk: { level: "High", score: 60, renewalCadenceDays: 90 }
};

function freshTask() {
  return buildOwnerTasks({ workspaces: [workspace], now }).tasks[0];
}

function completed(task) {
  return STEPS.reduce((current, step) => saveStep(current, step, {}, owner, now), task);
}

test("a task is created per workspace for its owners and is never unassigned", () => {
  const task = freshTask();
  assert.deepEqual(task.assigneeIds, ["o1"]);
  assert.ok(canActOnTask(task, owner));
  assert.equal(canActOnTask(task, { id: "someone-else" }), false);

  const ownerless = buildOwnerTasks({ workspaces: [{ id: "team-2", name: "Orphan", owners: [], ownerDetails: [], risk: {} }], now }).tasks[0];
  assert.deepEqual(ownerless.assigneeIds, [GOVERNANCE_QUEUE.id]);
  assert.equal(ownerless.assigneeKind, "governance-queue");
});

test("repeated runs do not duplicate or rewrite an unchanged task", () => {
  const task = freshTask();
  const again = buildOwnerTasks({ workspaces: [workspace], existingTasks: [task], now });
  assert.equal(again.tasks.length, 0);
  assert.equal(again.created, 0);
});

test("steps must be completed in order and progress is saved", () => {
  const task = freshTask();
  assert.throws(() => saveStep(task, "links", {}, owner, now), /Complete the contacts step first/);

  const first = saveStep(task, "contacts", { primary: " Ada ", secondary: "Bo", ignored: "x" }, owner, now);
  assert.equal(first.steps.contacts.data.primary, "Ada");
  assert.equal("ignored" in first.steps.contacts.data, false);
  assert.equal(first.currentStep, "membership");
  assert.equal(first.version, task.version + 1);
  assert.throws(() => saveStep(task, "contacts", { primary: 5 }, owner, now), TaskRuleError);
});

test("keep needs all five steps and records exactly one decision", () => {
  const task = freshTask();
  assert.throws(() => submitDecision(task, { choice: "keep" }, owner, workspace, now), /Complete the contacts step first/);

  const result = submitDecision(completed(task), { choice: "keep", reason: "In use" }, owner, workspace, now);
  assert.equal(result.task.status, "decided");
  assert.equal(result.decision.status, "recorded");
  assert.equal(result.decision.executionStatus, "not-executed");
  assert.equal(result.audit.decisionId, result.decision.decisionId);
  assert.equal(result.audit.caseId, task.taskId);
  assert.ok(result.task.nextReviewAt);
  assert.throws(() => submitDecision(result.task, { choice: "keep" }, owner, workspace, now), /already decided/);
});

test("delete is blocked while hold or retention is unknown or applied", () => {
  assert.equal(deleteGate({}).allowed, false);
  assert.equal(deleteGate({ legalHold: true, retentionLocked: false }).allowed, false);
  assert.equal(deleteGate({ legalHold: false, retentionLocked: false }).allowed, true);

  const task = completed(freshTask());
  assert.throws(() => submitDecision(task, { choice: "delete" }, owner, workspace, now), /reason is required/);
  const blocked = submitDecision(task, { choice: "delete", reason: "Obsolete" }, owner, workspace, now);
  assert.equal(blocked.decision.status, "blocked");
  assert.ok(blocked.decision.blockers.length);
  assert.equal(blocked.task.status, "pending-approval");
  assert.throws(() => reviewDecision(blocked.decision, blocked.task, { outcome: "approve" }, { id: "ap1" }, now), /Blocked/);
});

test("delete needs a different approver and still does not execute", () => {
  const clear = { ...workspace, legalHold: false, retentionLocked: false };
  const result = submitDecision(completed(freshTask()), { choice: "delete", reason: "Obsolete" }, owner, clear, now);
  assert.equal(result.decision.status, "pending-approval");
  assert.equal(result.decision.requiresSecondApprover, true);

  assert.throws(() => reviewDecision(result.decision, result.task, { outcome: "approve" }, owner, now), /different approver/);
  const approved = reviewDecision(result.decision, result.task, { outcome: "approve" }, { id: "ap1" }, now);
  assert.equal(approved.decision.status, "approved-not-executed");
  assert.equal(approved.decision.executionStatus, "not-executed");

  const rejected = reviewDecision(result.decision, result.task, { outcome: "reject", reason: "The workspace still has a business purpose." }, { id: "ap1" }, now);
  assert.equal(rejected.task.status, "open");
});

test("not responsible goes to the manager first, then the governance queue", () => {
  const first = submitDecision(freshTask(), { choice: "not-responsible" }, owner, workspace, now);
  assert.deepEqual(first.decision.nextAssignee, { id: "m1", name: "Manager", kind: "manager" });
  assert.deepEqual(first.task.assigneeIds, ["m1"]);
  assert.equal(first.task.status, "open");

  const manager = { id: "m1", name: "Manager" };
  const second = submitDecision(first.task, { choice: "not-responsible" }, manager, workspace, now);
  assert.equal(second.decision.nextAssignee.id, GOVERNANCE_QUEUE.id);
  assert.equal(second.task.assignmentHistory.length, 2);
  assert.ok(second.task.assigneeIds.length > 0);
});

test("a manager is not reused when the owner has none", () => {
  const noManager = { ...workspace, ownerDetails: [{ id: "o1" }] };
  const result = submitDecision(freshTask(), { choice: "not-responsible" }, owner, noManager, now);
  assert.equal(result.decision.nextAssignee.id, GOVERNANCE_QUEUE.id);
});

test("unanswered tasks escalate on schedule and never default to deletion", () => {
  const task = freshTask();
  assert.equal(escalationLevel(task, now), 0);
  assert.equal(escalationLevel(task, day(14)), 1);
  assert.equal(escalationLevel(task, day(21)), 2);
  assert.equal(escalationLevel(task, day(28)), 3);

  const level1 = applyEscalation(task, workspace, day(14));
  assert.equal(level1.escalationLevel, 1);
  const level2 = applyEscalation(level1, workspace, day(21));
  assert.ok(level2.assigneeIds.includes("m1"));
  const level3 = applyEscalation(level2, workspace, day(28));
  assert.ok(level3.assigneeIds.includes(GOVERNANCE_QUEUE.id));
  assert.equal(level3.defaultOutcome, "no-change");
  assert.equal(level3.status, "open");
  assert.equal(level3.decision, null);
  assert.equal(applyEscalation(level3, workspace, day(29)), null);
});

test("decided and approval-pending tasks do not escalate", () => {
  const decided = submitDecision(completed(freshTask()), { choice: "keep" }, owner, workspace, now).task;
  assert.equal(escalationLevel(decided, day(60)), 0);
});

test("a decided task reopens as a new cycle when its review date passes", () => {
  const decided = submitDecision(completed(freshTask()), { choice: "keep" }, owner, workspace, now).task;
  assert.equal(buildOwnerTasks({ workspaces: [workspace], existingTasks: [decided], now: day(30) }).created, 0);
  const next = buildOwnerTasks({ workspaces: [workspace], existingTasks: [decided], now: day(91) });
  assert.equal(next.created, 1);
  assert.equal(next.tasks[0].cycle, 2);
});

test("task sync uses etags and reports concurrent edits instead of overwriting", async () => {
  const stale = { ...freshTask(), dueAt: day(-30).toISOString() };
  const writes = [];
  const repository = {
    readTasksWithEtag: async () => [{ record: stale, etag: "e1" }],
    createTaskIfAbsent: async () => true,
    updateTaskIfUnchanged: async (task, etag) => { writes.push({ task, etag }); return false; }
  };
  const result = await syncOwnerTasks({ workspaces: [workspace], repository, now });
  assert.equal(writes[0].etag, "e1");
  assert.equal(result.conflicts, 1);
  assert.equal(result.written, 0);
});
