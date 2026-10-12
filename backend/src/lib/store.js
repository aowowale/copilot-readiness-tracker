import { TableClient, TableTransaction } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { createHash } from "node:crypto";

// Snapshot storage. One entity per workspace, plus a single run-metadata entity.
// Uses managed identity against the table endpoint; no connection string or key.

const PARTITION = "workspace";
const META_PARTITION = "meta";
const META_ROW = "lastRun";

const GOVERNANCE_TABLES = {
  findings: "findings",
  cases: "cases",
  actions: "actions",
  exceptions: "exceptions",
  approvals: "approvals",
  verifications: "verifications",
  audit: "audit",
  tasks: "ownertasks",
  decisions: "decisions",
  runs: "runs",
  suppressions: "suppressions",
  trend: "trend",
  riskDefinitions: "riskdefs",
  changes: "changes",
  requests: "requests",
  workspaceMetadata: "workspacemeta",
  agents: "agents",
  copilot: "copilot",
  notifications: "notifications",
  oneDrive: "onedrive",
  oneDriveReviews: "onedrivereviews",
  baselines: "baselines",
  driftAlerts: "driftalerts"
};

function createClient(config) {
  if (config.storageConnectionString) return tableFromConnectionString(config, config.storageTableName);
  const credential = new DefaultAzureCredential(
    config.collectorClientId ? { managedIdentityClientId: config.collectorClientId } : {}
  );
  return new TableClient(config.storageTableEndpoint, config.storageTableName, credential);
}

function createGovernanceClient(config, table) {
  if (config.storageConnectionString) return tableFromConnectionString(config, table);
  const credential = new DefaultAzureCredential(
    config.collectorClientId ? { managedIdentityClientId: config.collectorClientId } : {}
  );
  return new TableClient(config.storageTableEndpoint, table, credential);
}

// Local development and tests only (an emulator). Deployments use managed identity and never set this.
function tableFromConnectionString(config, table) {
  return TableClient.fromConnectionString(config.storageConnectionString, table, { allowInsecureConnection: true });
}

async function ensureTable(client) {
  await client.createTable().catch((error) => {
    if (error?.statusCode !== 409) throw error;
  });
}

function entityFromRecord(partitionKey, rowKey, record) {
  const entity = { partitionKey, rowKey };
  for (const [key, value] of Object.entries(record)) {
    if (key !== "partitionKey" && key !== "rowKey" && value !== undefined) {
      entity[key] = typeof value === "object" ? JSON.stringify(value) : value;
    }
  }
  return entity;
}

function recordFromEntity(entity) {
  const record = { ...entity };
  delete record.etag;
  delete record.partitionKey;
  delete record.rowKey;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && (value === "null" || /^[\[{]/.test(value))) {
      try { record[key] = JSON.parse(value); } catch { /* preserve plain strings */ }
    }
  }
  return record;
}

async function writeGovernanceRecord(config, table, partitionKey, rowKey, record) {
  const client = createGovernanceClient(config, table);
  await ensureTable(client);
  await client.upsertEntity(entityFromRecord(partitionKey, rowKey, record), "Replace");
}

async function readGovernanceRecords(config, table, partitionKey, { limit = 100 } = {}) {
  const client = createGovernanceClient(config, table);
  await ensureTable(client);
  const records = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: `PartitionKey eq '${partitionKey}'` } })) {
    records.push(recordFromEntity(entity));
    if (records.length >= limit) break;
  }
  return records;
}

export async function writeCase(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.cases, "case", record.caseId, record);
}

export async function createCaseIfAbsent(config, record) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.cases);
  await ensureTable(client);
  try {
    await client.createEntity(entityFromRecord("case", record.caseId, record));
    return true;
  } catch (error) {
    if (error?.statusCode === 409) return false;
    throw error;
  }
}

export async function writeFinding(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.findings, "finding", record.findingId, record);
}

export async function readFindings(config, options = {}) {
  const records = await readGovernanceRecords(config, GOVERNANCE_TABLES.findings, "finding", options);
  const resourceIds = options.resourceIds ? new Set(options.resourceIds) : null;
  return records
    .filter((record) => !options.status || record.status === options.status)
    .filter((record) => !options.policyId || record.policyId === options.policyId)
    .filter((record) => !resourceIds || resourceIds.has(record.resourceId));
}

