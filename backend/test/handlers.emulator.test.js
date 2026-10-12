import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { app } from "@azure/functions";
import { startEmulator } from "./helpers/emulator.js";
import * as store from "../src/lib/store.js";
import { buildMoverTask } from "../src/lib/movers.js";

// Calls the real HTTP handlers, with the real storage layer on the table emulator and a request
// carrying the same x-ms-client-principal header that Easy Auth adds. Handlers that call
// Microsoft Graph (members, sharing, provisioning) are covered in the library tests instead,
// because there is no Graph to call here.

const handlers = new Map();
const originalHttp = app.http;
let emulator;
let config;

before(async () => {
  emulator = await startEmulator();
  if (!emulator) return;
  Object.assign(process.env, {
    GRAPH_TENANT_ID: "tenant", STORAGE_TABLE_ENDPOINT: "http://127.0.0.1:1/unused", STORAGE_CONNECTION_STRING: emulator.connectionString
  });
  delete process.env.ALLOW_LOCAL_AUTH;
  app.http = (name, options) => { handlers.set(name, options.handler); };
  for (const file of ["owner", "requests", "risk", "notifications", "cases", "findings", "onedrive", "baselines", "collector"]) await import(`../src/functions/${file}.js`);
  process.env.EXECUTION_MODE = "dry-run";
  app.http = originalHttp;
  config = { storageConnectionString: emulator.connectionString, storageTableName: "workspaces" };
});
after(() => emulator?.stop());

const skip = (t) => { if (!emulator) { t.skip("Azurite is not available"); return true; } return false; };
const context = { log() {}, warn() {}, error() {} };

function call(name, { as, query = "", params = {}, body } = {}) {
  const headers = new Headers();
  if (as) {
    const claims = [{ typ: "oid", val: as.id }];
    if (String(as.name || "").includes("@")) claims.push({ typ: "preferred_username", val: as.name });
    const principal = { userId: as.id, userDetails: as.name || as.id, userRoles: as.roles, claims };
    headers.set("x-ms-client-principal", Buffer.from(JSON.stringify(principal)).toString("base64"));
  }
  return handlers.get(name)({ headers, query: new URLSearchParams(query), params, json: async () => { if (body === undefined) throw new Error("no body"); return body; } }, context);
}
const person = (id, ...roles) => ({ id, name: id, roles });
const ownerA = person("owner-a", "Workspace.Owner");
const ownerB = person("owner-b", "Workspace.Owner");
const reader = person("reader", "Governance.Reader");
const operator = person("operator-1", "Governance.Operator");
const operator2 = person("operator-2", "Governance.Operator");
const approver = person("approver", "Approver");

const wsTask = (id, workspaceId, assignee) => ({ taskId: id, taskType: "renewal", workspaceId, workspaceName: workspaceId, cycle: 1, status: "open", version: 0, steps: {}, assigneeKind: "owners", assigneeIds: [assignee], dueAt: "2099-01-01T00:00:00Z", escalationLevel: 0, escalationHistory: [], assignmentHistory: [] });

test("handlers register and refuse unauthenticated callers", async (t) => {
  if (skip(t)) return;
  for (const name of ["ownerTasks", "ownerTaskDetail", "requests", "riskDefinition", "notifications", "ownerMoverDecision", "ownerLifecycleExecute", "cases", "case-detail", "case-transition", "findings", "policies", "oneDriveInventory", "oneDriveReview", "oneDriveSharing", "oneDriveSharingPropose", "oneDriveSharingConfirm", "baselines", "baselinePreview", "baselineApprove", "driftAlertAcknowledge", "collectorRun"]) assert.ok(handlers.has(name), `${name} is registered`);
  assert.equal((await call("ownerTasks")).status, 401);
  assert.equal((await call("requests")).status, 401);
  assert.equal((await call("notifications")).status, 401);
  assert.equal((await call("cases")).status, 401);
  assert.equal((await call("findings")).status, 401);
  assert.equal((await call("oneDriveInventory")).status, 401);
  assert.equal((await call("baselines")).status, 401);
  assert.equal((await call("collectorRun")).status, 401);
  assert.equal((await call("collectorRun", { as: reader })).status, 403);
  assert.equal((await call("oneDriveSharing", { query: "siteKey=https%3A%2F%2Fcontoso-my.sharepoint.com%2Fpersonal%2Fa" })).status, 401);
});

