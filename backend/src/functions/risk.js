import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { actorFor } from "../lib/owner-access.js";
import { DEFAULT_DEFINITION } from "../lib/risk.js";
import { activateDefinition, DefinitionError, effectiveDefinition, previewDefinition } from "../lib/risk-definitions.js";
import { readChanges, readRiskDefinition, readRiskDefinitionHistory, readSnapshot, writeAudit, writeRiskDefinition } from "../lib/store.js";

// Risk definitions need the Approver role; reading them, previewing a change and reading drift
// need any governance reader role. A saved definition applies at the next collector run.

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

function failure(error, context, label) {
  if (error instanceof DefinitionError) return response({ error: error.message }, error.status);
  context.error(`${label} failed: ${error.message}`);
  return response({ error: `${label} failed.` }, 500);
}

async function getDefinition(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const [stored, history] = await Promise.all([readRiskDefinition(config), readRiskDefinitionHistory(config)]);
    return response({ source: "backend", active: effectiveDefinition(stored), isDefault: !stored, defaults: DEFAULT_DEFINITION, history });
  } catch (error) {
    return failure(error, context, "Loading the risk definition");
  }
}

async function preview(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    const { workspaces } = await readSnapshot(config);
    return response({ source: "backend", ...previewDefinition(workspaces, body) });
  } catch (error) {
    return failure(error, context, "Previewing the risk definition");
  }
}

async function saveDefinition(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, ["Approver"], { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body) return response({ error: "A request body is required." }, 400);

    const actor = actorFor(request, authorization.principal);
    const record = activateDefinition({ input: body, reason: body.reason, actor, current: await readRiskDefinition(config) });
    await writeRiskDefinition(config, record);
    await writeAudit(config, {
      auditId: `risk-definition-${record.definitionId}`, caseId: "risk-definition", eventType: "risk-definition-changed", version: record.version,
      actorId: actor.id, actorName: actor.name || null, occurredAt: record.changedAt, reason: record.reason
    });
    return response({ definition: record, appliesFrom: "the next collector run" }, 201);
  } catch (error) {
    return failure(error, context, "Saving the risk definition");
  }
}

async function changes(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const days = Math.min(Math.max(Number.parseInt(request.query.get("days") || "30", 10) || 30, 1), 365);
    const records = await readChanges(config, { days, workspaceId: request.query.get("workspaceId") || undefined });
    return response({ source: "backend", days, changes: records, meta: { count: records.length } });
  } catch (error) {
    return failure(error, context, "Loading changes");
  }
}

app.http("riskDefinition", { methods: ["GET"], authLevel: "anonymous", route: "api/risk/definition", handler: getDefinition });
app.http("riskDefinitionPreview", { methods: ["POST"], authLevel: "anonymous", route: "api/risk/definition/preview", handler: preview });
app.http("riskDefinitionSave", { methods: ["PUT"], authLevel: "anonymous", route: "api/risk/definition", handler: saveDefinition });
app.http("workspaceChanges", { methods: ["GET"], authLevel: "anonymous", route: "api/changes", handler: changes });