export async function readCaseForUpdate(config, caseId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.cases);
  try {
    const entity = await client.getEntity("case", caseId);
    return { record: recordFromEntity(entity), etag: entity.etag };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function commitCaseTransition(config, record, audit, etag) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.cases);
  const transaction = new TableTransaction();
  transaction.updateEntity(entityFromRecord("case", record.caseId, record), "Replace", { etag });
  transaction.createEntity(entityFromRecord(
    "case",
    `audit-${record.caseId}-${record.version}`,
    { ...audit, recordType: "case-transition-audit" }
  ));
  await client.submitTransaction(transaction.actions);
}

export async function readCases(config, options = {}) {
  const records = await readGovernanceRecords(config, GOVERNANCE_TABLES.cases, "case", options);
  return records.filter((record) => record.recordType !== "case-transition-audit")
    .filter((record) => !options.status || record.status === options.status)
    .filter((record) => !options.userId || record.userId === options.userId);
}

export async function writeAction(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.actions, record.caseId, record.actionId, record);
}

export async function createActionIfAbsent(config, record) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.actions);
  await ensureTable(client);
  try {
    await client.createEntity(entityFromRecord(record.caseId, record.actionId, record));
    return true;
  } catch (error) {
    if (error?.statusCode === 409) return false;
    throw error;
  }
}

export async function readActionForUpdate(config, caseId, actionId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.actions);
  await ensureTable(client);
  try {
    const entity = await client.getEntity(caseId, actionId);
    return { record: recordFromEntity(entity), etag: entity.etag };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function updateActionIfUnchanged(config, record, etag) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.actions);
  try {
    await client.updateEntity(entityFromRecord(record.caseId, record.actionId, record), "Replace", { etag });
    return true;
  } catch (error) {
    if (error?.statusCode === 412 || error?.statusCode === 409) return false;
    throw error;
  }
}

export async function readActions(config, caseId, options = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.actions, caseId, options);
}

// Cross-task history for the executed-actions view. Newest first.
export async function readActionHistory(config, { limit = 200, workspaceId } = {}) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.actions);
  await ensureTable(client);
  const records = [];
  for await (const entity of client.listEntities()) {
    const record = recordFromEntity(entity);
    if (record.actionType !== "remove-member" && record.actionType !== "revoke-permission") continue;
    if (workspaceId && record.workspaceId !== workspaceId) continue;
    records.push(record);
  }
  return records
    .sort((left, right) => String(right.completedAt || right.requestedAt).localeCompare(String(left.completedAt || left.requestedAt)))
    .slice(0, limit);
}

export async function writeException(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.exceptions, "exception", record.exceptionId, record);
}

export async function readExceptions(config, options = {}) {
  const records = await readGovernanceRecords(config, GOVERNANCE_TABLES.exceptions, "exception", options);
  return records.filter((record) => !options.status || record.status === options.status);
}

export async function writeApproval(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.approvals, record.caseId, record.approvalId, record);
}

export async function readApprovals(config, caseId, options = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.approvals, caseId, options);
}

export async function writeVerification(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.verifications, record.caseId, record.verificationId, record);
}

export async function readVerifications(config, caseId, options = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.verifications, caseId, options);
}

export async function writeAudit(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.audit, record.caseId, record.auditId, record);
}

export async function readAuditTrail(config, caseId, options = {}) {
  const [legacyAudit, transitionAudit] = await Promise.all([
    readGovernanceRecords(config, GOVERNANCE_TABLES.audit, caseId, options),
    readGovernanceRecords(config, GOVERNANCE_TABLES.cases, "case", { limit: 1000 })
  ]);
  return [
    ...legacyAudit,
    ...transitionAudit.filter((record) => record.recordType === "case-transition-audit" && record.caseId === caseId)
  ].sort((left, right) => String(left.occurredAt || "").localeCompare(String(right.occurredAt || "")));
}

export async function readCaseDetail(config, caseId) {
  const cases = await readCases(config, { limit: 1000 });
  const record = cases.find((item) => item.caseId === caseId) || null;
  if (!record) return null;
  const [actions, approvals, verifications, auditTrail] = await Promise.all([
    readActions(config, caseId),
    readApprovals(config, caseId),
    readVerifications(config, caseId),
    readAuditTrail(config, caseId)
  ]);
  return { case: record, actions, approvals, verifications, auditTrail };
}

