// Maps read-only Microsoft Graph data to the dashboard workspace schema used by
// index.html. Fields that require sources not yet wired (Team activity in GCC High,
// SharePoint exposure, RCD) are returned as Unknown/false, never fabricated.

import { findShadowUsers } from "./shadow-users.js";

const GROUP_SELECT = "id,displayName,visibility,mailNickname,createdDateTime,renewedDateTime,expirationDateTime,assignedLabels";
const MAX_MANAGER_LOOKUPS = 5;
const MAX_GUEST_DETAILS = 25;

// A missing manager (404) is normal; any other failure is reported once per run.
async function lookupManager(graph, ownerId, failures) {
  try {
    const manager = await graph.get(`/users/${ownerId}/manager?$select=id,displayName,mail,userPrincipalName`);
    return manager?.id ? { managerId: manager.id, managerName: manager.displayName || null, managerMail: manager.mail || manager.userPrincipalName || null } : {};
  } catch (error) {
    if (error?.status !== 404) failures.push(error?.status || error?.message);
    return {};
  }
}

function teamType(group, team) {
  if (team?.isArchived) return "Archived team";
  const visibility = group?.visibility;
  if (visibility === "Public") return "Public team";
  if (visibility === "Private") return "Private team";
  return "Team";
}

export async function collectWorkspaces(graph, config, log) {
  const warnings = [];
  const workspaces = [];
  const managerFailures = [];

  // Determine scope: an explicit PILOT_TEAM_IDS subset, or the entire tenant.
  let groups;
  if (config.pilotTeamIds.length) {
    groups = [];
    for (const teamId of config.pilotTeamIds) {
      try {
        groups.push(await graph.get(`/groups/${teamId}?$select=${GROUP_SELECT}`));
      } catch (error) {
        warnings.push(`Team ${teamId} could not be read: ${error.status || error.message}`);
      }
    }
  } else {
    const teamsFilter = encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')");
    groups = await graph
      .getAll(`/groups?$filter=${teamsFilter}&$select=${GROUP_SELECT}&$top=999`)
      .catch((error) => {
        warnings.push(`Tenant group enumeration failed: ${error.status || error.message}`);
        return [];
      });
  }

  if (!groups.length) {
    warnings.push("No Teams-enabled groups were found for the configured scope.");
    return { workspaces, warnings };
  }

  if (config.maxWorkspaces && groups.length > config.maxWorkspaces) {
    warnings.push(
      `Found ${groups.length} Teams; collecting the first ${config.maxWorkspaces} (MAX_WORKSPACES). Raise or unset MAX_WORKSPACES to collect all.`
    );
    groups = groups.slice(0, config.maxWorkspaces);
  }

  for (const group of groups) {
    const teamId = group.id;
    try {
      const team = await graph.get(`/teams/${teamId}`).catch(() => null);
      const owners = await graph
        .getAll(`/groups/${teamId}/owners?$select=id,displayName,mail,userPrincipalName&$top=100`)
        .catch((error) => {
          warnings.push(`Owners for Team ${teamId} could not be read: ${error.status || error.message}`);
          return null;
        });
      const members = await graph
        .getAll(`/groups/${teamId}/members?$select=id,userType,displayName,mail,createdDateTime&$top=999`)
        .catch(() => []);
      const channels = await graph.getAll(`/teams/${teamId}/channels?$select=id,displayName`).catch(() => []);

      const guestCount = members.filter((m) => m.userType === "Guest").length;
      const memberCount = members.length - guestCount;
      // Capped so a workspace record stays well under the table property size limit.
      const guestUsers = members.filter((m) => m.userType === "Guest").slice(0, MAX_GUEST_DETAILS).map((m) => ({
        id: m.id,
        displayName: m.displayName || null,
        mail: m.mail || null,
        createdAt: m.createdDateTime || null
      }));

      let ownerDetails = null;
      if (owners) {
        ownerDetails = [];
        for (const [index, owner] of owners.entries()) {
          const manager = config.resolveOwnerManagers !== false && index < MAX_MANAGER_LOOKUPS
            ? await lookupManager(graph, owner.id, managerFailures)
            : {};
          ownerDetails.push({ id: owner.id, displayName: owner.displayName || null, mail: owner.mail || owner.userPrincipalName || null, ...manager });
        }
      }

      const sitePrincipals = config.sitePrincipals?.[teamId];
      const memberIds = new Set([...members.map((m) => m.id), ...(owners || []).map((o) => o.id)]);

      workspaces.push({
        id: teamId,
        name: group.displayName || teamId,
        type: teamType(group, team),
        // Activity report API is unavailable in GCC High; keep as Unknown.
        activityDays: null,
        activeChannels: null,
        channelCount: channels.length,
        owners: owners?.map((o) => o.displayName).filter(Boolean) ?? null,
        ownerDetails,
        members: memberCount,
        guests: guestCount,
        guestUsers,
        createdAt: group.createdDateTime || null,
        renewedAt: group.renewedDateTime || null,
        expiresAt: group.expirationDateTime || null,
        // null = labels not returned; [] = returned and unlabeled.
        labels: Array.isArray(group.assignedLabels) ? group.assignedLabels.map((l) => l.displayName).filter(Boolean) : null,
        // null = no site-permission source for this workspace.
        shadowUsers: findShadowUsers(sitePrincipals, memberIds),
        highRiskObjects: null,
        // Hold and retention sources are not wired; delete stays blocked while null.
        legalHold: null,
        retentionLocked: null,
        // SharePoint exposure collector not yet wired.
        exposure: "Unknown",
        exposureCount: 0,
        // RCD collector not yet wired.
        rcd: false,
        lifecycle: team?.isArchived ? "Archived" : "Review",
        site: group.mailNickname ? `/sites/${group.mailNickname}` : "",
        findings: owners === null ? ["Owner data is unavailable"] : owners.length ? [] : ["No active owner is assigned"]
      });
    } catch (error) {
      log?.error?.(`Failed to collect team ${teamId}: ${error.message}`);
      warnings.push(`Team ${teamId} could not be collected: ${error.status || error.message}`);
    }
  }

  if (managerFailures.length) {
    warnings.push(`Manager lookup failed for ${managerFailures.length} owner(s) (first error: ${managerFailures[0]}). Reassignment falls back to the governance queue.`);
  }

  return { workspaces, warnings };
}