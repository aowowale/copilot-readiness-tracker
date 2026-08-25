// Central configuration. Every value comes from environment settings so the same
// code runs against GCC High or commercial without edits.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

export function getConfig() {
  return {
    graphBaseUrl: (process.env.GRAPH_BASE_URL || "https://graph.microsoft.us/v1.0").replace(/\/+$/, ""),
    graphScope: process.env.GRAPH_SCOPE || "https://graph.microsoft.us/.default",
    tenantId: required("GRAPH_TENANT_ID"),
    collectorClientId: process.env.COLLECTOR_CLIENT_ID || undefined,
    pilotTeamIds: (process.env.PILOT_TEAM_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    // Safety cap for full-tenant enumeration. 0 = no cap.
    maxWorkspaces: Number.parseInt(process.env.MAX_WORKSPACES || "0", 10) || 0,
    storageTableEndpoint: required("STORAGE_TABLE_ENDPOINT"),
    storageTableName: process.env.STORAGE_TABLE_NAME || "workspaces",
    schedule: process.env.COLLECTOR_SCHEDULE || "0 0 3 * * *"
  };
}
