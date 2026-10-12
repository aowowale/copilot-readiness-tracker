// Mover reviews: when someone changes role, their manager reviews every Team they belong to and
// decides keep or remove. A removal is not executed by the manager; it becomes a pending
// request on that workspace's own review, so the workspace owner confirms it through the same
// preview, confirm and verify path as any other removal. Nothing here changes the tenant.

import { GOVERNANCE_QUEUE, TaskRuleError } from "./owner-tasks.js";

export const MOVER_TASK_TYPE = "mover-review";
const MAX_ITEMS = 40;
const FIRST_DUE_DAYS = 14;
const DAY_MS = 86_400_000;
const iso = (date) => new Date(date).toISOString();
const stable = (value) => String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160);

export const moverTaskId = (caseId) => `mover-${stable(caseId)}`;

export function buildMoverTask({ roleChange, memberships, itemsSource, managerContact = null, now = new Date() }) {
  const allowed = new Set(roleChange.allowedResourceIds || []);
  const items = memberships
    .map((membership) => ({
      workspaceId: String(membership.workspaceId),
      workspaceName: membership.workspaceName || String(membership.workspaceId),
      access: membership.access === "owner" ? "owner" : "member",
      // null = the feed gave no baseline, so nothing is assumed to be outside the new role.
      expected: allowed.size ? allowed.has(String(membership.workspaceId)) : null,
      decision: null,
      reason: null
    }))
    .sort((left, right) => Number(left.expected !== false) - Number(right.expected !== false) || left.workspaceName.localeCompare(right.workspaceName));

  const managerId = roleChange.after?.managerId || roleChange.before?.managerId || null;
  const assigned = managerId ? { assigneeKind: "manager", assigneeIds: [managerId] } : { assigneeKind: "governance-queue", assigneeIds: [GOVERNANCE_QUEUE.id] };
  return {
    taskId: moverTaskId(roleChange.caseId),
    taskType: MOVER_TASK_TYPE,
    cycle: 1,
    workspaceId: null,
    workspaceName: `Access review: ${roleChange.userDisplayName || roleChange.userId}`,
    subject: {
      userId: roleChange.userId,
      displayName: roleChange.userDisplayName || null,
      oldRole: roleChange.oldRole || null,
      newRole: roleChange.newRole || null,
      effectiveAt: roleChange.effectiveAt || null,
      changedAttributes: roleChange.changedAttributes || []
    },
    items: items.slice(0, MAX_ITEMS),
    itemsTruncated: items.length > MAX_ITEMS,
    itemsSource,
    managerContact,
    ...assigned,
    assignmentHistory: [],
    status: "open",
    steps: {},
    currentStep: "review",
    createdAt: iso(now),
    dueAt: iso(new Date(now).getTime() + FIRST_DUE_DAYS * DAY_MS),
    escalationLevel: 0,
    escalationHistory: [],
    defaultOutcome: "no-change",
    notificationMode: "recorded-only",
    riskLevel: "Unknown",
    riskScore: null,
    cadenceDays: 90,
    ownerNames: null,
    decision: null,
    version: 0
  };
}

// The newest non-closed renewal task for each workspace is where a removal request is routed.
export function latestWorkspaceTasks(tasks) {
  const latest = new Map();
  for (const task of tasks) {
    if (task.taskType === MOVER_TASK_TYPE || !task.workspaceId) continue;
    const current = latest.get(task.workspaceId);
    if (!current || task.cycle > current.cycle) latest.set(task.workspaceId, task);
  }
  return latest;
}

export function submitMoverDecisions({ task, decisions, actor, workspaceTasks, now = new Date() }) {
  if (task.taskType !== MOVER_TASK_TYPE) throw new TaskRuleError("This is not an access review.", 400);
  if (task.status === "decided") throw new TaskRuleError("This review is already decided.");
  if (!Array.isArray(decisions)) throw new TaskRuleError("Decisions are required.", 400);

  const byWorkspace = new Map(decisions.map((decision) => [String(decision?.workspaceId), decision]));
  const missing = task.items.find((item) => !byWorkspace.has(item.workspaceId));
  if (missing) throw new TaskRuleError(`Decide ${missing.workspaceName}: every item needs keep or remove.`, 400);

  const items = [];
  const requests = [];
  const unrouted = [];
  for (const item of task.items) {
    const decision = byWorkspace.get(item.workspaceId);
    if (!["keep", "remove"].includes(decision.choice)) throw new TaskRuleError(`Choose keep or remove for ${item.workspaceName}.`, 400);
    const reason = typeof decision.reason === "string" ? decision.reason.trim().slice(0, 300) : "";
    if (decision.choice === "keep" && reason.length < 5) throw new TaskRuleError(`Say why ${task.subject.displayName || "this person"} still needs ${item.workspaceName}.`, 400);
    items.push({ ...item, decision: decision.choice, reason: reason || null });

    if (decision.choice !== "remove") continue;
    const workspaceTask = workspaceTasks.get(item.workspaceId);
    if (item.access === "owner") {
      unrouted.push({ workspaceId: item.workspaceId, workspaceName: item.workspaceName, reason: "An owner is changed by another owner or an administrator, not through a removal request." });
    } else if (!workspaceTask) {
      unrouted.push({ workspaceId: item.workspaceId, workspaceName: item.workspaceName, reason: "This workspace is not in the inventory yet, so there is no owner review to route to." });
    } else {
      requests.push({
        actionId: `${workspaceTask.taskId}-rm-${task.subject.userId}`,
        caseId: workspaceTask.taskId,
        taskId: workspaceTask.taskId,
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName,
        actionType: "remove-member",
        targetUserId: task.subject.userId,
        targetDisplayName: task.subject.displayName,
        targetUserType: "Member",
        origin: "role-change",
        moverTaskId: task.taskId,
        reason: `Role change (${task.subject.oldRole || "previous role"} to ${task.subject.newRole || "new role"}): ${reason || "no longer needed in the new role"}`.slice(0, 500),
        status: "proposed",
        requestedBy: actor.id,
        requestedByName: actor.name || null,
        requestedAt: iso(now)
      });
    }
  }

  const decidedAt = iso(now);
  const decisionId = `${task.taskId}-d${task.version + 1}`;
  const kept = items.filter((item) => item.decision === "keep").length;
  const decision = {
    decisionId,
    taskId: task.taskId,
    workspaceId: null,
    workspaceName: task.workspaceName,
    choice: "mover-review",
    status: "recorded",
    reason: null,
    decidedBy: actor.id,
    decidedByName: actor.name || null,
    decidedAt,
    executionStatus: "not-executed",
    requiresSecondApprover: false,
    blockers: [],
    evidence: { kept, removalRequests: requests.length, unrouted: unrouted.length, source: task.itemsSource }
  };
  const updated = {
    ...task,
    items,
    status: "decided",
    decidedAt,
    decidedBy: actor.id,
    nextReviewAt: null,
    decision: { decisionId, choice: "mover-review", status: "recorded", decidedAt },
    version: task.version + 1
  };
  const audit = {
    auditId: decisionId,
    caseId: task.taskId,
    eventType: "mover-review-decided",
    decisionId,
    kept,
    removalRequests: requests.length,
    actorId: actor.id,
    actorName: actor.name || null,
    occurredAt: decidedAt
  };
  return { task: updated, requests, unrouted, decision, audit };
}
