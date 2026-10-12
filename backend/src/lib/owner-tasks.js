// Owner workflow (Phase 1, read-only). Tasks, step progress, decisions, reassignment
// and escalation are recorded here. Nothing in this module changes the tenant:
// archive and delete outcomes are recorded as "not-executed" until Phase 2.

export const GOVERNANCE_QUEUE = { id: "governance-queue", name: "Governance queue" };
export const STEPS = ["contacts", "membership", "permissions", "links", "metadata"];
export const CHOICES = ["keep", "archive", "delete", "not-responsible"];
export const ESCALATION_LADDER = [
  { level: 1, afterDays: 0, action: "remind-owners" },
  { level: 2, afterDays: 7, action: "notify-manager" },
  { level: 3, afterDays: 14, action: "route-to-governance-queue" }
];

const FIRST_DUE_DAYS = 14;
const DAY_MS = 86_400_000;
const STEP_FIELDS = {
  contacts: { primary: "string", secondary: "string" },
  membership: { reviewed: "boolean", removalCandidates: "array" },
  permissions: { reviewed: "boolean", shadowUsersAcknowledged: "boolean", removalCandidates: "array" },
  links: { reviewed: "boolean", revokeCandidates: "array" },
  metadata: { description: "string", businessPurpose: "string" }
};

export class TaskRuleError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "TaskRuleError";
    this.status = status;
  }
}

const iso = (date) => new Date(date).toISOString();
const addDays = (date, days) => iso(new Date(date).getTime() + days * DAY_MS);
const stable = (value) => String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 200);
const isClosed = (task) => task.status === "decided";

function ownerIds(workspace) {
  return (workspace.ownerDetails || []).map((owner) => owner.id).filter(Boolean);
}

function summaryFields(workspace) {
  return {
    workspaceName: workspace.name || workspace.id,
    riskLevel: workspace.risk?.level || "Unknown",
    riskScore: workspace.risk?.score ?? null,
    cadenceDays: workspace.risk?.renewalCadenceDays || 90,
    ownerNames: Array.isArray(workspace.owners) ? workspace.owners : null
  };
}

function assignment(workspace) {
  const ids = ownerIds(workspace);
  return ids.length
    ? { assigneeKind: "owners", assigneeIds: ids }
    : { assigneeKind: "governance-queue", assigneeIds: [GOVERNANCE_QUEUE.id] };
}

function newTask(workspace, cycle, now) {
  return {
    taskId: `${stable(workspace.id)}-c${cycle}`,
    taskType: "renewal",
    cycle,
    workspaceId: workspace.id,
    ...summaryFields(workspace),
    ...assignment(workspace),
    assignmentHistory: [],
    status: "open",
    steps: {},
    currentStep: STEPS[0],
    createdAt: iso(now),
    dueAt: addDays(now, FIRST_DUE_DAYS),
    escalationLevel: 0,
    escalationHistory: [],
    defaultOutcome: "no-change",
    notificationMode: "recorded-only",
    decision: null,
    version: 0
  };
}

// Returns only the tasks that must be written: new cycles and refreshed open tasks.
export function buildOwnerTasks({ workspaces, existingTasks = [], now = new Date() }) {
  const latestByWorkspace = new Map();
  for (const task of existingTasks) {
    const current = latestByWorkspace.get(task.workspaceId);
    if (!current || task.cycle > current.cycle) latestByWorkspace.set(task.workspaceId, task);
  }

  const changed = [];
  let created = 0;
  for (const workspace of workspaces) {
    const latest = latestByWorkspace.get(workspace.id);
    if (!latest) {
      changed.push(newTask(workspace, 1, now));
      created += 1;
    } else if (isClosed(latest)) {
      if (latest.nextReviewAt && new Date(latest.nextReviewAt) <= now) {
        changed.push(newTask(workspace, latest.cycle + 1, now));
        created += 1;
      }
    } else {
      const refreshed = { ...latest, ...summaryFields(workspace) };
      if (latest.assigneeKind === "owners") Object.assign(refreshed, assignment(workspace));
      if (JSON.stringify(refreshed) !== JSON.stringify(latest)) changed.push({ ...refreshed, version: latest.version + 1 });
    }
  }
  return { tasks: changed, created };
}

export function canActOnTask(task, principal) {
  return Boolean(principal?.id) && task.assigneeIds.includes(principal.id);
}