test("baseline approval is Approver-only; operators acknowledge drift without resetting it", async (t) => {
  if (skip(t)) return;
  const workspaceId = "baseline-w1";
  await store.writeSnapshot(config, [{ id: workspaceId, name: "Baseline workspace", type: "Private team", owners: ["A", "B"], guests: 1, shadowUsers: { count: 0 }, exposure: "Low", labels: ["Internal"] }], { collectedAt: new Date().toISOString(), status: "ok" });
  assert.equal((await call("baselinePreview", { as: reader, body: { workspaceId } })).status, 200);
  assert.equal((await call("baselineApprove", { as: operator, params: { workspaceId }, body: { expectedVersion: 0, reason: "Approved after review by governance." } })).status, 403);
  const approved = await call("baselineApprove", { as: approver, params: { workspaceId }, body: { expectedVersion: 0, reason: "Approved after review by the accountable owner." } });
  assert.equal(approved.status, 201);
  assert.equal(approved.jsonBody.baseline.version, 1);
  assert.equal((await call("baselineApprove", { as: approver, params: { workspaceId }, body: { expectedVersion: 0, reason: "This stale baseline cannot be saved." } })).status, 409);

  await store.writeDriftAlert(config, { alertId: "baseline-w1-guests", workspaceId, workspaceName: "Baseline workspace", status: "open", version: 1, cycle: 1 });
  assert.equal((await call("driftAlertAcknowledge", { as: reader, params: { alertId: "baseline-w1-guests" }, body: { expectedVersion: 1 } })).status, 403);
  const ack = await call("driftAlertAcknowledge", { as: operator, params: { alertId: "baseline-w1-guests" }, body: { expectedVersion: 1, reason: "The owner is following up." } });
  assert.equal(ack.status, 200);
  assert.equal(ack.jsonBody.alert.status, "acknowledged");
  assert.equal((await store.readBaselineForUpdate(config, workspaceId)).record.version, 1);
  assert.equal((await call("driftAlertAcknowledge", { as: operator, params: { alertId: "baseline-w1-guests" }, body: { expectedVersion: 1 } })).status, 409);
});

test("only Executors can run an approved lifecycle decision and default mode records a dry run", async (t) => {
  if (skip(t)) return;
  const workspaceId = "lifecycle-team";
  const collectedAt = new Date().toISOString();
  await store.writeSnapshot(config, [{ id: workspaceId, name: "Lifecycle workspace", type: "Private team", owners: ["A", "B"], guests: 0, legalHold: false, retentionLocked: false, evidence: { generatedAt: collectedAt } }], { collectedAt, status: "ok" });
  const task = { taskId: "lifecycle-task", workspaceId, workspaceName: "Lifecycle workspace", status: "decided", version: 2, dueAt: "2099-01-01T00:00:00Z", cycle: 1, assigneeIds: ["owner-a"], assigneeKind: "owners", steps: {}, lifecycleExecutionStatus: null, decision: { decisionId: "lifecycle-decision", choice: "archive", status: "approved-not-executed" } };
  await store.createTaskIfAbsent(config, task);
  const decision = { decisionId: "lifecycle-decision", taskId: task.taskId, workspaceId, workspaceName: task.workspaceName, choice: "archive", status: "approved-not-executed", executionStatus: "not-executed", requiresSecondApprover: true, decidedBy: "owner-a", reviewedBy: "approver", version: 2 };
  await store.writeDecision(config, decision);
  const execute = (as, expectedVersion, confirmation) => call("ownerLifecycleExecute", { as, params: { taskId: task.taskId, decisionId: decision.decisionId }, body: { expectedVersion, confirmation } });
  assert.equal((await execute(operator, 2, "ARCHIVE Lifecycle workspace")).status, 403);
  assert.equal((await execute(person("executor", "Executor"), 2, "ARCHIVE wrong workspace")).status, 400);
  const response = await execute(person("executor", "Executor"), 2, "ARCHIVE Lifecycle workspace");
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.executionMode, "dry-run");
  assert.equal(response.jsonBody.decision.executionStatus, "simulated");
  assert.equal((await store.readTaskForUpdate(config, task.taskId)).record.lifecycleExecutionStatus, "simulated");
  const previousMode = process.env.EXECUTION_MODE;
  process.env.EXECUTION_MODE = "live";
  process.env.ENABLE_LIFECYCLE_EXECUTION = "false";
  const disabledLive = await execute(person("executor", "Executor"), 3, "ARCHIVE Lifecycle workspace");
  assert.equal(disabledLive.status, 403);
  if (previousMode === undefined) delete process.env.EXECUTION_MODE; else process.env.EXECUTION_MODE = previousMode;
  delete process.env.ENABLE_LIFECYCLE_EXECUTION;
  assert.equal((await execute(person("executor", "Executor"), 2, "ARCHIVE Lifecycle workspace")).status, 409);
});

