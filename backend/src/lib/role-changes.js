const ROLE_ATTRIBUTES = [
  "department",
  "organization",
  "positionCode",
  "managerId",
  "workerType",
  "employmentStatus",
  "dutyLocation"
];

function valueOf(record, key) {
  return record?.[key] === undefined || record?.[key] === null ? "" : String(record[key]).trim();
}

function safeKey(value, fallback) {
  const key = String(value || fallback).replace(/[\\/#?]/g, "-").slice(0, 1024);
  if (!key) throw new Error("Role-change record contains an empty identifier.");
  return key;
}

function normalizeEntitlement(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Entitlement must be an object.");
  return {
    resourceId: safeKey(raw.resourceId, "resource"),
    resourceName: valueOf(raw, "resourceName"),
    classification: valueOf(raw, "classification") || "project/discretionary",
    actionType: valueOf(raw, "actionType")
  };
}

export function normalizeRoleChange(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Role-change record must be an object.");
  const userId = valueOf(raw, "userId");
  if (!userId) throw new Error("Role-change record is missing userId.");

  const before = {};
  const after = {};
  for (const attribute of ROLE_ATTRIBUTES) {
    before[attribute] = valueOf(raw.before, attribute);
    after[attribute] = valueOf(raw.after, attribute);
  }

  const changedAttributes = ROLE_ATTRIBUTES.filter((attribute) => before[attribute] !== after[attribute]);
  return {
    caseId: safeKey(valueOf(raw, "caseId") || `mover-${userId}-${valueOf(raw, "effectiveAt") || "undated"}`, "mover-case"),
    userId,
    userDisplayName: valueOf(raw, "userDisplayName"),
    oldRole: valueOf(raw, "oldRole") || before.positionCode || before.department,
    newRole: valueOf(raw, "newRole") || after.positionCode || after.department,
    before,
    after,
    changedAttributes,
    effectiveAt: valueOf(raw, "effectiveAt"),
    source: valueOf(raw, "source") || "controlled HR feed",
    currentEntitlements: Array.isArray(raw.currentEntitlements) ? raw.currentEntitlements.map(normalizeEntitlement) : [],
    allowedResourceIds: Array.isArray(raw.allowedResourceIds) ? raw.allowedResourceIds.map((id) => safeKey(id, "resource")) : [],
    status: "proposed",
    actionPosture: "dry-run"
  };
}

export function classifyEntitlements(currentEntitlements = [], policy = {}) {
  const allowed = new Set(Array.isArray(policy.allowedResourceIds) ? policy.allowedResourceIds.map(String) : []);
  return currentEntitlements.map((raw) => {
    const entitlement = { ...raw, resourceId: String(raw.resourceId || "") };
    const classification = entitlement.classification || "project/discretionary";
    const deterministic = classification === "birthright" || classification === "role-based";
    return {
      ...entitlement,
      classification,
      expected: allowed.size ? allowed.has(entitlement.resourceId) : null,
      reviewRequired: !deterministic || (allowed.size > 0 && !allowed.has(entitlement.resourceId))
    };
  });
}

export function proposeActions(entitlements = [], roleChange) {
  if (!roleChange?.caseId) throw new Error("A normalized role-change case is required.");
  return entitlements.filter((entitlement) => entitlement.reviewRequired || entitlement.expected === false).map((entitlement, index) => ({
    actionId: safeKey(`${roleChange.caseId}-action-${index + 1}`, `action-${index + 1}`),
    caseId: roleChange.caseId,
    actionType: entitlement.expected === false ? "remove-access" : "review-access",
    resourceId: entitlement.resourceId,
    resourceName: entitlement.resourceName || entitlement.resourceId,
    classification: entitlement.classification,
    status: "proposed",
    dryRun: true,
    requiresApproval: entitlement.actionType !== "add-access",
    reason: entitlement.expected === false ? "Resource is outside the new role baseline." : "Access requires manager or resource-owner review."
  }));
}

export function parseRoleChangeFeed(feedJson, { maxRecords = 100, maxBytes = 262144 } = {}) {
  if (!feedJson) return [];
  if (Buffer.byteLength(feedJson, "utf8") > maxBytes) throw new Error("Role-change feed exceeds the configured size limit.");
  let payload;
  try {
    payload = JSON.parse(feedJson);
  } catch {
    throw new Error("ROLE_CHANGE_FEED_JSON must contain valid JSON.");
  }
  const records = Array.isArray(payload) ? payload : payload?.roleChanges;
  if (!Array.isArray(records)) throw new Error("Role-change feed must be an array or an object with roleChanges.");
  if (records.length > maxRecords) throw new Error(`Role-change feed exceeds the ${maxRecords}-record limit.`);
  const normalized = records.map(normalizeRoleChange);
  const ids = new Set();
  for (const record of normalized) {
    if (ids.has(record.caseId)) throw new Error(`Role-change feed contains duplicate caseId: ${record.caseId}.`);
    ids.add(record.caseId);
  }
  return normalized;
}

export function createDryRunActions(roleChange) {
  const entitlements = Array.isArray(roleChange.currentEntitlements) ? roleChange.currentEntitlements : [];
  const classified = classifyEntitlements(entitlements, { allowedResourceIds: roleChange.allowedResourceIds });
  return proposeActions(classified, roleChange);
}

export { ROLE_ATTRIBUTES };