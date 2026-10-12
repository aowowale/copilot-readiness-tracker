import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { availableTransitions, rolesForTransition } from "../lib/case-workflow.js";
import {
  applyCaseTransition,
  CaseNotFoundError,
  CaseVersionConflictError
} from "../lib/case-service.js";
import {
  commitCaseTransition,
  readCaseForUpdate,
  readCases,
  readCaseDetail,
  readExceptions
} from "../lib/store.js";

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

function transitionsFor(status, roles) {
  return availableTransitions(status).filter((transition) =>
    rolesForTransition(transition).some((role) => roles.includes(role))
  );
}

async function cases(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const records = await readCases(config, {
      status: request.query.get("status") || undefined,
      userId: request.query.get("userId") || undefined,
      limit: limitFrom(request)
    });
    return response({ source: "backend", cases: records.map((record) => ({
      ...record,
      availableTransitions: transitionsFor(record.status || "detected", authorization.principal.roles)
    })), meta: { count: records.length } });
  } catch (error) {
    context.error(`cases API failed: ${error.message}`);
    return response({ error: "Governance cases unavailable." }, 500);
  }
}

async function caseDetail(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const detail = await readCaseDetail(config, request.params.caseId);
    return detail ? response({
      source: "backend",
      ...detail,
      availableTransitions: transitionsFor(detail.case.status || "detected", authorization.principal.roles)
    }) : response({ error: "Case not found." }, 404);
  } catch (error) {
    context.error(`case detail API failed: ${error.message}`);
    return response({ error: "Governance case unavailable." }, 500);
  }
}

async function exceptions(request, context) {
  try {
    const config = getConfig();
    const denied = authorizeTenantRead(request, config);
    if (denied) return denied;
    const records = await readExceptions(config, {
      status: request.query.get("status") || undefined,
      limit: limitFrom(request)
    });
    return response({ source: "backend", exceptions: records, meta: { count: records.length } });
  } catch (error) {
    context.error(`exceptions API failed: ${error.message}`);
    return response({ error: "Governance exceptions unavailable." }, 500);
  }
}

async function caseTransition(request, context) {
  try {
    const config = getConfig();
    const body = await request.json().catch(() => null);
    if (!body || typeof body.transition !== "string") {
      return response({ error: "A transition is required." }, 400);
    }
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
      return response({ error: "A non-negative expectedVersion is required." }, 400);
    }

    const allowedRoles = rolesForTransition(body.transition);
    if (!allowedRoles.length) return response({ error: "Unknown case transition." }, 400);

    const authorization = authorize(request, allowedRoles, { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);

    const result = await applyCaseTransition({
      caseId: request.params.caseId,
      transition: body.transition,
      expectedVersion: body.expectedVersion,
      actor: authorization.principal,
      options: {
        reason: typeof body.reason === "string" ? body.reason.trim() || null : null,
        correlationId: request.headers.get("x-correlation-id") || null
      },
      repository: {
        readCaseForUpdate: (caseId) => readCaseForUpdate(config, caseId),
        commitCaseTransition: (record, audit, etag) => commitCaseTransition(config, record, audit, etag)
      }
    });
    return response({ case: result.record, audit: result.audit });
  } catch (error) {
    if (error instanceof CaseNotFoundError) return response({ error: error.message }, 404);
    if (error instanceof CaseVersionConflictError) return response({ error: error.message }, 409);
    if (/not allowed from/.test(error.message)) return response({ error: error.message }, 409);
    context.error(`case transition API failed: ${error.message}`);
    return response({ error: "Case transition failed." }, 500);
  }
}

app.http("cases", { methods: ["GET"], authLevel: "anonymous", route: "api/cases", handler: cases });
app.http("case-detail", { methods: ["GET"], authLevel: "anonymous", route: "api/cases/{caseId}", handler: caseDetail });
app.http("case-transition", { methods: ["POST"], authLevel: "anonymous", route: "api/cases/{caseId}/transition", handler: caseTransition });
app.http("exceptions", { methods: ["GET"], authLevel: "anonymous", route: "api/exceptions", handler: exceptions });