export async function readTasksWithEtag(config, { limit = 1000 } = {}) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.tasks);
  await ensureTable(client);
  const tasks = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'task'" } })) {
    tasks.push({ record: recordFromEntity(entity), etag: entity.etag });
    if (tasks.length >= limit) break;
  }
  return tasks;
}

export async function readTaskForUpdate(config, taskId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.tasks);
  try {
    const entity = await client.getEntity("task", taskId);
    return { record: recordFromEntity(entity), etag: entity.etag };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function createTaskIfAbsent(config, record) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.tasks);
  await ensureTable(client);
  try {
    await client.createEntity(entityFromRecord("task", record.taskId, record));
    return true;
  } catch (error) {
    if (error?.statusCode === 409) return false;
    throw error;
  }
}

// Returns false when another writer changed the task first.
export async function updateTaskIfUnchanged(config, record, etag) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.tasks);
  try {
    await client.updateEntity(entityFromRecord("task", record.taskId, record), "Replace", { etag });
    return true;
  } catch (error) {
    if (error?.statusCode === 412 || error?.statusCode === 409) return false;
    throw error;
  }
}

export async function writeDecision(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.decisions, "decision", record.decisionId, record);
}

export async function readDecisions(config, options = {}) {
  const records = await readGovernanceRecords(config, GOVERNANCE_TABLES.decisions, "decision", options);
  return records
    .filter((record) => !options.workspaceId || record.workspaceId === options.workspaceId)
    .sort((left, right) => String(right.decidedAt).localeCompare(String(left.decidedAt)));
}

export async function readDecision(config, decisionId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.decisions);
  try {
    return recordFromEntity(await client.getEntity("decision", decisionId));
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

const MAX_FEED_BYTES = 8 * 1024 * 1024;

// Returns the feed text, or null when no feed has been uploaded.
export async function readEvidenceFeedText(config) {
  if (!config.storageBlobEndpoint) return null;
  const credential = new DefaultAzureCredential(
    config.collectorClientId ? { managedIdentityClientId: config.collectorClientId } : {}
  );
  const blob = new BlobServiceClient(config.storageBlobEndpoint, credential)
    .getContainerClient(config.evidenceContainer)
    .getBlobClient(config.evidenceBlobName);
  try {
    const properties = await blob.getProperties();
    if (properties.contentLength > MAX_FEED_BYTES) throw new Error(`The evidence feed is larger than ${MAX_FEED_BYTES} bytes.`);
    return (await blob.downloadToBuffer()).toString("utf8");
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function writeSuppression(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.suppressions, "suppression", record.suppressionId, record);
}

export async function readSuppressions(config, { limit = 1000 } = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.suppressions, "suppression", { limit });
}

export async function readSuppression(config, suppressionId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.suppressions);
  try {
    return recordFromEntity(await client.getEntity("suppression", suppressionId));
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

// One row per day; a later run the same day replaces it.
export async function writeTrendPoint(config, point) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.trend, "trend", point.day, point);
}

export async function readTrend(config, { days = 90 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const points = await readGovernanceRecords(config, GOVERNANCE_TABLES.trend, "trend", { limit: 1000 });
  return points.filter((point) => point.day >= since).sort((left, right) => left.day.localeCompare(right.day));
}

// The active definition is a copy under a fixed key; every version is also kept as history.
export async function writeRiskDefinition(config, record) {
  await writeGovernanceRecord(config, GOVERNANCE_TABLES.riskDefinitions, "definition", record.definitionId, record);
  await writeGovernanceRecord(config, GOVERNANCE_TABLES.riskDefinitions, "definition", "active", record);
}

export async function readRiskDefinition(config) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.riskDefinitions);
  await ensureTable(client);
  try {
    return recordFromEntity(await client.getEntity("definition", "active"));
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function readRiskDefinitionHistory(config) {
  const records = await readGovernanceRecords(config, GOVERNANCE_TABLES.riskDefinitions, "definition", { limit: 200 });
  // The active copy repeats the latest version, so keep one record per version.
  return [...new Map(records.map((record) => [record.version, record])).values()].sort((left, right) => right.version - left.version);
}

// Metadata is merged field by field, so saving contacts never erases the business purpose.
export async function mergeWorkspaceMetadata(config, workspaceId, fields) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.workspaceMetadata);
  await ensureTable(client);
  await client.upsertEntity(entityFromRecord("meta", workspaceId, fields), "Merge");
}