test("OneDrive inventory is read-gated and only its owner or an operator can save a review", async (t) => {
  if (skip(t)) return;
  const url = "https://contoso-my.sharepoint.com/personal/alex_contoso_com";
  const generatedAt = new Date().toISOString();
  await store.writeOneDriveInventory(config, {
    generatedAt,
    complete: true,
    sites: [{ siteKey: url, url, title: "Alex Personal Site", ownerUpn: "alex@contoso.com", lastActivityAt: generatedAt, sharingCapability: "Anyone", storageMb: 100, lockState: "Unlock", status: "Active" }]
  });
  const unrelatedOwner = await call("oneDriveInventory", { as: ownerA });
  assert.equal(unrelatedOwner.status, 200);
  assert.deepEqual(unrelatedOwner.jsonBody.sites, []);
  const owner = person("one-drive-owner", "Workspace.Owner");
  owner.name = "alex@contoso.com";
  const ownerView = await call("oneDriveInventory", { as: owner });
  assert.equal(ownerView.jsonBody.sites.length, 1);
  assert.equal(ownerView.jsonBody.sites[0].ownerUpn, "alex@contoso.com");
  const inventory = await call("oneDriveInventory", { as: reader });
  assert.equal(inventory.status, 200);
  assert.equal(inventory.jsonBody.sites[0].flags.includes("External sharing enabled"), true);
  assert.equal((await call("oneDriveSharingPropose", { as: reader, body: { siteKey: url, targets: [{ itemId: "i", permissionId: "p" }] } })).status, 403);
  const previousMode = process.env.EXECUTION_MODE;
  const previousOneDriveEnable = process.env.ENABLE_ONEDRIVE_SHARING_REVOCATION;
  process.env.EXECUTION_MODE = "live";
  delete process.env.ENABLE_ONEDRIVE_SHARING_REVOCATION;
  assert.equal((await call("oneDriveSharingConfirm", { as: ownerA, params: { caseId: "no-case", actionId: "no-action" }, body: {} })).status, 403);
  process.env.ENABLE_ONEDRIVE_SHARING_REVOCATION = "true";
  assert.equal((await call("oneDriveSharingConfirm", { as: owner, params: { caseId: "no-case", actionId: "no-action" }, body: {} })).status, 403);
  if (previousMode === undefined) delete process.env.EXECUTION_MODE; else process.env.EXECUTION_MODE = previousMode;
  if (previousOneDriveEnable === undefined) delete process.env.ENABLE_ONEDRIVE_SHARING_REVOCATION; else process.env.ENABLE_ONEDRIVE_SHARING_REVOCATION = previousOneDriveEnable;

  const review = (as, expectedVersion = 0) => call("oneDriveReview", { as, body: { siteKey: url, outcome: "retain", reason: "Reviewed sharing settings with owner.", expectedVersion } });
  assert.equal((await review(ownerA)).status, 403);
  assert.equal((await review(owner)).status, 201);
  assert.equal((await review(owner)).status, 409);
  const saved = await call("oneDriveInventory", { as: reader });
  assert.equal(saved.jsonBody.sites[0].review.outcome, "retain");

  const operatorUpdate = await call("oneDriveReview", { as: operator, body: { siteKey: url, outcome: "escalate", reason: "Please confirm business need and external sharing.", expectedVersion: 1 } });
  assert.equal(operatorUpdate.status, 200);
  assert.equal((await call("oneDriveInventory", { as: reader })).jsonBody.sites[0].review.outcome, "escalate");
});