function sanitizeStepData(step, data) {
  const fields = STEP_FIELDS[step];
  const clean = {};
  for (const [key, type] of Object.entries(fields)) {
    const value = data?.[key];
    if (value === undefined) continue;
    if (type === "string" && typeof value === "string") clean[key] = value.trim().slice(0, 200);
    else if (type === "boolean" && typeof value === "boolean") clean[key] = value;
    else if (type === "array" && Array.isArray(value)) {
      clean[key] = value.filter((item) => typeof item === "string").map((item) => item.slice(0, 100)).slice(0, 50);
    } else throw new TaskRuleError(`Field ${key} is not valid for step ${step}.`, 400);
  }
  return clean;
}

function assertOpen(task) {
  if (isClosed(task)) throw new TaskRuleError("This task is already decided.");
  if (task.status === "pending-approval") throw new TaskRuleError("This task is waiting for an approver.");
}

export function saveStep(task, step, data, actor, now = new Date()) {
  assertOpen(task);
  const index = STEPS.indexOf(step);
  if (index < 0) throw new TaskRuleError("Unknown step.", 400);
  const previous = STEPS.slice(0, index).find((name) => !task.steps[name]?.done);
  if (previous) throw new TaskRuleError(`Complete the ${previous} step first.`);

  return {
    ...task,
    status: "in-progress",
    steps: { ...task.steps, [step]: { done: true, savedAt: iso(now), savedBy: actor.id, data: sanitizeStepData(step, data) } },
    currentStep: STEPS[index + 1] || "submit",
    version: task.version + 1
  };
}

// Delete is blocked unless hold and retention are both positively known to be absent.
export function deleteGate(workspace) {
  const reasons = [];
  if (workspace?.legalHold !== false) reasons.push(workspace?.legalHold === true ? "Legal hold is applied." : "Legal hold status is unknown.");
  if (workspace?.retentionLocked !== false) reasons.push(workspace?.retentionLocked === true ? "Retention or a records label applies." : "Retention status is unknown.");
  return { allowed: reasons.length === 0, reasons };
}

function managerOf(workspace, actor) {
  const owner = (workspace.ownerDetails || []).find((item) => item.id === actor.id);
  return owner?.managerId ? { id: owner.managerId, name: owner.managerName || null } : null;
}

function reassign(task, workspace, actor, reason, now) {
  const tried = new Set([...task.assignmentHistory.map((entry) => entry.to), ...task.assigneeIds]);
  const manager = managerOf(workspace, actor);
  const next = manager && !tried.has(manager.id) ? { ...manager, kind: "manager" } : { ...GOVERNANCE_QUEUE, kind: "governance-queue" };
  return {
    next,
    task: {
      ...task,
      assigneeKind: next.kind,
      assigneeIds: [next.id],
      assignmentHistory: [...task.assignmentHistory, { from: actor.id, to: next.id, toName: next.name, kind: next.kind, reason, at: iso(now) }],
      escalationLevel: 0,
      dueAt: addDays(now, FIRST_DUE_DAYS),
      status: "open",
      version: task.version + 1
    }
  };
}

export function submitDecision(task, input, actor, workspace, now = new Date()) {
  assertOpen(task);
  const { choice } = input;
  if (!CHOICES.includes(choice)) throw new TaskRuleError("Unknown decision.", 400);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";

  const unfinished = STEPS.find((step) => !task.steps[step]?.done);
  if (choice !== "not-responsible" && unfinished) throw new TaskRuleError(`Complete the ${unfinished} step first.`);
  if (["archive", "delete"].includes(choice) && !reason) throw new TaskRuleError(`A reason is required to request ${choice}.`, 400);

  const decisionId = `${task.taskId}-d${task.version + 1}`;
  const decision = {
    decisionId,
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    workspaceName: task.workspaceName,
    choice,
    reason: reason || null,
    decidedBy: actor.id,
    decidedByName: actor.name || null,
    decidedAt: iso(now),
    executionStatus: "not-executed",
    requiresSecondApprover: ["archive", "delete"].includes(choice),
    blockers: [],
    evidence: {
      riskLevel: task.riskLevel,
      riskScore: task.riskScore,
      ownerNames: task.ownerNames,
      guests: workspace?.guests ?? null,
      shadowUsers: workspace?.shadowUsers?.count ?? null,
      legalHold: workspace?.legalHold ?? null,
      retentionLocked: workspace?.retentionLocked ?? null,
      evidenceGeneratedAt: workspace?.evidence?.generatedAt || null,
      steps: Object.fromEntries(Object.entries(task.steps).map(([name, step]) => [name, { savedAt: step.savedAt, savedBy: step.savedBy }]))
    }
  };

  let updated;
  if (choice === "not-responsible") {
    const result = reassign(task, workspace || {}, actor, reason || "Owner is not responsible.", now);
    decision.status = "reassigned";
    decision.nextAssignee = { id: result.next.id, name: result.next.name, kind: result.next.kind };
    updated = result.task;
  } else if (["archive", "delete"].includes(choice)) {
    const gate = choice === "delete"
      ? deleteGate(workspace)
      : { allowed: workspace?.legalHold === false, reasons: [workspace?.legalHold === true ? "Legal hold is applied; archive is blocked by tenant policy." : "Legal hold status is unknown; archive is blocked until evidence is refreshed."] };
    decision.blockers = gate.reasons;
    decision.status = gate.allowed ? "pending-approval" : "blocked";
    updated = {
      ...task,
      status: "pending-approval",
      assigneeIds: [...new Set([...task.assigneeIds, GOVERNANCE_QUEUE.id])],
      version: task.version + 1
    };
  } else {
    decision.status = "recorded";
    updated = { ...task, status: "decided", nextReviewAt: addDays(now, task.cadenceDays), version: task.version + 1 };
  }

  updated.decision = { decisionId, choice, status: decision.status, decidedAt: decision.decidedAt };
  const audit = {
    auditId: decisionId,
    caseId: task.taskId,
    eventType: "owner-decision",
    decisionId,
    choice,
    outcome: decision.status,
    actorId: actor.id,
    actorName: actor.name || null,
    occurredAt: decision.decidedAt
  };
  return { task: updated, decision, audit };
}

