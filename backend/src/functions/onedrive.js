import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { actorFor } from "../lib/owner-access.js";
import { createGraphClient } from "../lib/graph.js";
import { executeAction, ExecutionRuleError } from "../lib/execution.js";
import { oneDriveReviewId, proposeOneDriveRevocations, scanOneDriveSharing } from "../lib/onedrive-sharing.js";
import {
  createOneDriveReviewIfAbsent,
  readOneDriveInventory,
  readOneDriveReview,
  readOneDriveReviews,
  readActions,
  readActionForUpdate,
  createActionIfAbsent,
  writeAction,
  updateActionIfUnchanged,
  writeVerification,
  updateOneDriveReviewIfUnchanged,
  writeAudit
} from "../lib/store.js";

const REVIEW_ROLES = ["Governance.Operator", "Workspace.Owner"];
const OUTCOMES = new Set(["retain", "owner-follow-up", "escalate"]);
const DAY = 86_400_000;

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

function siteKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch { return null; }
}

function statusOf(site, review, now = new Date()) {
  const flags = [];
  const sharing = site.sharingCapability;
  if (["Anyone", "ExternalUserAndGuestSharing", "ExternalUserSharingOnly", "ExistingExternalUserSharingOnly"].includes(sharing)) flags.push("External sharing enabled");
  if (!site.ownerUpn) flags.push("Owner unknown");
  const age = site.lastActivityAt ? Math.floor((now - new Date(site.lastActivityAt)) / DAY) : null;
  if (age !== null && age >= 180) flags.push("No activity for 180+ days");
  if (site.lockState && site.lockState.toLowerCase() !== "unlock") flags.push(`Site state: ${site.lockState}`);
  return { ageDays: age, flags, reviewStatus: review?.outcome || "not-reviewed" };
}

async function listOneDrive(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, [...TENANT_READER_ROLES, "Workspace.Owner"], { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const [sites, reviews] = await Promise.all([readOneDriveInventory(config), readOneDriveReviews(config)]);
    const principal = authorization.principal;
    const canReadTenant = principal.roles.some(role => TENANT_READER_ROLES.includes(role));
    const signedInUpn = principal.upn?.toLowerCase() || null;
    const visibleSites = canReadTenant ? sites : sites.filter(site => site.ownerUpn && signedInUpn && site.ownerUpn.toLowerCase() === signedInUpn);
    const visibleKeys = new Set(visibleSites.map(site => site.siteKey));
    const byKey = new Map(reviews.filter(review => visibleKeys.has(review.siteKey)).map((review) => [review.siteKey, review]));
    const data = visibleSites.map((site) => {
      const review = byKey.get(site.siteKey) || null;
      return { ...site, review, ...statusOf(site, review) };
    });
    const generatedAt = sites.reduce((latest, site) => !latest || site.generatedAt > latest ? site.generatedAt : latest, null);
    const staleHours = generatedAt ? Math.max(0, Math.round((Date.now() - new Date(generatedAt)) / 3_600_000)) : null;
    return response({ source: "backend", generatedAt, staleHours, stale: staleHours === null || staleHours > config.evidenceMaxAgeHours, sites: data, meta: { count: data.length } });
  } catch (error) {
    context.error(`OneDrive inventory API failed: ${error.message}`);
    return response({ error: "OneDrive inventory unavailable." }, 500);
  }
}

