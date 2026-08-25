// Maps read-only Microsoft Graph data to the dashboard workspace schema used by
// index.html. Fields that require sources not yet wired (Team activity in GCC High,
// SharePoint exposure, RCD) are returned as Unknown/false, never fabricated.

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

  // Determine scope: an explicit PILOT_TEAM_IDS subset, or the entire tenant.
  let groups;
  if (config.pilotTeamIds.length) {
    groups = [];
    for (const teamId of config.pilotTeamIds) {
      try {
        groups.push(await graph.get(`/groups/${teamId}?$select=id,displayName,visibility,mailNickname`));
      } catch (error) {
        warnings.push(`Team ${teamId} could not be read: ${error.status || error.message}`);
      }
    }
  } else {
    const teamsFilter = encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')");
    groups = await graph
      .getAll(`/groups?$filter=${teamsFilter}&$select=id,displayName,visibility,mailNickname&$top=999`)
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
        .getAll(`/groups/${teamId}/owners?$select=displayName&$top=100`)
        .catch(() => []);
      const members = await graph
        .getAll(`/groups/${teamId}/members?$select=id,userType&$top=999`)
        .catch(() => []);
      const channels = await graph.getAll(`/teams/${teamId}/channels?$select=id,displayName`).catch(() => []);

      const guestCount = members.filter((m) => m.userType === "Guest").length;
      const memberCount = members.length - guestCount;

      workspaces.push({
        id: teamId,
        name: group.displayName || teamId,
        type: teamType(group, team),
        // Activity report API is unavailable in GCC High; keep as Unknown.
        activityDays: null,
        activeChannels: null,
        channelCount: channels.length,
        owners: owners.map((o) => o.displayName).filter(Boolean),
        members: memberCount,
        guests: guestCount,
        // SharePoint exposure collector not yet wired.
        exposure: "Unknown",
        exposureCount: 0,
        // RCD collector not yet wired.
        rcd: false,
        lifecycle: team?.isArchived ? "Archived" : "Review",
        site: group.mailNickname ? `/sites/${group.mailNickname}` : "",
        findings: owners.length ? [] : ["No active owner is assigned"]
      });
    } catch (error) {
      log?.error?.(`Failed to collect team ${teamId}: ${error.message}`);
      warnings.push(`Team ${teamId} could not be collected: ${error.status || error.message}`);
    }
  }

  return { workspaces, warnings };
}
