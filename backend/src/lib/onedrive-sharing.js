import { createHash } from "node:crypto";
import { classifyPermission, ExecutionRuleError, REMOVAL_LIMIT } from "./execution.js";

const MAX_ITEMS = 100;
const MAX_DEPTH = 3;
const SAFE_ID = /^[A-Za-z0-9!_.=-]{1,200}$/;
const safe = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

export const oneDriveReviewId = (siteKey) => `onedrive-${safe(siteKey)}`;

async function oneDriveOwner(graph, ownerUpn) {
  let user;
  try {
    user = await graph.get(`/users/${encodeURIComponent(ownerUpn)}?$select=id,displayName,userPrincipalName,userType,accountEnabled`);
  } catch (error) {
    throw new ExecutionRuleError(error?.status === 404 ? "The OneDrive owner could not be resolved in Microsoft Graph." : "The OneDrive owner could not be checked.", 409);
  }
  if (!user?.id || user.userType === "Guest" || user.accountEnabled === false) throw new ExecutionRuleError("The OneDrive owner is not an enabled internal user.", 409);
  return user;
}

async function readPage(graph, path) {
  return graph.get(path);
}

export async function scanOneDriveSharing({ graph, site, maxItems = MAX_ITEMS, maxDepth = MAX_DEPTH }) {
  const owner = await oneDriveOwner(graph, site.ownerUpn);
  const drive = await graph.get(`/users/${encodeURIComponent(owner.id)}/drive?$select=id,driveType,webUrl`);
  if (!drive?.id || !["business", "personal"].includes(drive.driveType)) throw new ExecutionRuleError("This user does not have a provisioned personal OneDrive drive.", 404);

  const queue = [{ path: `/drives/${encodeURIComponent(drive.id)}/root/children?$top=100`, depth: 0 }];
  const items = [];
  let truncated = false;
  while (queue.length && items.length < maxItems) {
    const node = queue.shift();
    let next = node.path;
    do {
      const page = await readPage(graph, next);
      for (const item of page.value || []) {
        if (items.length >= maxItems) { truncated = true; break; }
        items.push(item);
        if (item.folder && node.depth < maxDepth) queue.push({ path: `/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(item.id)}/children?$top=100`, depth: node.depth + 1 });
        else if (item.folder) truncated = true;
      }
      if (truncated || items.length >= maxItems) { if (page["@odata.nextLink"] || queue.length) truncated = true; break; }
      next = page["@odata.nextLink"] || null;
    } while (next);
  }
  if (queue.length) truncated = true;

  const findings = [];
  for (const item of items) {
    let permissions;
    try {
      permissions = await graph.getAll(`/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(item.id)}/permissions`);
    } catch (error) {
      if (error?.status === 404) continue;
      throw error;
    }
    for (const permission of permissions) {
      const kind = classifyPermission(permission);
      if (kind.kind === "link") {
        findings.push({ itemId: item.id, itemName: item.name, permissionId: permission.id, kind: "link", scope: kind.scope, type: kind.type, roles: permission.roles || [] });
      } else if (kind.kind === "direct-user") {
        if (kind.user.id === owner.id) continue;
        findings.push({ itemId: item.id, itemName: item.name, permissionId: permission.id, kind: "direct-user", grantedTo: kind.user.displayName || kind.user.email || kind.user.id, targetUserId: kind.user.id, roles: permission.roles || [] });
      }
      if (findings.length >= 500) { truncated = true; break; }
    }
    if (findings.length >= 500) break;
  }
  return { driveId: drive.id, ownerId: owner.id, ownerName: owner.displayName || site.title, scannedItems: items.length, truncated, findings };
}

export async function proposeOneDriveRevocations({ site, scan, targets, actor, reason, now = new Date() }) {
  if (!Array.isArray(targets) || !targets.length) throw new ExecutionRuleError("Select at least one sharing link or direct grant.", 400);
  const unique = [...new Map(targets.map((target) => [`${target?.itemId}|${target?.permissionId}`, target])).values()];
  if (unique.length > REMOVAL_LIMIT) throw new ExecutionRuleError(`Revoke at most ${REMOVAL_LIMIT} permissions at a time.`, 400);
  if (unique.some(target => !SAFE_ID.test(String(target?.itemId)) || !SAFE_ID.test(String(target?.permissionId)))) throw new ExecutionRuleError("An item or permission id is invalid.", 400);
  const reviewId = oneDriveReviewId(site.siteKey);
  const actions = [];
  const rejected = [];
  for (const target of unique) {
    const finding = scan.findings.find(item => item.itemId === target.itemId && item.permissionId === target.permissionId);
    if (!finding) { rejected.push({ ...target, reason: "The permission was not present in the latest bounded scan." }); continue; }
    if (finding.kind === "direct-user" && finding.targetUserId === actor.id) { rejected.push({ ...target, reason: "You cannot revoke your own access." }); continue; }
    const actionId = `${reviewId}-perm-${safe(`${target.itemId}:${target.permissionId}`)}`;
    actions.push({
      actionId,
      caseId: reviewId,
      taskId: reviewId,
      workspaceId: site.siteKey,
      workspaceName: site.title || site.ownerUpn,
      actionType: "revoke-permission",
      permissionKind: finding.kind,
      driveId: scan.driveId,
      itemId: target.itemId,
      itemName: finding.itemName || null,
      permissionId: target.permissionId,
      linkScope: finding.scope || null,
      targetUserId: finding.targetUserId || null,
      ownerUserId: scan.ownerId,
      targetDisplayName: finding.kind === "link" ? `${finding.scope || "Sharing"} link on ${finding.itemName || "an item"}` : `${finding.grantedTo} on ${finding.itemName || "an item"}`,
      reason: typeof reason === "string" ? reason.trim().slice(0, 500) || "Owner OneDrive sharing review" : "Owner OneDrive sharing review",
      origin: "onedrive-review",
      status: "proposed",
      requestedBy: actor.id,
      requestedByName: actor.name || null,
      requestedAt: new Date(now).toISOString()
    });
  }
  return { actions, rejected };
}
