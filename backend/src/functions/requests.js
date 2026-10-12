import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize } from "../lib/auth.js";
import { actorFor } from "../lib/owner-access.js";
import { CATALOG, createRequest, decideRequest, RequestError, visibleRequests } from "../lib/requests.js";
import { createRequestIfAbsent, readRequestForUpdate, readRequests, updateRequestIfUnchanged, writeAudit, writeVerification } from "../lib/store.js";
import { createGraphClient } from "../lib/graph.js";
import { provisionWorkspace, ProvisioningError } from "../lib/provisioning.js";

// Self-service workspace requests. Submitting and viewing your own requests needs only an
// assigned role; deciding needs Governance.Operator. Approval is recorded only: nothing here
// creates a workspace.

const REQUESTER_ROLES = ["Workspace.Owner", "Governance.Reader", "Governance.Operator", "Approver", "Executor", "Auditor"];
const OPERATOR_ROLES = ["Governance.Operator"];

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

function failure(error, context, label) {
  if (error instanceof RequestError || error instanceof ProvisioningError) return response({ error: error.message }, error.status);
  context.error(`${label} failed: ${error.message}`);
  return response({ error: `${label} failed.` }, 500);
}

async function catalog(request) {
  const config = getConfig();
  const authorization = authorize(request, REQUESTER_ROLES, { allowLocal: config.allowLocalAuth });
  if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
  return response({ source: "backend", templates: CATALOG });
}

async function listRequests(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, REQUESTER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const actor = actorFor(request, authorization.principal);
    const isOperator = actor.roles.includes("Governance.Operator");
    const requests = visibleRequests(await readRequests(config), actor, isOperator);
    return response({ source: "backend", scope: isOperator ? "all" : "mine", requests, meta: { count: requests.length } });
  } catch (error) {
    return failure(error, context, "Loading requests");
  }
}

async function submitRequest(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, REQUESTER_ROLES, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body) return response({ error: "A request body is required." }, 400);

    const actor = actorFor(request, authorization.principal);
    const record = createRequest({ input: body, actor });
    await createRequestIfAbsent(config, record);
    await writeAudit(config, {
      auditId: `${record.requestId}-submitted`, caseId: record.requestId, eventType: "workspace-request-submitted", requestId: record.requestId,
      actorId: actor.id, actorName: actor.name || null, occurredAt: record.requestedAt
    });
    return response({ request: record }, 201);
  } catch (error) {
    return failure(error, context, "Submitting the request");
  }
}

async function decide(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, OPERATOR_ROLES, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body) return response({ error: "A request body is required." }, 400);

    const found = await readRequestForUpdate(config, request.params.requestId);
    if (!found) return response({ error: "Request not found." }, 404);
    const actor = actorFor(request, authorization.principal);
    const result = decideRequest({ request: found.record, outcome: body.outcome, reason: body.reason, actor });
    if (!(await updateRequestIfUnchanged(config, result.request, found.etag))) {
      return response({ error: "The request changed. Reload and try again." }, 409);
    }
    await writeAudit(config, result.audit);
    return response({ request: result.request });
  } catch (error) {
    return failure(error, context, "Deciding the request");
  }
}

// Provisioning needs the Executor role, so approving and creating stay separate duties. Dry run
// is the default; live also needs the executor identity.
async function provision(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, ["Executor"], { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const found = await readRequestForUpdate(config, request.params.requestId);
    if (!found) return response({ error: "Request not found." }, 404);

    const live = config.executionMode === "live";
    if (live && !config.executorClientId) throw new ProvisioningError("Live execution is on but no executor identity is configured.");
    const actor = actorFor(request, authorization.principal);
    const result = await provisionWorkspace({
      request: found.record,
      actor,
      readGraph: createGraphClient(config),
      writeGraph: live ? createGraphClient(config, { clientId: config.executorClientId, writable: true }) : null,
      mode: live ? "live" : "dry-run",
      sensitivityLabelIds: config.sensitivityLabelIds,
      graphBaseUrl: config.graphBaseUrl
    });
    if (!(await updateRequestIfUnchanged(config, result.request, found.etag))) {
      return response({ error: "The request changed. Reload and try again." }, 409);
    }
    await writeVerification(config, result.verification);
    await writeAudit(config, result.audit);
    return response({ executionMode: config.executionMode, request: result.request, verification: result.verification });
  } catch (error) {
    return failure(error, context, "Provisioning the workspace");
  }
}

app.http("requestCatalog", { methods: ["GET"], authLevel: "anonymous", route: "api/catalog", handler: catalog });
app.http("requests", { methods: ["GET"], authLevel: "anonymous", route: "api/requests", handler: listRequests });
app.http("requestSubmit", { methods: ["POST"], authLevel: "anonymous", route: "api/requests", handler: submitRequest });
app.http("requestDecision", { methods: ["POST"], authLevel: "anonymous", route: "api/requests/{requestId}/decision", handler: decide });
app.http("requestProvision", { methods: ["POST"], authLevel: "anonymous", route: "api/requests/{requestId}/provision", handler: provision });