// Second-approver review of a delete request. Still records only; nothing is deleted.
export function reviewDecision(decision, task, { outcome, reason }, approver, now = new Date()) {
  if (!["archive", "delete"].includes(decision.choice)) throw new TaskRuleError("Only archive and delete requests need a second approver.", 400);
  if (decision.status !== "pending-approval") {
    throw new TaskRuleError(decision.status === "blocked" ? `Blocked: ${decision.blockers.join(" ")}` : "This request is not pending approval.");
  }
  if (approver.id === decision.decidedBy) throw new TaskRuleError("A second, different approver is required.", 403);
  if (!["approve", "reject"].includes(outcome)) throw new TaskRuleError("Outcome must be approve or reject.", 400);
  const reviewReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  if (outcome === "reject" && reviewReason.length < 5) throw new TaskRuleError("Give a reason when rejecting the lifecycle request.", 400);

  const approved = outcome === "approve";
  const status = approved ? "approved-not-executed" : "rejected";
  const reviewed = {
    ...decision,
    status,
    reviewedBy: approver.id,
    reviewedAt: iso(now),
    reviewReason: reviewReason || null
  };
  const updatedTask = {
    ...task,
    status: approved ? "decided" : "open",
    decision: { ...task.decision, status },
    nextReviewAt: approved ? addDays(now, task.cadenceDays) : task.nextReviewAt,
    version: task.version + 1
  };
  const audit = {
    auditId: `${decision.decisionId}-review`,
    caseId: task.taskId,
    eventType: "owner-decision-review",
    decisionId: decision.decisionId,
    outcome: status,
    actorId: approver.id,
    actorName: approver.name || null,
    occurredAt: reviewed.reviewedAt
  };
  return { task: updatedTask, decision: reviewed, audit };
}

export function escalationLevel(task, now = new Date()) {
  if (isClosed(task) || task.status === "pending-approval") return 0;
  const overdueDays = Math.floor((now - new Date(task.dueAt)) / DAY_MS);
  return ESCALATION_LADDER.filter((rung) => overdueDays >= rung.afterDays).at(-1)?.level || 0;
}

// Raises the escalation level and widens assignees. The default outcome is always
// "no-change": non-response never archives or deletes a workspace.
export function applyEscalation(task, workspace, now = new Date()) {
  const level = escalationLevel(task, now);
  if (level <= task.escalationLevel) return null;

  const assignees = new Set(task.assigneeIds);
  if (level >= 2) {
    for (const owner of workspace?.ownerDetails || []) if (owner.managerId) assignees.add(owner.managerId);
  }
  if (level >= 3) assignees.add(GOVERNANCE_QUEUE.id);

  const rung = ESCALATION_LADDER.find((item) => item.level === level);
  return {
    ...task,
    escalationLevel: level,
    assigneeIds: [...assignees],
    escalationHistory: [...task.escalationHistory, { level, action: rung.action, at: iso(now), notified: false }],
    version: task.version + 1
  };
}

export function taskSummary(task, now = new Date()) {
  const overdue = !isClosed(task) && new Date(task.dueAt) < now;
  return { ...task, overdue };
}
