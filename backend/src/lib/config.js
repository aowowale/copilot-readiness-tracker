// Central configuration. Every value comes from environment settings so the same
// code runs against GCC High or commercial without edits.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

function sensitivityLabelMap(value) {
  if (!value) return {};
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("SENSITIVITY_LABEL_IDS must be a JSON object mapping label names to GUIDs."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SENSITIVITY_LABEL_IDS must be a JSON object mapping label names to GUIDs.");
  const output = {};
  for (const [name, id] of Object.entries(parsed)) {
    if (!name.trim() || typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Every SENSITIVITY_LABEL_IDS entry must map a non-empty label name to a GUID.");
    }
    output[name.trim()] = id;
  }
  return output;
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
    roleChangeFeedJson: process.env.ROLE_CHANGE_FEED_JSON || "",
    maxRoleChanges: Number.parseInt(process.env.MAX_ROLE_CHANGES || "100", 10) || 100,
    sitePrincipalsFeedJson: process.env.SITE_PRINCIPALS_FEED_JSON || "",
    resolveOwnerManagers: process.env.RESOLVE_OWNER_MANAGERS !== "false",
    staleSourceHours: Number.parseInt(process.env.STALE_SOURCE_HOURS || "36", 10) || 36,
    staleWorkspaceDays: Number.parseInt(process.env.STALE_WORKSPACE_DAYS || "180", 10) || 180,
    guestReviewDays: Number.parseInt(process.env.GUEST_REVIEW_DAYS || "180", 10) || 180,
    agentStaleDays: Number.parseInt(process.env.AGENT_STALE_DAYS || "180", 10) || 180,
    // Names of licence holders with no recent Copilot activity. Set false to show counts only.
    copilotShowUsers: process.env.COPILOT_SHOW_USERS !== "false",
    // off, dry-run (records what would be sent) or live (needs the executor identity).
    notificationMode: ["off", "live"].includes(process.env.NOTIFICATION_MODE) ? process.env.NOTIFICATION_MODE : "dry-run",
    notifySender: process.env.NOTIFY_SENDER || "",
    notifyOperatorEmail: process.env.NOTIFY_OPERATOR_EMAIL || "",
    appUrl: process.env.APP_URL || "",
    storageBlobEndpoint: process.env.STORAGE_BLOB_ENDPOINT || "",
    evidenceContainer: process.env.EVIDENCE_CONTAINER || "feeds",
    evidenceBlobName: process.env.EVIDENCE_BLOB_NAME || "evidence.json",
    evidenceMaxAgeHours: Number.parseInt(process.env.EVIDENCE_MAX_AGE_HOURS || "72", 10) || 72,
    // dry-run records what would be removed; live also needs the separate executor identity.
    executionMode: process.env.EXECUTION_MODE === "live" ? "live" : "dry-run",
    executorClientId: process.env.EXECUTOR_CLIENT_ID || "",
    lifecycleExecutionEnabled: process.env.ENABLE_LIFECYCLE_EXECUTION === "true",
    oneDriveSharingRevocationEnabled: process.env.ENABLE_ONEDRIVE_SHARING_REVOCATION === "true",
    sensitivityLabelIds: sensitivityLabelMap(process.env.SENSITIVITY_LABEL_IDS || ""),
    // Emulator only. Never set in a deployment.
    storageConnectionString: process.env.STORAGE_CONNECTION_STRING || "",
    schedule: process.env.COLLECTOR_SCHEDULE || "0 0 3 * * *",
    allowLocalAuth: process.env.ALLOW_LOCAL_AUTH === "true"
  };
}
