// Owner-executed membership removal (Phase 2). An owner picks members to remove, previews the
// result, then confirms. Guardrails are enforced here, not in the page:
//   - only current members can be targeted; owners are never removed by this action
//   - the actor cannot remove themselves (use "I am not responsible")
//   - at most REMOVAL_LIMIT people per request
//   - every state is re-read from Microsoft Graph before and after, never assumed
//   - in dry-run mode (the default) nothing is changed and the record says so
// The graph client passed to executeAction must be the writable executor client; the
// proposal step only needs reads.

export const REMOVAL_LIMIT = 10;
const OBJECT_ID = /^[0-9a-fA-F-]{36}$/;
const iso = (date) => new Date(date).toISOString();

export class ExecutionRuleError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "ExecutionRuleError";
    this.status = status;
  }
}

export function classifyPermission(permission) {
  if (permission.inheritedFrom) return { kind: "inherited" };
  if ((permission.roles || []).includes("owner")) return { kind: "owner" };
  if (permission.link) return { kind: "link", scope: permission.link.scope || null, type: permission.link.type || null };
  const user = permission.grantedToV2?.user || permission.grantedTo?.user;
  if (user) return { kind: "direct-user", user };
  return { kind: "other" };
}

export async function listGroupPeople(graph, workspaceId) {
  const select = "$select=id,displayName,userType,userPrincipalName&$top=999";
  const [members, owners] = await Promise.all([
    graph.getAll(`/groups/${workspaceId}/members?${select}`),
    graph.getAll(`/groups/${workspaceId}/owners?${select}`)
  ]);
  const ownerIds = new Set(owners.map((owner) => owner.id));
  return {
    owners,
    members: members.filter((member) => !ownerIds.has(member.id)).map((member) => ({
      id: member.id,
      displayName: member.displayName || null,
      userPrincipalName: member.userPrincipalName || null,
      guest: member.userType === "Guest"
    }))
  };
}

export async function proposeMemberRemovals({ task, userIds, reason, actor, graph, now = new Date() }) {
  if (!Array.isArray(userIds) || !userIds.length) throw new ExecutionRuleError("Choose at least one person to remove.", 400);
  const unique = [...new Set(userIds)];
  if (unique.length > REMOVAL_LIMIT) throw new ExecutionRuleError(`Remove at most ${REMOVAL_LIMIT} people at a time.`, 400);
  if (unique.some((id) => typeof id !== "string" || !OBJECT_ID.test(id))) throw new ExecutionRuleError("A user id is not valid.", 400);
  if (["decided", "pending-approval"].includes(task.status)) throw new ExecutionRuleError("This task is already decided.");

  const { members } = await listGroupPeople(graph, task.workspaceId);
  const byId = new Map(members.map((member) => [member.id, member]));
  const actions = [];
  const rejected = [];

  for (const userId of unique) {
    if (userId === actor.id) { rejected.push({ userId, reason: "You cannot remove yourself. Use \"I am not responsible\"." }); continue; }
    const target = byId.get(userId);
    if (!target) { rejected.push({ userId, reason: "Not a current member, or an owner. Owners are not removed here." }); continue; }
    actions.push({
      actionId: `${task.taskId}-rm-${userId}`,
      caseId: task.taskId,
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceName,
      actionType: "remove-member",
      targetUserId: userId,
      targetDisplayName: target.displayName,
      targetUserType: target.guest ? "Guest" : "Member",
      reason: typeof reason === "string" ? reason.trim().slice(0, 500) || null : null,
      status: "proposed",
      requestedBy: actor.id,
      requestedByName: actor.name || null,
      requestedAt: iso(now)
    });
  }
  return { actions, rejected };
}

