import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { actorFor } from "../lib/owner-access.js";
import { createBaselineRecord, previewBaseline } from "../lib/baselines.js";
import {
  commitBaseline,
  readBaselineForUpdate,
  readBaselineHistory,
  readBaselines,
  readDriftAlertForUpdate,
  readDriftAlerts,
  readSnapshot,
  updateDriftAlertIfUnchanged,
  writeAudit,
} from "../lib/store.js";

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

async function list(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const [baselines, alerts, history] = await Promise.all([readBaselines(config), readDriftAlerts(config), readBaselineHistory(config)]);
    const open = alerts.filter((alert) => ["open", "acknowledged"].includes(alert.status));
    return response({ source: "backend", baselines, alerts: alerts.sort((a, b) => String(b.lastSeenAt || b.openedAt).localeCompare(String(a.lastSeenAt || a.openedAt))), history, meta: { baselines: baselines.length, openAlerts: open.length } });
  } catch (error) {
    context.error(`baseline API failed: ${error.message}`);
    return response({ error: "Baseline and drift data unavailable." }, 500);
  }
}

async function preview(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.workspaceId !== "string") return response({ error: "A workspaceId is required." }, 400);
    const { workspaces } = await readSnapshot(config);
    const workspace = workspaces.find((item) => item.id === body.workspaceId);
    if (!workspace) return response({ error: "Workspace not found in the current snapshot." }, 404);
    const current = await readBaselineForUpdate(config, workspace.id);
    return response({ source: "backend", preview: previewBaseline({ workspace, currentBaseline: current?.record }) });
  } catch (error) {
    context.error(`baseline preview failed: ${error.message}`);
    return response({ error: "Baseline preview unavailable." }, 500);
  }
}

async function approveBaseline(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, ["Approver"], { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) return response({ error: "A non-negative expectedVersion is required." }, 400);
    const { workspaces } = await readSnapshot(config);
    const workspace = workspaces.find((item) => item.id === request.params.workspaceId);
    if (!workspace) return response({ error: "Workspace not found in the current snapshot." }, 404);
    const current = await readBaselineForUpdate(config, workspace.id);
    if ((current?.record.version || 0) !== body.expectedVersion) return response({ error: "The baseline changed. Refresh and preview again." }, 409);
    const previewRecord = previewBaseline({ workspace, currentBaseline: current?.record });
    const actor = actorFor(request, authorization.principal);
    const baseline = createBaselineRecord({ preview: previewRecord, actor, reason: body.reason, current: current?.record });
      const saved = await commitBaseline(config, baseline, current?.etag || null);
    if (!saved) return response({ error: "The baseline changed. Refresh and preview again." }, 409);
    const audit = {
      auditId: `baseline-${baseline.baselineId}`, caseId: `baseline-${baseline.workspaceId}`, eventType: "drift-baseline-approved",
      workspaceId: baseline.workspaceId, workspaceName: baseline.workspaceName, version: baseline.version,
      actorId: actor.id, actorName: actor.name || null, occurredAt: baseline.approvedAt, reason: baseline.reason
    };
    await writeAudit(config, audit);
    return response({ baseline, audit }, current ? 200 : 201);
  } catch (error) {
    if (/at least 10 characters/.test(error.message)) return response({ error: error.message }, 400);
    context.error(`baseline approval failed: ${error.message}`);
    return response({ error: "Baseline could not be approved." }, 500);
  }
}

async function acknowledgeAlert(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, ["Governance.Operator"], { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) return response({ error: "A non-negative expectedVersion is required." }, 400);
    const found = await readDriftAlertForUpdate(config, request.params.alertId);
    if (!found) return response({ error: "Drift alert not found." }, 404);
    if (found.record.version !== body.expectedVersion) return response({ error: "The alert changed. Refresh and try again." }, 409);
    if (!["open", "acknowledged"].includes(found.record.status)) return response({ error: "Only an open alert can be acknowledged." }, 409);
    const actor = actorFor(request, authorization.principal);
    const now = new Date().toISOString();
    const alert = { ...found.record, status: "acknowledged", acknowledgedAt: now, acknowledgedBy: actor.id, acknowledgedByName: actor.name || null, version: found.record.version + 1 };
    if (!(await updateDriftAlertIfUnchanged(config, alert, found.etag))) return response({ error: "The alert changed. Refresh and try again." }, 409);
    await writeAudit(config, {
      auditId: `drift-ack-${alert.alertId}-${alert.cycle}`, caseId: `drift-${alert.alertId}`,
      eventType: "drift-alert-acknowledged", workspaceId: alert.workspaceId, actorId: actor.id,
      actorName: actor.name || null, occurredAt: now, reason: typeof body.reason === "string" ? body.reason.trim().slice(0, 500) || null : null
    });
    return response({ alert });
  } catch (error) {
    context.error(`drift alert acknowledgement failed: ${error.message}`);
    return response({ error: "Drift alert could not be acknowledged." }, 500);
  }
}

app.http("baselines", { methods: ["GET"], authLevel: "anonymous", route: "api/baselines", handler: list });
app.http("baselinePreview", { methods: ["POST"], authLevel: "anonymous", route: "api/baselines/preview", handler: preview });
app.http("baselineApprove", { methods: ["PUT"], authLevel: "anonymous", route: "api/baselines/{workspaceId}", handler: approveBaseline });
app.http("driftAlertAcknowledge", { methods: ["POST"], authLevel: "anonymous", route: "api/drift-alerts/{alertId}/acknowledge", handler: acknowledgeAlert });
