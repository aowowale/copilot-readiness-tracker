import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { readWorkspaceMetadata } from "../lib/store.js";

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

async function metadata(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const records = await readWorkspaceMetadata(config, { workspaceId: request.query.get("workspaceId") || undefined });
    return response({ source: "backend", metadata: records, meta: { count: records.length } });
  } catch (error) {
    context.error(`metadata API failed: ${error.message}`);
    return response({ error: "Workspace metadata unavailable." }, 500);
  }
}

app.http("workspaceMetadata", { methods: ["GET"], authLevel: "anonymous", route: "api/metadata", handler: metadata });