export async function readWorkspaceMetadata(config, { workspaceId } = {}) {
  if (workspaceId) {
    const client = createGovernanceClient(config, GOVERNANCE_TABLES.workspaceMetadata);
    try {
      return [{ workspaceId, ...recordFromEntity(await client.getEntity("meta", workspaceId)) }];
    } catch (error) {
      if (error?.statusCode === 404) return [];
      throw error;
    }
  }
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.workspaceMetadata);
  await ensureTable(client);
  const records = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'meta'" } })) {
    records.push({ workspaceId: entity.rowKey, ...recordFromEntity(entity) });
  }
  return records;
}

// Replaces the agents from each source that was read successfully this run. A source that could
// not be read keeps its previous agents, so one failed call does not empty the inventory.
export async function replaceAgents(config, agents, sourcesRead, collectedAt) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.agents);
  await ensureTable(client);
  const keep = new Set(agents.map((agent) => agent.agentId));
  for (const agent of agents) {
    await client.upsertEntity(entityFromRecord("agent", agent.agentId, { ...agent, lastSeenAt: collectedAt }), "Replace");
  }
  const gone = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'agent'" } })) {
    if (!keep.has(entity.rowKey) && sourcesRead.has(entity.source)) gone.push(entity.rowKey);
  }
  for (const rowKey of gone) await client.deleteEntity("agent", rowKey);
}

export async function readAgents(config) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.agents, "agent", { limit: 5000 });
}

const safeRowKey = (value) => String(value).replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 200);

// The summary is one row; licence holders with no recent activity are one row each, replaced
// every run so an old list never survives a run that could not read adoption.
export async function writeCopilot(config, { collectedAt, licences, adoption, sources }) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.copilot);
  await ensureTable(client);
  const { reclaim = [], ...adoptionSummary } = adoption || {};
  await client.upsertEntity(entityFromRecord("summary", "latest", { collectedAt, licences, adoption: adoption ? adoptionSummary : null, sources }), "Replace");

  const keep = new Set();
  for (const person of reclaim.slice(0, 1000)) {
    const key = safeRowKey(person.userPrincipalName);
    keep.add(key);
    await client.upsertEntity(entityFromRecord("reclaim", key, person), "Replace");
  }
  const gone = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'reclaim'" } })) {
    if (!keep.has(entity.rowKey)) gone.push(entity.rowKey);
  }
  for (const rowKey of gone) await client.deleteEntity("reclaim", rowKey);
}

export async function readCopilot(config) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.copilot);
  await ensureTable(client);
  let summary = null;
  try {
    summary = recordFromEntity(await client.getEntity("summary", "latest"));
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
  }
  const reclaim = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'reclaim'" } })) reclaim.push(recordFromEntity(entity));
  reclaim.sort((left, right) => (right.daysSinceActivity ?? Infinity) - (left.daysSinceActivity ?? Infinity));
  return { summary, reclaim };
}

export async function readNotification(config, dedupeKey) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.notifications);
  await ensureTable(client);
  try {
    return recordFromEntity(await client.getEntity("notification", notificationKey(dedupeKey)));
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function writeNotification(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.notifications, "notification", notificationKey(record.dedupeKey), record);
}

export async function readNotifications(config, { limit = 100 } = {}) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.notifications);
  await ensureTable(client);
  const records = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'notification'" } })) records.push(recordFromEntity(entity));
  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, limit);
}

const oneDriveRowKey = (siteKey) => createHash("sha256").update(String(siteKey)).digest("hex");

// OneDrive metadata inventory from the secured SharePoint admin export. This stores only site
// metadata: it never copies document names, contents or sharing permission payloads.
export async function writeOneDriveInventory(config, { sites, generatedAt, complete = false }) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.oneDrive);
  await ensureTable(client);
  const current = new Set();
  for (const site of sites) {
    const rowKey = oneDriveRowKey(site.siteKey);
    current.add(rowKey);
    await client.upsertEntity(entityFromRecord("site", rowKey, { ...site, generatedAt }), "Replace");
  }
  if (complete) {
    const gone = [];
    for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'site'" } })) {
      if (!current.has(entity.rowKey)) gone.push(entity.rowKey);
    }
    for (const rowKey of gone) await client.deleteEntity("site", rowKey);
  }
}

