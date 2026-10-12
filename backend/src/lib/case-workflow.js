const TERMINAL_STATES = new Set(["closed", "cancelled"]);

const TRANSITIONS = {
  triage: { from: ["detected", "proposed"], to: "triaged" },
  assign: { from: ["triaged"], to: "assigned" },
  "request-owner": { from: ["assigned"], to: "awaiting-owner" },
  "request-approval": { from: ["awaiting-owner"], to: "awaiting-approval" },
  approve: { from: ["awaiting-approval"], to: "approved" },
  reject: { from: ["awaiting-approval"], to: "assigned" },
  execute: { from: ["approved"], to: "executing" },
  verify: { from: ["executing"], to: "verifying" },
  close: { from: ["verifying"], to: "closed" },
  fail: { from: ["executing", "verifying"], to: "failed" },
  retry: { from: ["failed"], to: "approved" },
  "grant-exception": { from: ["triaged", "assigned", "awaiting-owner", "awaiting-approval"], to: "exception" },
  "expire-exception": { from: ["exception"], to: "triaged" },
  cancel: { from: ["detected", "proposed", "triaged", "assigned", "awaiting-owner", "awaiting-approval", "approved", "failed", "exception"], to: "cancelled" }
};

const TRANSITION_ROLES = {
  triage: ["Governance.Operator"],
  assign: ["Governance.Operator"],
  "request-owner": ["Governance.Operator"],
  "request-approval": ["Governance.Operator"],
  approve: ["Approver"],
  reject: ["Approver"],
  execute: ["Executor"],
  verify: ["Executor"],
  close: ["Executor"],
  fail: ["Executor"],
  retry: ["Executor"],
  "grant-exception": ["Approver"],
  "expire-exception": ["Governance.Operator"],
  cancel: ["Governance.Operator"]
};

export function availableTransitions(status) {
  return Object.entries(TRANSITIONS)
    .filter(([, transition]) => transition.from.includes(status))
    .map(([name]) => name);
}

export function transitionCase(record, transitionName, actor, options = {}) {
  if (!record?.caseId) throw new Error("A caseId is required.");
  if (!actor?.id) throw new Error("An authenticated actor is required.");

  const transition = TRANSITIONS[transitionName];
  if (!transition) throw new Error(`Unknown case transition: ${transitionName}`);

  const currentStatus = record.status || "detected";
  if (TERMINAL_STATES.has(currentStatus) || !transition.from.includes(currentStatus)) {
    throw new Error(`Transition ${transitionName} is not allowed from ${currentStatus}.`);
  }

  const occurredAt = options.occurredAt || new Date().toISOString();
  const updated = {
    ...record,
    status: transition.to,
    updatedAt: occurredAt,
    updatedBy: actor.id,
    version: (Number(record.version) || 0) + 1
  };

  const audit = {
    auditId: options.auditId || `${record.caseId}-${updated.version}`,
    caseId: record.caseId,
    eventType: "case-transition",
    transition: transitionName,
    fromStatus: currentStatus,
    toStatus: transition.to,
    actorId: actor.id,
    actorName: actor.name || null,
    occurredAt,
    reason: options.reason || null,
    correlationId: options.correlationId || null,
    policyVersion: record.policyVersion || null
  };

  return { record: updated, audit };
}

export function rolesForTransition(transitionName) {
  return TRANSITION_ROLES[transitionName] || [];
}