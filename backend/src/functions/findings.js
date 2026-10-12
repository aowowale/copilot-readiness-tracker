import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { readFindings } from "../lib/store.js";
import { policyCatalog } from "../policies/workspace-health.js";

function response(jsonBody, status = 200) {
  return {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    jsonBody
  };
}

function limitFrom(request) {
  const value = Number.parseInt(request.query.get("limit") || "100", 10);
  return Math.min(Math.max(Number.isNaN(value) ? 100 : value, 1), 1000);
}

function authorizeTenantRead(request, config) {
  const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
  return authorization.ok ? null : response({ error: authorization.error }, authorization.status);
}

async function findings(request, context) {
  try {
    const config = getConfig();
    const denied = authorizeTenantRead(request, config);
    if (denied) return denied;
    const records = await readFindings(config, {
      status: request.query.get("status") || undefined,
      policyId: request.query.get("policyId") || undefined,
      resourceIds: request.query.get("resourceId") ? [request.query.get("resourceId")] : undefined,
      limit: limitFrom(request)
    });
    return response({ source: "backend", findings: records, meta: { count: records.length } });
  } catch (error) {
    context.error(`findings API failed: ${error.message}`);
    return response({ error: "Governance findings unavailable." }, 500);
  }
}

async function policies(request, context) {
  try {
    const config = getConfig();
    const denied = authorizeTenantRead(request, config);
    if (denied) return denied;
    return response({ source: "backend", ...policyCatalog() });
  } catch (error) {
    context.error(`policies API failed: ${error.message}`);
    return response({ error: "Policy catalog unavailable." }, 500);
  }
}

app.http("findings", { methods: ["GET"], authLevel: "anonymous", route: "api/findings", handler: findings });
app.http("policies", { methods: ["GET"], authLevel: "anonymous", route: "api/policies", handler: policies });