async function submitReview(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, REVIEW_ROLES, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    const key = siteKey(body?.siteKey);
    if (!key) return response({ error: "A valid HTTPS SharePoint personal-site URL is required." }, 400);
    const sites = await readOneDriveInventory(config);
    const site = sites.find((item) => item.siteKey === key);
    if (!site) return response({ error: "OneDrive site not found in the current inventory." }, 404);
    if (!site.generatedAt || Date.now() - new Date(site.generatedAt).getTime() > config.evidenceMaxAgeHours * 3_600_000) {
      return response({ error: "The OneDrive export is stale. Refresh the SharePoint admin export before recording a review." }, 409);
    }

    const actor = actorFor(request, authorization.principal);
    const isOperator = actor.roles.includes("Governance.Operator");
    const ownerAccess = isOperator || Boolean(actor.upn && site.ownerUpn && actor.upn.toLowerCase() === site.ownerUpn.toLowerCase());
    if (!ownerAccess) return response({ error: "Only the OneDrive owner or a governance operator can record this review." }, 403);

    if (!body || !OUTCOMES.has(body.outcome)) return response({ error: "Choose retain, owner-follow-up, or escalate." }, 400);
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) return response({ error: "A non-negative expectedVersion is required." }, 400);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    if (reason.length < 10) return response({ error: "Enter at least 10 characters of review rationale." }, 400);

    const existing = await readOneDriveReview(config, key);
    const currentVersion = existing?.record.version || 0;
    if (currentVersion !== body.expectedVersion) return response({ error: "The review changed. Reload and try again." }, 409);
    const now = new Date().toISOString();
    const record = {
      siteKey: key,
      ownerUpn: site.ownerUpn || null,
      outcome: body.outcome,
      reason,
      version: currentVersion + 1,
      reviewedAt: now,
      reviewedById: actor.id,
      reviewedByName: actor.name || null
    };
    const saved = existing
      ? await updateOneDriveReviewIfUnchanged(config, record, existing.etag)
      : await createOneDriveReviewIfAbsent(config, record);
    if (!saved) return response({ error: "The review changed. Reload and try again." }, 409);

    const reviewId = `onedrive-${Buffer.from(key).toString("base64url").slice(0, 100)}-v${record.version}`;
    await writeAudit(config, {
      auditId: reviewId,
      caseId: `onedrive-${Buffer.from(key).toString("base64url").slice(0, 100)}`,
      eventType: "onedrive-review-recorded",
      actorId: actor.id,
      actorName: actor.name || null,
      outcome: record.outcome,
      occurredAt: now,
      reason
    });
    return response({ review: record }, existing ? 200 : 201);
  } catch (error) {
    context.error(`OneDrive review failed: ${error.message}`);
    return response({ error: "OneDrive review could not be recorded." }, 500);
  }
}

async function accessibleSite(request, config, siteKey) {
  const authorization = authorize(request, [...TENANT_READER_ROLES, ...REVIEW_ROLES], { allowLocal: false });
  if (!authorization.ok) return { error: response({ error: authorization.error }, authorization.status) };
  const actor = actorFor(request, authorization.principal);
  const sites = await readOneDriveInventory(config);
  const site = sites.find(item => item.siteKey === siteKey);
  if (!site) return { error: response({ error: "OneDrive site not found in the current inventory." }, 404) };
  const governance = actor.roles.some(role => TENANT_READER_ROLES.includes(role));
  const isOwner = governance || Boolean(actor.upn && site.ownerUpn && actor.upn.toLowerCase() === site.ownerUpn.toLowerCase());
  if (!isOwner) {
    return { error: response({ error: "Only the OneDrive owner or a governance operator can access this review." }, 403) };
  }
  if (!site.generatedAt || Date.now() - new Date(site.generatedAt).getTime() > config.evidenceMaxAgeHours * 3_600_000) {
    return { error: response({ error: "The OneDrive export is stale. Refresh the SharePoint admin export before continuing." }, 409) };
  }
  return { site, actor, isOwner };
}

async function sharing(request, context) {
  try {
    const config = getConfig();
    const key = siteKey(request.query.get("siteKey"));
    if (!key) return response({ error: "A valid HTTPS personal-site URL is required." }, 400);
    const access = await accessibleSite(request, config, key);
    if (access.error) return access.error;
    const scan = await scanOneDriveSharing({ graph: createGraphClient(config), site: access.site });
    const actions = await readActions(config, oneDriveReviewId(key));
    const { driveId, ownerId, ...visibleScan } = scan;
    const executionMode = config.executionMode === "live" && config.oneDriveSharingRevocationEnabled && config.executorClientId ? "live" : "dry-run";
    return response({ source: "backend", executionMode, ...visibleScan, actions: actions.filter(action => action.origin === "onedrive-review").map(({ driveId: _driveId, ...action }) => action) });
  } catch (error) {
    if (error instanceof ExecutionRuleError) return response({ error: error.message }, error.status);
    context.error(`OneDrive sharing scan failed: ${error.message}`);
      return response({ error: error?.status === 403 ? "OneDrive scan needs the collector's Files.Read.All permission." : "OneDrive sharing scan unavailable." }, error?.status === 403 ? 409 : 500);
  }
}