export async function readOneDriveInventory(config, { limit = 10000 } = {}) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.oneDrive);
  await ensureTable(client);
  const sites = [];
  for await (const entity of client.listEntities({ queryOptions: { filter: "PartitionKey eq 'site'" } })) {
    sites.push(recordFromEntity(entity));
    if (sites.length >= limit) break;
  }
  return sites.sort((a, b) => String(a.title || a.ownerUpn || a.url).localeCompare(String(b.title || b.ownerUpn || b.url)));
}

export async function readOneDriveReview(config, siteKey) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.oneDriveReviews);
  await ensureTable(client);
  try {
    const entity = await client.getEntity("review", oneDriveRowKey(siteKey));
    return { record: recordFromEntity(entity), etag: entity.etag };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function readOneDriveReviews(config, { limit = 10000 } = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.oneDriveReviews, "review", { limit });
}

export async function createOneDriveReviewIfAbsent(config, record) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.oneDriveReviews);
  await ensureTable(client);
  try {
    await client.createEntity(entityFromRecord("review", oneDriveRowKey(record.siteKey), record));
    return true;
  } catch (error) {
    if (error?.statusCode === 409) return false;
    throw error;
  }
}

export async function updateOneDriveReviewIfUnchanged(config, record, etag) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.oneDriveReviews);
  try {
    await client.updateEntity(entityFromRecord("review", oneDriveRowKey(record.siteKey), record), "Replace", { etag });
    return true;
  } catch (error) {
    if (error?.statusCode === 412 || error?.statusCode === 409) return false;
    throw error;
  }
}

export async function readBaselineForUpdate(config, workspaceId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.baselines);
  await ensureTable(client);
  try {
    const entity = await client.getEntity("baseline", `active-${safeRowKey(workspaceId)}`);
    return { record: recordFromEntity(entity), etag: entity.etag };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function readBaselines(config, { limit = 10000 } = {}) {
  return (await readGovernanceRecords(config, GOVERNANCE_TABLES.baselines, "baseline", { limit }))
    .filter((record) => record.recordType === "active-baseline" && record.workspaceId)
    .map(({ recordType, ...record }) => record);
}

export async function createBaselineIfAbsent(config, record) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.baselines);
  await ensureTable(client);
  try {
    await client.createEntity(entityFromRecord("baseline", `active-${safeRowKey(record.workspaceId)}`, { ...record, recordType: "active-baseline" }));
    return true;
  } catch (error) {
    if (error?.statusCode === 409) return false;
    throw error;
  }
}

export async function updateBaselineIfUnchanged(config, record, etag) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.baselines);
  try {
    await client.updateEntity(entityFromRecord("baseline", `active-${safeRowKey(record.workspaceId)}`, { ...record, recordType: "active-baseline" }), "Replace", { etag });
    return true;
  } catch (error) {
    if (error?.statusCode === 412 || error?.statusCode === 409) return false;
    throw error;
  }
}

export async function writeBaselineHistory(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.baselines, "baseline", `history-${safeRowKey(record.baselineId)}`, { ...record, recordType: "baseline-history" });
}

export async function commitBaseline(config, record, currentEtag = null) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.baselines);
  await ensureTable(client);
  const transaction = new TableTransaction();
  const active = entityFromRecord("baseline", `active-${safeRowKey(record.workspaceId)}`, { ...record, recordType: "active-baseline" });
  if (currentEtag) transaction.updateEntity(active, "Replace", { etag: currentEtag });
  else transaction.createEntity(active);
  transaction.createEntity(entityFromRecord("baseline", `history-${safeRowKey(record.baselineId)}`, { ...record, recordType: "baseline-history" }));
  try {
    await client.submitTransaction(transaction.actions);
    return true;
  } catch (error) {
    if (error?.statusCode === 409 || error?.statusCode === 412) return false;
    throw error;
  }
}

export async function readBaselineHistory(config, workspaceId, { limit = 100 } = {}) {
  return (await readGovernanceRecords(config, GOVERNANCE_TABLES.baselines, "baseline", { limit: Math.min(limit * 2, 1000) }))
  .filter((record) => record.recordType === "baseline-history" && record.baselineId)
  .map(({ recordType, ...record }) => record)
    .filter((record) => !workspaceId || record.workspaceId === workspaceId)
    .sort((a, b) => (b.version || 0) - (a.version || 0));
}