async function permissionPresent(graph, action) {
  try {
    const permissions = await graph.getAll(`/drives/${action.driveId}/items/${action.itemId}/permissions`);
    const found = permissions.find((permission) => permission.id === action.permissionId);
    // The permission may have changed since the proposal. Never revoke owner or inherited access.
    const kind = found ? classifyPermission(found) : null;
    if (found && !["link", "direct-user"].includes(kind.kind)) {
      throw new ExecutionRuleError("This permission is no longer a sharing link or a direct grant, so it was not revoked.");
    }
    if (found && kind.kind === "direct-user" && action.targetUserId && kind.user.id !== action.targetUserId) {
      throw new ExecutionRuleError("The direct grant now belongs to a different person, so it was not revoked.");
    }
    if (found && kind.kind === "link" && action.linkScope && kind.scope !== action.linkScope) {
      throw new ExecutionRuleError("The sharing link scope changed since preview, so it was not revoked.");
    }
    if (found && action.ownerUserId && kind.kind === "direct-user" && kind.user.id === action.ownerUserId) {
      throw new ExecutionRuleError("The OneDrive owner's access is never revoked by this review.");
    }
    return Boolean(found);
  } catch (error) {
    if (error?.status === 404) return false;
    throw error;
  }
}

// Each action type says how to check the target and how to remove it. Everything else
// (dry run, re-reading after, verification, audit) is shared.
const HANDLERS = {
  "remove-member": {
    method: "group-members-read",
    present: async (graph, action) => (await listGroupPeople(graph, action.workspaceId)).members.some((member) => member.id === action.targetUserId),
    remove: (graph, action) => graph.remove(`/groups/${action.workspaceId}/members/${action.targetUserId}/$ref`)
  },
  "revoke-permission": {
    method: "item-permissions-read",
    present: permissionPresent,
    remove: (graph, action) => graph.remove(`/drives/${action.driveId}/items/${action.itemId}/permissions/${action.permissionId}`)
  }
};

export async function executeAction({ action, actor, graph, mode, now = new Date() }) {
  const handler = HANDLERS[action.actionType];
  if (!handler) throw new ExecutionRuleError("Unsupported action type.", 400);
  if (!["proposed", "failed", "simulated"].includes(action.status)) throw new ExecutionRuleError(`This action is already ${action.status}.`);
  if (mode === "live" && typeof graph.remove !== "function") throw new ExecutionRuleError("Live execution needs the executor identity.");
  if (action.actionType === "revoke-permission" && action.targetUserId && actor.id === action.targetUserId) {
    throw new ExecutionRuleError("You cannot revoke your own access.", 403);
  }

  const record = { ...action, confirmedBy: actor.id, confirmedByName: actor.name || null, confirmedAt: iso(now), executionMode: mode };
  const present = () => handler.present(graph, action);

  let result;
  let detail = null;
  try {
    if (!(await present())) {
      record.status = "verified";
      result = "already-absent";
    } else if (mode !== "live") {
      record.status = "simulated";
      record.executionStatus = "not-executed";
      result = "dry-run";
    } else {
      await handler.remove(graph, action);
      if (await present()) {
        record.status = "failed";
        result = "still-present";
        detail = "The target was still present after removal.";
      } else {
        record.status = "verified";
        record.executionStatus = "executed";
        result = "absent";
      }
    }
  } catch (error) {
    record.status = "failed";
    result = "error";
    detail = error instanceof ExecutionRuleError ? error.message : `Graph returned ${error.status || "an error"}.`;
  }
  record.completedAt = iso(now);
  record.resultDetail = detail;

  const verification = {
    verificationId: `${action.actionId}-v${Date.parse(now) || Date.now()}`,
    caseId: action.caseId,
    actionId: action.actionId,
    checkedAt: record.completedAt,
    result,
    method: handler.method
  };
  const audit = {
    auditId: `${action.actionId}-exec-${Date.parse(now) || Date.now()}`,
    caseId: action.caseId,
    eventType: "action-executed",
    actionId: action.actionId,
    actionType: action.actionType,
    targetUserId: action.targetUserId || null,
    permissionId: action.permissionId || null,
    mode,
    outcome: record.status,
    actorId: actor.id,
    actorName: actor.name || null,
    occurredAt: record.completedAt
  };
  return { action: record, verification, audit };
}
