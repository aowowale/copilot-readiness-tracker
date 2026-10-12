import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startEmulator } from "./helpers/emulator.js";
import * as store from "../src/lib/store.js";

// These tests run the real storage layer against the Azurite table emulator. They are skipped
// when the emulator cannot start.

let emulator;
let config;
before(async () => {
  emulator = await startEmulator();
  if (emulator) config = { storageConnectionString: emulator.connectionString, storageTableName: "workspaces", collectorClientId: "" };
});
after(() => emulator?.stop());

const skip = (t) => { if (!emulator) { t.skip("Azurite is not available"); return true; } return false; };
const task = (id, extra = {}) => ({ taskId: id, workspaceId: "w1", status: "open", version: 0, steps: {}, assigneeIds: ["a"], ...extra });

test("tasks: create is idempotent and updates are rejected when the etag is stale", async (t) => {
  if (skip(t)) return;
  assert.equal(await store.createTaskIfAbsent(config, task("t1")), true);
  assert.equal(await store.createTaskIfAbsent(config, task("t1")), false);
  const first = await store.readTaskForUpdate(config, "t1");
  assert.deepEqual(first.record.assigneeIds, ["a"]);
  assert.equal(await store.updateTaskIfUnchanged(config, { ...first.record, version: 1 }, first.etag), true);
  assert.equal(await store.updateTaskIfUnchanged(config, { ...first.record, version: 2 }, first.etag), false);
  assert.equal((await store.readTaskForUpdate(config, "t1")).record.version, 1);
  assert.equal(await store.readTaskForUpdate(config, "missing"), null);
  assert.ok((await store.readTasksWithEtag(config)).some((entry) => entry.record.taskId === "t1"));
});

test("decisions, actions and audit round-trip", async (t) => {
  if (skip(t)) return;
  await store.writeDecision(config, { decisionId: "d1", taskId: "t1", choice: "keep", status: "recorded", decidedAt: "2025-01-01T00:00:00Z", evidence: { kept: 1 } });
  assert.deepEqual((await store.readDecision(config, "d1")).evidence, { kept: 1 });
  assert.equal(await store.readDecision(config, "none"), null);
  await store.writeAction(config, { actionId: "a1", caseId: "t1", status: "proposed", requestedAt: "2025-01-01T00:00:00Z" });
  await store.writeAction(config, { actionId: "a1", caseId: "t1", status: "verified", requestedAt: "2025-01-01T00:00:00Z" });
  const actions = await store.readActions(config, "t1");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "verified");
  await store.writeAudit(config, { auditId: "au1", caseId: "t1", eventType: "x", occurredAt: "2025-01-01T00:00:00Z" });
  assert.equal((await store.readAuditTrail(config, "t1")).length, 1);
});

test("trend keeps one row per day and respects the window", async (t) => {
  if (skip(t)) return;
  const today = new Date().toISOString().slice(0, 10);
  await store.writeTrendPoint(config, { day: today, discovered: 1 });
  await store.writeTrendPoint(config, { day: today, discovered: 5 });
  await store.writeTrendPoint(config, { day: "2000-01-01", discovered: 9 });
  const points = await store.readTrend(config, { days: 30 });
  assert.deepEqual(points.map((point) => point.discovered), [5]);
});

test("risk definition keeps an active copy and one history row per version", async (t) => {
  if (skip(t)) return;
  assert.equal(await store.readRiskDefinition(config), null);
  await store.writeRiskDefinition(config, { definitionId: "rd-1", version: 1, weights: { owners: 25 } });
  await store.writeRiskDefinition(config, { definitionId: "rd-2", version: 2, weights: { owners: 30 } });
  assert.equal((await store.readRiskDefinition(config)).version, 2);
  assert.deepEqual((await store.readRiskDefinitionHistory(config)).map((record) => record.version), [2, 1]);
});

test("suppressions and runs", async (t) => {
  if (skip(t)) return;
  await store.writeSuppression(config, { suppressionId: "s1", workspaceId: "w1", policyId: "p", status: "active", expiresAt: "2099-01-01T00:00:00Z" });
  assert.equal((await store.readSuppression(config, "s1")).policyId, "p");
  assert.equal(await store.readSuppression(config, "nope"), null);
  assert.equal((await store.readSuppressions(config)).length, 1);
  await store.writeRun(config, { runId: "r1", source: "graph-teams", status: "ok", finishedAt: "2025-01-01T00:00:00Z" });
  assert.equal((await store.readRuns(config)).length, 1);
});

