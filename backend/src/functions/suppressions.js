import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { actorFor } from "../lib/owner-access.js";
import { createSuppression, revokeSuppression, SuppressionError } from "../lib/suppressions.js";
import { readSnapshot, readSuppression, readSuppressions, writeAudit, writeSuppression } from "../lib/store.js";

// False-positive tags. They hide a violation from the open counts for a limited time; the
// finding itself is never edited. Tagging and revoking need Governance.Operator.

const OPERATOR_ROLES = ["Governance.Operator"];

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

function failure(error, context, label) {
  if (error instanceof SuppressionError) return response({ error: error.message }, error.status);
  context.error(`${label} failed: ${error.message}`);
  return response({ error: `${label} failed.` }, 500);
}

async function listSuppressions(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const suppressions = await readSuppressions(config);
    return response({ source: "backend", suppressions, meta: { count: suppressions.length } });
  } catch (error) {
    return failure(error, context, "Loading false-positive tags");
  }
}

async function tagFalsePositive(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, OPERATOR_ROLES, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body) return response({ error: "A request body is required." }, 400);

    const { workspaces } = await readSnapshot(config);
    const workspace = workspaces.find((item) => item.id === body.workspaceId);
    const factor = workspace?.health?.factors?.find((item) => item.policyId === body.policyId);
    const actor = actorFor(request, authorization.principal);
    const record = createSuppression({
      workspaceId: body.workspaceId,
      policyId: body.policyId,
      reason: body.reason,
      days: body.days,
      actor,
      violationExists: factor?.status === "attention"
    });
    await writeSuppression(config, record);
    await writeAudit(config, {
      auditId: `${record.suppressionId}-${Date.parse(record.createdAt)}`, caseId: `suppression-${record.suppressionId}`, eventType: "false-positive-tagged",
      workspaceId: record.workspaceId, policyId: record.policyId, actorId: actor.id, actorName: actor.name || null, occurredAt: record.createdAt, expiresAt: record.expiresAt
    });
    return response({ suppression: record }, 201);
  } catch (error) {
    return failure(error, context, "Tagging the false positive");
  }
}

async function revoke(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, OPERATOR_ROLES, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const existing = await readSuppression(config, request.params.suppressionId);
    if (!existing) return response({ error: "Tag not found." }, 404);
    const actor = actorFor(request, authorization.principal);
    const record = revokeSuppression(existing, actor);
    await writeSuppression(config, record);
    await writeAudit(config, {
      auditId: `${record.suppressionId}-revoked-${Date.parse(record.revokedAt)}`, caseId: `suppression-${record.suppressionId}`, eventType: "false-positive-revoked",
      workspaceId: record.workspaceId, policyId: record.policyId, actorId: actor.id, actorName: actor.name || null, occurredAt: record.revokedAt
    });
    return response({ suppression: record });
  } catch (error) {
    return failure(error, context, "Revoking the tag");
  }
}

app.http("suppressions", { methods: ["GET"], authLevel: "anonymous", route: "api/suppressions", handler: listSuppressions });
app.http("suppressionCreate", { methods: ["POST"], authLevel: "anonymous", route: "api/suppressions", handler: tagFalsePositive });
app.http("suppressionRevoke", { methods: ["POST"], authLevel: "anonymous", route: "api/suppressions/{suppressionId}/revoke", handler: revoke });
