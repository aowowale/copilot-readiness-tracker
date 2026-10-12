import { buildMoverTask, moverTaskId } from "./movers.js";

// Creates one access-review task per role change. Team memberships are read live from Microsoft
// Graph; if that read fails (for example the feed uses test identifiers), the entitlements in
// the feed are used instead and the task says so. Existing reviews are never recreated.

async function graphMemberships(graph, roleChange, workspaces) {
  const groups = await graph.getAll(`/users/${encodeURIComponent(roleChange.userId)}/memberOf/microsoft.graph.group?$select=id,displayName,resourceProvisioningOptions&$top=999`);
  const ownedBy = new Map(workspaces.map((workspace) => [workspace.id, (workspace.ownerDetails || []).some((owner) => owner.id === roleChange.userId)]));
  return groups
    .filter((group) => (group.resourceProvisioningOptions || []).includes("Team"))
    .map((group) => ({ workspaceId: group.id, workspaceName: group.displayName, access: ownedBy.get(group.id) ? "owner" : "member" }));
}

export async function syncMoverTasks({ roleChanges, workspaces, graph, repository, now = new Date() }) {
  const existing = new Set((await repository.readTasksWithEtag()).map((entry) => entry.record.taskId));
  let created = 0;
  let fromGraph = 0;
  let fromFeed = 0;

  for (const roleChange of roleChanges) {
    if (existing.has(moverTaskId(roleChange.caseId))) continue;

    let memberships;
    let itemsSource = "graph";
    try {
      memberships = await graphMemberships(graph, roleChange, workspaces);
    } catch {
      memberships = (roleChange.currentEntitlements || []).map((entitlement) => ({ workspaceId: entitlement.resourceId, workspaceName: entitlement.resourceName, access: "member" }));
      itemsSource = "hr-feed";
    }
    if (!memberships.length) continue;

    const managerId = roleChange.after?.managerId || roleChange.before?.managerId || null;
    let managerContact = null;
    if (managerId) {
      try {
        const manager = await graph.get(`/users/${encodeURIComponent(managerId)}?$select=id,displayName,mail,userPrincipalName`);
        managerContact = { id: manager.id, name: manager.displayName || null, mail: manager.mail || manager.userPrincipalName || null };
      } catch { /* the manager may not exist in this directory; notifications are then skipped */ }
    }

    if (await repository.createTaskIfAbsent(buildMoverTask({ roleChange, memberships, itemsSource, managerContact, now }))) {
      created += 1;
      if (itemsSource === "graph") fromGraph += 1; else fromFeed += 1;
    }
  }
  return { created, fromGraph, fromFeed, total: roleChanges.length };
}