test("requests: create once, and a second decider loses the race", async (t) => {
  if (skip(t)) return;
  assert.equal(await store.createRequestIfAbsent(config, { requestId: "q1", status: "pending" }), true);
  assert.equal(await store.createRequestIfAbsent(config, { requestId: "q1", status: "pending" }), false);
  const read = await store.readRequestForUpdate(config, "q1");
  assert.equal(await store.updateRequestIfUnchanged(config, { ...read.record, status: "approved" }, read.etag), true);
  assert.equal(await store.updateRequestIfUnchanged(config, { ...read.record, status: "rejected" }, read.etag), false);
  assert.equal((await store.readRequestForUpdate(config, "q1")).record.status, "approved");
});

test("metadata merges field by field", async (t) => {
  if (skip(t)) return;
  await store.mergeWorkspaceMetadata(config, "w1", { primaryContact: "Ann" });
  await store.mergeWorkspaceMetadata(config, "w1", { businessPurpose: "Finance close" });
  const [record] = await store.readWorkspaceMetadata(config, { workspaceId: "w1" });
  assert.equal(record.primaryContact, "Ann");
  assert.equal(record.businessPurpose, "Finance close");
  assert.deepEqual(await store.readWorkspaceMetadata(config, { workspaceId: "other" }), []);
});

test("agents: a source that was read replaces its agents, a source that failed keeps them", async (t) => {
  if (skip(t)) return;
  await store.replaceAgents(config, [{ agentId: "a", source: "s1" }, { agentId: "b", source: "s2" }], new Set(["s1", "s2"]), "2025-01-01T00:00:00Z");
  await store.replaceAgents(config, [], new Set(["s1"]), "2025-01-02T00:00:00Z");
  assert.deepEqual((await store.readAgents(config)).map((agent) => agent.agentId), ["b"]);
});

test("copilot: reclaim rows are replaced every run", async (t) => {
  if (skip(t)) return;
  const licences = { seatsAssigned: 2 };
  await store.writeCopilot(config, { collectedAt: "2025-01-01T00:00:00Z", licences, adoption: { activeUsers: 1, reclaim: [{ userPrincipalName: "a@x.com", daysSinceActivity: 10 }, { userPrincipalName: "b@x.com", daysSinceActivity: 90 }] }, sources: [] });
  let result = await store.readCopilot(config);
  assert.deepEqual(result.reclaim.map((person) => person.userPrincipalName), ["b@x.com", "a@x.com"]);
  assert.equal(result.summary.adoption.activeUsers, 1);
  await store.writeCopilot(config, { collectedAt: "2025-01-02T00:00:00Z", licences, adoption: null, sources: [] });
  result = await store.readCopilot(config);
  assert.equal(result.reclaim.length, 0);
  assert.equal(result.summary.adoption, null);
});

test("notifications: dedupe records are stored, updated and listed newest first", async (t) => {
  if (skip(t)) return;
  const key = "ws-1-c1|assigned|owner-1";
  assert.equal(await store.readNotification(config, key), null);
  await store.writeNotification(config, { dedupeKey: key, status: "failed", attempts: 1, updatedAt: "2025-01-01T00:00:00Z" });
  await store.writeNotification(config, { dedupeKey: key, status: "sent", attempts: 2, updatedAt: "2025-01-02T00:00:00Z" });
  await store.writeNotification(config, { dedupeKey: "other", status: "sent", attempts: 1, updatedAt: "2025-01-03T00:00:00Z" });
  assert.equal((await store.readNotification(config, key)).status, "sent");
  assert.deepEqual((await store.readNotifications(config)).map((item) => item.dedupeKey), ["other", key]);
});

test("snapshot round-trips workspaces and run metadata", async (t) => {
  if (skip(t)) return;
  await store.writeSnapshot(config, [{ id: "w1", name: "One" }, { id: "w2", name: "Two" }], { collectedAt: "2025-01-01T00:00:00Z", status: "ok", warnings: ["x"] });
  const { workspaces, meta } = await store.readSnapshot(config);
  assert.equal(workspaces.length, 2);
  assert.equal(meta.workspaceCount, 2);
  assert.deepEqual(meta.warnings, ["x"]);
});

