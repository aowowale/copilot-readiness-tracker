// Sharing review and revocation for a workspace's document library (Phase 2). The owner sees
// anonymous and organisation links and direct grants to people who are not in the team (shadow
// access), picks some, previews and confirms. Guardrails are enforced here:
//   - the drive is always the workspace's own library, looked up on the server, never taken from
//     the request, so a target cannot point at another workspace's files
//   - only sharing links and direct grants to non-members can be revoked; owner access,
//     inherited permissions, group grants and team members are never touched
//   - the actor's own access is never revoked
//   - the permission is re-read before a proposal is built, and again before and after execution

import { classifyPermission, ExecutionRuleError, listGroupPeople, REMOVAL_LIMIT } from "./execution.js";

const MAX_ITEMS = 100;
const MAX_DEPTH = 3;
const ID = /^[A-Za-z0-9!_.=-]{1,200}$/;
const iso = (date) => new Date(date).toISOString();

export async function groupDriveId(graph, workspaceId) {
  const drive = await graph.get(`/groups/${workspaceId}/drive?$select=id`);
  if (!drive?.id) throw new ExecutionRuleError("This workspace has no document library.");
  return drive.id;
}

async function memberIdSet(graph, workspaceId) {
  const { members, owners } = await listGroupPeople(graph, workspaceId);
  return new Set([...members.map((member) => member.id), ...owners.map((owner) => owner.id)]);
}

export async function scanSharing({ graph, workspaceId, maxItems = MAX_ITEMS, maxDepth = MAX_DEPTH }) {
  const driveId = await groupDriveId(graph, workspaceId);
  const memberIds = await memberIdSet(graph, workspaceId);

  const items = [];
  const queue = [{ path: "root", depth: 0 }];
  let truncated = false;
  while (queue.length && !truncated) {
    const { path, depth } = queue.shift();
    const children = await graph.getAll(`/drives/${driveId}/${path}/children?$select=id,name,folder,webUrl&$top=200`);
    for (const child of children) {
      if (items.length >= maxItems) { truncated = true; break; }
      items.push(child);
      if (child.folder) {
        if (depth < maxDepth) queue.push({ path: `items/${child.id}`, depth: depth + 1 });
        else truncated = true;
      }
    }
  }

  const findings = [];
  for (const item of items) {
    let permissions;
    try {
      permissions = await graph.getAll(`/drives/${driveId}/items/${item.id}/permissions`);
    } catch (error) {
      if (error?.status === 404) continue; // deleted since it was listed
      throw error;
    }
    for (const permission of permissions) {
      const kind = classifyPermission(permission);
      if (kind.kind === "link") {
        findings.push({ itemId: item.id, itemName: item.name, webUrl: item.webUrl || null, permissionId: permission.id, kind: "link", scope: kind.scope, type: kind.type, roles: permission.roles || [] });
      } else if (kind.kind === "direct-user" && kind.user.id && !memberIds.has(kind.user.id)) {
        findings.push({ itemId: item.id, itemName: item.name, webUrl: item.webUrl || null, permissionId: permission.id, kind: "direct-user", grantedTo: kind.user.displayName || kind.user.email || kind.user.id, userId: kind.user.id, roles: permission.roles || [] });
      }
    }
  }
  return { driveId, scannedItems: items.length, truncated, findings };
}

export async function proposePermissionRevocations({ task, targets, reason, actor, graph, now = new Date() }) {
  if (!Array.isArray(targets) || !targets.length) throw new ExecutionRuleError("Choose at least one link or grant to revoke.", 400);
  if (targets.length > REMOVAL_LIMIT) throw new ExecutionRuleError(`Revoke at most ${REMOVAL_LIMIT} at a time.`, 400);
  if (targets.some((target) => !ID.test(String(target?.itemId)) || !ID.test(String(target?.permissionId)))) throw new ExecutionRuleError("An item or permission id is not valid.", 400);
  if (["decided", "pending-approval"].includes(task.status)) throw new ExecutionRuleError("This task is already decided.");

  const driveId = await groupDriveId(graph, task.workspaceId);
  const memberIds = await memberIdSet(graph, task.workspaceId);
  const actions = [];
  const rejected = [];
  const seen = new Set();

  for (const target of targets) {
    const key = `${target.itemId}/${target.permissionId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let permissions;
    try {
      permissions = await graph.getAll(`/drives/${driveId}/items/${target.itemId}/permissions`);
    } catch (error) {
      if (error?.status === 404) { rejected.push({ ...target, reason: "That item no longer exists." }); continue; }
      throw error;
    }
    const permission = permissions.find((item) => item.id === target.permissionId);
    if (!permission) { rejected.push({ ...target, reason: "That permission no longer exists." }); continue; }

    const kind = classifyPermission(permission);
    if (kind.kind === "inherited") { rejected.push({ ...target, reason: "Inherited from a parent. Change it where it is set." }); continue; }
    if (kind.kind === "owner") { rejected.push({ ...target, reason: "Owner access is never revoked here." }); continue; }
    if (kind.kind === "other") { rejected.push({ ...target, reason: "Only sharing links and direct grants to non-members can be revoked." }); continue; }
    if (kind.kind === "direct-user") {
      if (kind.user.id === actor.id) { rejected.push({ ...target, reason: "You cannot revoke your own access." }); continue; }
      if (memberIds.has(kind.user.id)) { rejected.push({ ...target, reason: "This person is a team member. Remove them from the team instead." }); continue; }
    }

    const item = await graph.get(`/drives/${driveId}/items/${target.itemId}?$select=id,name`).catch(() => null);
    actions.push({
      actionId: `${task.taskId}-perm-${String(target.permissionId).replace(/[^A-Za-z0-9._-]/g, "-")}`.slice(0, 200),
      caseId: task.taskId,
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceName,
      actionType: "revoke-permission",
      permissionKind: kind.kind,
      driveId,
      itemId: target.itemId,
      itemName: item?.name || null,
      permissionId: target.permissionId,
      linkScope: kind.kind === "link" ? kind.scope : null,
      targetUserId: kind.kind === "direct-user" ? kind.user.id : null,
      targetDisplayName: kind.kind === "link" ? `${kind.scope || "Sharing"} link on ${item?.name || "an item"}` : `${kind.user.displayName || kind.user.id} on ${item?.name || "an item"}`,
      reason: typeof reason === "string" ? reason.trim().slice(0, 500) || null : null,
      status: "proposed",
      requestedBy: actor.id,
      requestedByName: actor.name || null,
      requestedAt: iso(now)
    });
  }
  return { actions, rejected };
}