test("findings and cases handlers expose findings, role-available actions, and audited transitions", async (t) => {
  if (skip(t)) return;
  const finding = {
    findingId: "finding-ui-1", resourceId: "w-ui", resourceName: "UI Workspace", title: "Two owners",
    policyId: "workspace-owner-minimum-two", severity: "high", status: "active", complianceStatus: "attention",
    observed: "1 owner", expected: "Two or more", evidence: { owners: ["owner-a"] }
  };
  const caseRecord = {
    caseId: "case-ui-1", caseType: "workspace-governance", findingId: finding.findingId, resourceId: finding.resourceId,
    resourceName: finding.resourceName, policyId: finding.policyId, title: finding.title, severity: "high",
    rationale: "Test rationale", recommendedAction: "Assign a second owner", status: "detected", version: 0,
    detectedAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z"
  };
  await store.writeFinding(config, finding);
  await store.createCaseIfAbsent(config, caseRecord);

  const readFindings = await call("findings", { as: reader, query: "status=active" });
  assert.equal(readFindings.status, 200);
  assert.ok(readFindings.jsonBody.findings.some(item => item.findingId === finding.findingId));

  const casesForReader = await call("cases", { as: reader });
  assert.deepEqual(casesForReader.jsonBody.cases.find(item => item.caseId === caseRecord.caseId).availableTransitions, []);
  const casesForOperator = await call("cases", { as: operator });
  assert.deepEqual(casesForOperator.jsonBody.cases.find(item => item.caseId === caseRecord.caseId).availableTransitions, ["triage", "cancel"]);
  const detail = await call("case-detail", { as: operator, params: { caseId: caseRecord.caseId } });
  assert.equal(detail.status, 200);
  assert.equal(detail.jsonBody.findingId, undefined);
  assert.deepEqual(detail.jsonBody.availableTransitions, ["triage", "cancel"]);

  const moved = await call("case-transition", { as: operator, params: { caseId: caseRecord.caseId }, body: { transition: "triage", expectedVersion: 0, reason: "Reviewed evidence" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.jsonBody.case.status, "triaged");
  assert.equal((await store.readCaseDetail(config, caseRecord.caseId)).auditTrail.length, 1);
  assert.equal((await call("case-transition", { as: operator, params: { caseId: caseRecord.caseId }, body: { transition: "triage", expectedVersion: 0 } })).status, 409);
});

test("owners only see their own tasks, and only governance roles can ask for all", async (t) => {
  if (skip(t)) return;
  await store.createTaskIfAbsent(config, wsTask("ws-a-c1", "wa", "owner-a"));
  await store.createTaskIfAbsent(config, wsTask("ws-b-c1", "wb", "owner-b"));
  const mine = await call("ownerTasks", { as: ownerA });
  assert.deepEqual(mine.jsonBody.tasks.map((task) => task.taskId).sort(), ["lifecycle-task", "ws-a-c1"]);
  assert.equal((await call("ownerTasks", { as: ownerA, query: "scope=all" })).status, 403);
  assert.equal((await call("ownerTasks", { as: reader, query: "scope=all" })).jsonBody.tasks.length >= 3, true);
  assert.equal((await call("ownerTaskDetail", { as: ownerB, params: { taskId: "ws-a-c1" } })).status, 403);
  assert.equal((await call("ownerTaskDetail", { as: reader, params: { taskId: "ws-a-c1" } })).status, 200);
  assert.equal((await call("ownerTaskDetail", { as: reader, params: { taskId: "nope" } })).status, 404);
});

test("owner writes need an assignment and the current version", async (t) => {
  if (skip(t)) return;
  const step = (as, expectedVersion, taskId = "ws-a-c1") => call("ownerTaskStep", { as, params: { taskId, step: "contacts" }, body: { expectedVersion, data: { primary: "Ann Lee", secondary: "Bo Kim" } } });
  assert.equal((await step(reader, 0)).status, 403);
  assert.equal((await step(ownerB, 0)).status, 403);
  assert.equal((await step(ownerA, 5)).status, 409);
  const saved = await step(ownerA, 0);
  assert.equal(saved.status, 200);
  assert.equal(saved.jsonBody.task.version, 1);
  assert.equal((await step(ownerA, 0)).status, 409);
  assert.equal((await call("ownerTaskStep", { as: ownerA, params: { taskId: "ws-a-c1", step: "contacts" } })).status, 400);
});

test("a manager's mover decision becomes a pending removal on the workspace review", async (t) => {
  if (skip(t)) return;
  const manager = person("mgr-1", "Workspace.Owner");
  const mover = buildMoverTask({
    roleChange: { caseId: "rc-9", userId: "mover-user", userDisplayName: "Pat", allowedResourceIds: [], after: { managerId: "mgr-1" } },
    memberships: [{ workspaceId: "wa", workspaceName: "WS A", access: "member" }], itemsSource: "graph"
  });
  assert.equal(await store.createTaskIfAbsent(config, mover), true);
  const submit = (as, decisions) => call("ownerMoverDecision", { as, params: { taskId: mover.taskId }, body: { expectedVersion: 0, decisions } });

  assert.equal((await submit(ownerA, [{ workspaceId: "wa", choice: "remove" }])).status, 403);
  assert.equal((await submit(manager, [])).status, 400);
  const decided = await submit(manager, [{ workspaceId: "wa", choice: "remove" }]);
  assert.equal(decided.status, 200);
  assert.equal(decided.jsonBody.removalRequests, 1);

  const pending = await store.readActions(config, "ws-a-c1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].origin, "role-change");
  assert.equal(pending[0].status, "proposed");
  assert.equal((await store.readTaskForUpdate(config, mover.taskId)).record.status, "decided");
  assert.equal((await store.readDecisions(config)).some((item) => item.taskId === mover.taskId), true);
  assert.equal((await call("ownerMoverDecision", { as: manager, params: { taskId: mover.taskId }, body: { expectedVersion: 1, decisions: [] } })).status, 409);
});

test("a removal that already ran is not reopened by a later mover decision", async (t) => {
  if (skip(t)) return;
  const manager = person("mgr-2", "Workspace.Owner");
  await store.createTaskIfAbsent(config, wsTask("ws-c-c1", "wc", "owner-a"));
  await store.writeAction(config, { actionId: "ws-c-c1-rm-user-2", caseId: "ws-c-c1", status: "verified", actionType: "remove-member" });
  const mover = buildMoverTask({
    roleChange: { caseId: "rc-10", userId: "user-2", userDisplayName: "Sam", allowedResourceIds: [], after: { managerId: "mgr-2" } },
    memberships: [{ workspaceId: "wc", workspaceName: "WS C", access: "member" }], itemsSource: "graph"
  });
  await store.createTaskIfAbsent(config, mover);
  const result = await call("ownerMoverDecision", { as: manager, params: { taskId: mover.taskId }, body: { expectedVersion: 0, decisions: [{ workspaceId: "wc", choice: "remove" }] } });
  assert.equal(result.status, 200);
  assert.equal((await store.readActions(config, "ws-c-c1"))[0].status, "verified");
});

test("requests: the requester cannot decide their own, a second operator can, and only an executor provisions", async (t) => {
  if (skip(t)) return;
  const submitted = await call("requestSubmit", { as: ownerA, body: { templateId: "project-team", name: "Project Apollo", purpose: "Coordinate the Apollo launch work.", owners: ["a@example.com", "b@example.com"], visibility: "Private" } });
  if (submitted.status !== 201) assert.fail(`submit failed: ${JSON.stringify(submitted.jsonBody)}`);
  const id = submitted.jsonBody.request.requestId;
  assert.equal((await call("requests", { as: ownerA })).jsonBody.requests.length, 1);
  assert.equal((await call("requests", { as: ownerB })).jsonBody.requests.length, 0);

  const decide = (as, outcome = "approve") => call("requestDecision", { as, params: { requestId: id }, body: { outcome, reason: "Looks fine to me" } });
  assert.equal((await decide(ownerA)).status, 403);
  assert.equal((await decide(reader)).status, 403);
  const opSelf = await call("requestSubmit", { as: operator, body: { templateId: "project-team", name: "Operator Project", purpose: "Own request by an operator here.", owners: ["a@example.com", "b@example.com"], visibility: "Private" } });
  assert.equal((await call("requestDecision", { as: operator, params: { requestId: opSelf.jsonBody.request.requestId }, body: { outcome: "approve" } })).status, 403);
  assert.equal((await decide(operator2)).status, 200);
  assert.equal((await decide(operator2)).status, 409);
  assert.equal((await call("requestProvision", { as: operator2, params: { requestId: id } })).status, 403);
});

test("only an approver can change the risk definition, and any governance reader can read it", async (t) => {
  if (skip(t)) return;
  assert.equal((await call("riskDefinition", { as: reader })).status, 200);
  assert.equal((await call("riskDefinition", { as: ownerA })).status, 403);
  const save = (as) => call("riskDefinitionSave", { as, body: { weights: {}, thresholds: {} } });
  assert.equal((await save(reader)).status, 403);
  assert.equal((await save(operator)).status, 403);
  assert.notEqual((await save(approver)).status, 403);
});

test("notification history is for governance roles and never includes addresses or recipient ids", async (t) => {
  if (skip(t)) return;
  await store.writeNotification(config, { dedupeKey: "k1", event: "assigned", workspaceName: "WS", recipientId: "owner-a", recipientName: "Owner A", mail: "secret@example.com", status: "simulated", updatedAt: "2025-01-01T00:00:00Z" });
  assert.equal((await call("notifications", { as: ownerA })).status, 403);
  const result = await call("notifications", { as: reader });
  assert.equal(result.status, 200);
  assert.equal(result.jsonBody.notifications.length, 1);
  assert.equal("recipientId" in result.jsonBody.notifications[0], false);
});