async function proposeSharingRevocations(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, REVIEW_ROLES, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    const key = siteKey(body?.siteKey);
    if (!body || !key) return response({ error: "A valid personal-site URL and selected permissions are required." }, 400);
    const access = await accessibleSite(request, config, key);
    if (access.error) return access.error;
    const graph = createGraphClient(config);
    const scan = await scanOneDriveSharing({ graph, site: access.site });
    const { actions, rejected } = await proposeOneDriveRevocations({ site: access.site, scan, targets: body.targets, actor: access.actor, reason: body.reason });
    const responseActions = [];
    for (const action of actions) {
      const created = await createActionIfAbsent(config, action);
      if (!created) {
        const existing = await readActionForUpdate(config, action.caseId, action.actionId);
        if (existing) responseActions.push(existing.record);
        continue;
      }
      responseActions.push(action);
      await writeAudit(config, {
        auditId: `${action.actionId}-proposed`, caseId: action.caseId,
        eventType: "onedrive-permission-revocation-proposed", actionId: action.actionId,
        workspaceId: action.workspaceId, permissionId: action.permissionId, actorId: access.actor.id,
        actorName: access.actor.name || null, occurredAt: action.requestedAt
      });
    }
    const executionMode = config.executionMode === "live" && config.oneDriveSharingRevocationEnabled && config.executorClientId ? "live" : "dry-run";
    return response({
      executionMode,
      actions: responseActions.map(({ driveId: _driveId, ...action }) => action),
      rejected,
      truncated: scan.truncated,
      scannedItems: scan.scannedItems
    });
  } catch (error) {
    if (error instanceof ExecutionRuleError) return response({ error: error.message }, error.status);
    context.error(`OneDrive revocation proposal failed: ${error.message}`);
    return response({ error: "OneDrive revocation could not be proposed." }, 500);
  }
}

async function confirmSharingRevocation(request, context) {
  try {
    const config = getConfig();
    const live = config.executionMode === "live";
    if (live && !config.oneDriveSharingRevocationEnabled) return response({ error: "Live OneDrive sharing revocation is not enabled by the tenant administrator." }, 403);
    const authorization = authorize(request, live ? ["Executor"] : REVIEW_ROLES, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const actionId = request.params.actionId;
    const foundAction = await readActionForUpdate(config, request.params.caseId, actionId);
    const action = foundAction?.record;
    if (!action || action.origin !== "onedrive-review") return response({ error: "OneDrive revocation action not found." }, 404);
    if (!["proposed", "failed", "simulated"].includes(action.status)) return response({ error: `This action is already ${action.status}.` }, 409);
    const access = await accessibleSite(request, config, action.workspaceId);
    if (access.error) return access.error;
    if (action.targetUserId && action.targetUserId === access.actor.id) return response({ error: "You cannot revoke your own access." }, 403);
    if (live && !config.executorClientId) return response({ error: "Live execution is on but no executor identity is configured." }, 409);
    const graph = live
      ? createGraphClient(config, { clientId: config.executorClientId, writable: true })
      : createGraphClient(config);
    const reserved = { ...action, status: "executing", executionStartedAt: new Date().toISOString(), executionStartedBy: access.actor.id };
    if (!(await updateActionIfUnchanged(config, reserved, foundAction.etag))) return response({ error: "Another confirmation started first. Refresh the action list." }, 409);
    const result = await executeAction({ action, actor: access.actor, graph, mode: live ? "live" : "dry-run" });
    await writeAction(config, result.action);
    await writeVerification(config, result.verification);
    await writeAudit(config, result.audit);
    return response({ executionMode: config.executionMode, action: result.action, verification: result.verification });
  } catch (error) {
    if (error instanceof ExecutionRuleError) return response({ error: error.message }, error.status);
    context.error(`OneDrive revocation confirmation failed: ${error.message}`);
    return response({ error: "OneDrive revocation could not be confirmed." }, 500);
  }
}

app.http("oneDriveInventory", { methods: ["GET"], authLevel: "anonymous", route: "api/onedrive", handler: listOneDrive });
app.http("oneDriveReview", { methods: ["POST"], authLevel: "anonymous", route: "api/onedrive/review", handler: submitReview });
app.http("oneDriveSharing", { methods: ["GET"], authLevel: "anonymous", route: "api/onedrive/sharing", handler: sharing });
app.http("oneDriveSharingPropose", { methods: ["POST"], authLevel: "anonymous", route: "api/onedrive/sharing/proposals", handler: proposeSharingRevocations });
app.http("oneDriveSharingConfirm", { methods: ["POST"], authLevel: "anonymous", route: "api/onedrive/sharing/{caseId}/actions/{actionId}/confirm", handler: confirmSharingRevocation });