export async function readDriftAlertForUpdate(config, alertId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.driftAlerts);
  await ensureTable(client);
  try {
    const entity = await client.getEntity("alert", safeRowKey(alertId));
    return { record: recordFromEntity(entity), etag: entity.etag };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

export async function readDriftAlerts(config, { limit = 5000 } = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.driftAlerts, "alert", { limit });
}

export async function writeDriftAlert(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.driftAlerts, "alert", safeRowKey(record.alertId), record);
}

export async function updateDriftAlertIfUnchanged(config, record, etag) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.driftAlerts);
  try {
    await client.updateEntity(entityFromRecord("alert", safeRowKey(record.alertId), record), "Replace", { etag });
    return true;
  } catch (error) {
    if (error?.statusCode === 412 || error?.statusCode === 409) return false;
    throw error;
  }
}

// Row keys cannot contain / \ # ? or control characters.
const notificationKey = (dedupeKey) => String(dedupeKey).replace(/[^a-zA-Z0-9._|@-]/g, "_").slice(0, 400);

export async function createRequestIfAbsent(config, record) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.requests);
  await ensureTable(client);
  try {
    await client.createEntity(entityFromRecord("request", record.requestId, record));
    return true;
  } catch (error) {
    if (error?.statusCode === 409) return false;
    throw error;
  }
}

export async function readRequests(config, { limit = 500 } = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.requests, "request", { limit });
}

export async function readRequestForUpdate(config, requestId) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.requests);
  try {
    const entity = await client.getEntity("request", requestId);
    return { record: recordFromEntity(entity), etag: entity.etag };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

// Returns false when another operator decided the request first.
export async function updateRequestIfUnchanged(config, record, etag) {
  const client = createGovernanceClient(config, GOVERNANCE_TABLES.requests);
  try {
    await client.updateEntity(entityFromRecord("request", record.requestId, record), "Replace", { etag });
    return true;
  } catch (error) {
    if (error?.statusCode === 412 || error?.statusCode === 409) return false;
    throw error;
  }
}

export async function writeChanges(config, changes) {
  for (const change of changes) await writeGovernanceRecord(config, GOVERNANCE_TABLES.changes, "change", change.changeId, change);
}

export async function readChanges(config, { days = 30, workspaceId, limit = 500 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const records = await readGovernanceRecords(config, GOVERNANCE_TABLES.changes, "change", { limit: 5000 });
  return records
    .filter((record) => record.day >= since)
    .filter((record) => !workspaceId || record.workspaceId === workspaceId)
    .sort((left, right) => String(right.detectedAt).localeCompare(String(left.detectedAt)))
    .slice(0, limit);
}

export async function writeRun(config, record) {
  return writeGovernanceRecord(config, GOVERNANCE_TABLES.runs, "run", record.runId, record);
}

export async function readRuns(config, options = {}) {
  return readGovernanceRecords(config, GOVERNANCE_TABLES.runs, "run", { limit: options.limit || 200 });
}

export async function writeSnapshot(config, workspaces, runInfo) {
  const client = createClient(config);
  await client.createTable().catch((error) => {
    if (error?.statusCode !== 409) throw error;
  });

  for (const workspace of workspaces) {
    await client.upsertEntity(
      {
        partitionKey: PARTITION,
        rowKey: workspace.id,
        data: JSON.stringify(workspace),
        collectedAt: runInfo.collectedAt
      },
      "Replace"
    );
  }

  await client.upsertEntity(
    {
      partitionKey: META_PARTITION,
      rowKey: META_ROW,
      collectedAt: runInfo.collectedAt,
      status: runInfo.status,
      warnings: JSON.stringify(runInfo.warnings || []),
      workspaceCount: workspaces.length
    },
    "Replace"
  );
}

export async function readSnapshot(config) {
  const client = createClient(config);
  await ensureTable(client);
  const workspaces = [];
  let meta = null;

  const entities = client.listEntities();
  for await (const entity of entities) {
    if (entity.partitionKey === PARTITION && entity.data) {
      workspaces.push(JSON.parse(entity.data));
    } else if (entity.partitionKey === META_PARTITION && entity.rowKey === META_ROW) {
      meta = {
        collectedAt: entity.collectedAt || null,
        status: entity.status || "unknown",
        warnings: entity.warnings ? JSON.parse(entity.warnings) : [],
        workspaceCount: entity.workspaceCount || 0
      };
    }
  }

  return { workspaces, meta };
}