test("OneDrive inventory replaces complete exports and review records use ETags", async (t) => {
  if (skip(t)) return;
  const generatedAt = new Date().toISOString();
  const one = { siteKey: "https://contoso-my.sharepoint.com/personal/a", url: "https://contoso-my.sharepoint.com/personal/a", ownerUpn: "a@contoso.com" };
  const two = { siteKey: "https://contoso-my.sharepoint.com/personal/b", url: "https://contoso-my.sharepoint.com/personal/b", ownerUpn: "b@contoso.com" };
  await store.writeOneDriveInventory(config, { sites: [one, two], generatedAt, complete: true });
  assert.equal((await store.readOneDriveInventory(config)).length, 2);
  await store.writeOneDriveInventory(config, { sites: [one], generatedAt, complete: true });
  assert.deepEqual((await store.readOneDriveInventory(config)).map(site => site.ownerUpn), ["a@contoso.com"]);

  const first = { siteKey: one.siteKey, outcome: "retain", reason: "Reviewed the site with its owner.", version: 1 };
  assert.equal(await store.createOneDriveReviewIfAbsent(config, first), true);
  assert.equal(await store.createOneDriveReviewIfAbsent(config, first), false);
  const found = await store.readOneDriveReview(config, one.siteKey);
  assert.equal(found.record.version, 1);
  assert.equal(await store.updateOneDriveReviewIfUnchanged(config, { ...first, outcome: "escalate", version: 2 }, found.etag), true);
  assert.equal(await store.updateOneDriveReviewIfUnchanged(config, { ...first, version: 3 }, found.etag), false);
  assert.equal((await store.readOneDriveReviews(config))[0].outcome, "escalate");
});

test("approved baselines are versioned and drift alerts can be acknowledged with ETags", async (t) => {
  if (skip(t)) return;
  const baseline = { baselineId: "w1-v1", workspaceId: "w1", workspaceName: "One", version: 1, snapshot: { id: "w1", owners: ["a", "b"] }, status: "active" };
  assert.equal(await store.commitBaseline(config, baseline), true);
  assert.equal(await store.commitBaseline(config, baseline), false);
  const active = await store.readBaselineForUpdate(config, "w1");
  assert.equal(active.record.version, 1);
  const second = { ...baseline, baselineId: "w1-v2", version: 2 };
  assert.equal(await store.commitBaseline(config, second, active.etag), true);
  assert.equal(await store.commitBaseline(config, { ...baseline, baselineId: "w1-v3", version: 3 }, active.etag), false);
  assert.equal((await store.readBaselines(config)).length, 1);
  assert.deepEqual((await store.readBaselineHistory(config, "w1")).map(item => item.version), [2, 1]);

  const alert = { alertId: "w1-guests", workspaceId: "w1", status: "open", version: 1, cycle: 1 };
  await store.writeDriftAlert(config, alert);
  const found = await store.readDriftAlertForUpdate(config, alert.alertId);
  assert.equal(found.record.status, "open");
  assert.equal(await store.updateDriftAlertIfUnchanged(config, { ...alert, status: "acknowledged", version: 2 }, found.etag), true);
  assert.equal(await store.updateDriftAlertIfUnchanged(config, { ...alert, version: 3 }, found.etag), false);
  assert.equal((await store.readDriftAlerts(config))[0].status, "acknowledged");
});

test("OneDrive sharing actions are stored with their verification and visible in history", async (t) => {
  if (skip(t)) return;
  const reviewId = "onedrive-a1b2c3";
  await store.writeAction(config, { actionId: "od-action-1", caseId: reviewId, workspaceId: "https://contoso-my.sharepoint.com/personal/user", workspaceName: "Personal site", actionType: "revoke-permission", origin: "onedrive-review", permissionId: "p1", status: "proposed", requestedAt: "2026-10-10T00:00:00Z" });
  await store.writeVerification(config, { verificationId: "od-verification-1", caseId: reviewId, actionId: "od-action-1", checkedAt: "2026-10-10T00:01:00Z", result: "absent", method: "item-permissions-read" });
  await store.writeAudit(config, { auditId: "od-audit-1", caseId: reviewId, eventType: "action-executed", actionId: "od-action-1", occurredAt: "2026-10-10T00:01:00Z" });
  assert.equal((await store.readActions(config, reviewId))[0].origin, "onedrive-review");
  assert.equal((await store.readVerifications(config, reviewId))[0].result, "absent");
  assert.equal((await store.readAuditTrail(config, reviewId))[0].eventType, "action-executed");
});

test("action confirmations can reserve an action once using an ETag", async (t) => {
  if (skip(t)) return;
  const action = { actionId: "reserve-action", caseId: "reserve-case", actionType: "remove-member", status: "proposed" };
  await store.writeAction(config, action);
  const found = await store.readActionForUpdate(config, action.caseId, action.actionId);
  assert.equal(found.record.status, "proposed");
  assert.equal(await store.updateActionIfUnchanged(config, { ...action, status: "executing", executionStartedAt: new Date().toISOString() }, found.etag), true);
  assert.equal(await store.updateActionIfUnchanged(config, { ...action, status: "verified" }, found.etag), false);
  assert.equal((await store.readActionForUpdate(config, action.caseId, action.actionId)).record.status, "executing");
});
