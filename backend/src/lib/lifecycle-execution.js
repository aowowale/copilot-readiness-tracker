import { deleteGate, TaskRuleError } from "./owner-tasks.js";

const iso = (value) => new Date(value).toISOString();
const freshEvidence = (workspace, now, maxAgeHours) => {
  const generatedAt = workspace?.evidence?.generatedAt;
  if (!generatedAt) return false;
  const age = new Date(now).getTime() - new Date(generatedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeHours * 3_600_000;
};

export function lifecycleConfirmation(choice, workspaceName) {
  if (!new Set(["archive", "delete"]).has(choice)) throw new TaskRuleError("Unsupported lifecycle decision.", 400);
  return `${choice.toUpperCase()} ${workspaceName}`;
}

export async function executeLifecycleDecision({
  decision,
  workspace,
  actor,
  graph,
  mode,
  lifecycleEnabled,
  maxEvidenceAgeHours = 72,
  confirmation,
  now = new Date()
}) {
  if (!decision || !["archive", "delete"].includes(decision.choice)) throw new TaskRuleError("Only approved archive or delete decisions can be executed.", 400);
  if (decision.status !== "approved-not-executed" || !["not-executed", "simulated"].includes(decision.executionStatus || "not-executed")) throw new TaskRuleError("This decision is not approved and awaiting execution.");
  if (decision.requiresSecondApprover !== true || !decision.reviewedBy || decision.reviewedBy === decision.decidedBy) throw new TaskRuleError("An independent second-approver record is required before execution.", 403);
  if (!workspace?.id || workspace.id !== decision.workspaceId) throw new TaskRuleError("The current workspace could not be verified.");
  if (decision.decidedBy === actor.id) throw new TaskRuleError("The requester cannot execute their own lifecycle decision.", 403);
  if (decision.reviewedBy === actor.id) throw new TaskRuleError("The second Approver cannot also execute the lifecycle decision.", 403);

  const expected = lifecycleConfirmation(decision.choice, workspace.name || decision.workspaceName || workspace.id);
  if (typeof confirmation !== "string" || confirmation.trim() !== expected) throw new TaskRuleError(`Type exactly: ${expected}`, 400);
  if (mode === "live" && !lifecycleEnabled) throw new TaskRuleError("Live archive/delete execution is not explicitly enabled by the tenant administrator.", 403);
  if (mode === "live" && typeof graph?.remove !== "function") throw new TaskRuleError("Live lifecycle execution needs the separate executor identity.", 403);

  if (!freshEvidence(workspace, now, maxEvidenceAgeHours)) {
    throw new TaskRuleError(`${decision.choice === "delete" ? "Deletion" : "Archiving"} is blocked: legal-hold evidence is missing or stale. Refresh the evidence feed and request a new decision.`, 409);
  }
  if (workspace.legalHold !== false) {
    throw new TaskRuleError(workspace.legalHold === true ? "This action is blocked while a legal hold is applied." : "This action is blocked because legal-hold status is unknown.", 409);
  }
  if (decision.choice === "delete") {
    const gate = deleteGate(workspace);
    if (!gate.allowed) throw new TaskRuleError(`Deletion is blocked: ${gate.reasons.join(" ")}`, 409);
  }
  if (decision.choice === "archive" && workspace.type === "Archived team") throw new TaskRuleError("This Team is already archived.", 409);
  if (mode === "live" && decision.choice === "archive" && typeof graph?.post !== "function") throw new TaskRuleError("Archiving needs the writable executor client.", 403);

  const executedAt = iso(now);
  if (mode !== "live") {
    return {
      decision: { ...decision, executionStatus: "simulated", executionMode: "dry-run", executedAt, executionActorId: actor.id, executionActorName: actor.name || null },
      verification: { verificationId: `${decision.decisionId}-lifecycle-${Date.parse(now) || Date.now()}`, caseId: decision.taskId, decisionId: decision.decisionId, checkedAt: executedAt, result: "dry-run", method: "lifecycle-state-read" },
      audit: { auditId: `${decision.decisionId}-lifecycle-${Date.parse(now) || Date.now()}`, caseId: decision.taskId, eventType: "lifecycle-action-simulated", choice: decision.choice, outcome: "simulated", actorId: actor.id, actorName: actor.name || null, occurredAt: executedAt },
      verifiedWorkspace: null
    };
  }

  let result;
  if (decision.choice === "archive") {
    let operationUrl = null;
    if (typeof graph.postWithResponse === "function") {
      const response = await graph.postWithResponse(`/teams/${workspace.id}/archive`);
      operationUrl = response.headers.location || response.headers.Location || null;
    } else {
      await graph.post(`/teams/${workspace.id}/archive`, {});
    }
    if (operationUrl) {
      let operationStatus = "inProgress";
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const operation = await graph.get(operationUrl);
        operationStatus = operation.status;
        if (operationStatus === "succeeded") break;
        if (operationStatus === "failed") throw new TaskRuleError("Microsoft Graph reported that Team archival failed.", 502);
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
      if (operationStatus !== "succeeded") throw new TaskRuleError("Team archival is still in progress. Check Teams before any retry.", 502);
    }
    let confirmationState = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        confirmationState = await graph.get(`/teams/${workspace.id}?$select=id,isArchived`);
        if (confirmationState.isArchived === true) break;
      } catch { /* allow Teams service replication delay */ }
      if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (confirmationState?.isArchived !== true) throw new TaskRuleError("Archive was requested, but Microsoft Graph did not confirm the Team is archived. Check the Team before retrying.", 502);
    result = "archived-and-verified";
  } else {
    await graph.remove(`/groups/${workspace.id}`);
    try {
      await graph.get(`/groups/${workspace.id}?$select=id`);
      throw new TaskRuleError("The group still exists after the deletion request.", 502);
    } catch (error) {
      if (error instanceof TaskRuleError) throw error;
      if (error?.status !== 404) throw error;
    }
    result = "soft-deleted-and-verified";
  }

  const updatedDecision = {
    ...decision,
    executionStatus: "executed-and-verified",
    executionMode: "live",
    executedAt,
    executionActorId: actor.id,
    executionActorName: actor.name || null,
    executionResult: result
  };
  const verification = {
    verificationId: `${decision.decisionId}-lifecycle-${Date.parse(now) || Date.now()}`,
    caseId: decision.taskId,
    decisionId: decision.decisionId,
    checkedAt: executedAt,
    result,
    method: decision.choice === "archive" ? "teams-isArchived-read" : "group-404-after-soft-delete"
  };
  const audit = {
    auditId: `${decision.decisionId}-lifecycle-${Date.parse(now) || Date.now()}`,
    caseId: decision.taskId,
    eventType: "lifecycle-action-executed",
    choice: decision.choice,
    outcome: updatedDecision.executionStatus,
    executionResult: result,
    actorId: actor.id,
    actorName: actor.name || null,
    occurredAt: executedAt
  };
  return { decision: updatedDecision, verification, audit, verifiedWorkspace: decision.choice === "archive" ? { ...workspace, type: "Archived team" } : null };
}
