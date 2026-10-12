import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { readSnapshot } from "../lib/store.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";

// Read-only API consumed by the dashboard. Returns the latest stored snapshot.
// App Service Authentication (Entra) protects this route; there is no write path.
async function workspaces(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) {
      return {
        status: authorization.status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        jsonBody: { error: authorization.error }
      };
    }
    const { workspaces, meta } = await readSnapshot(config);
    return {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      jsonBody: {
        source: "backend",
        collectedAt: meta?.collectedAt || null,
        status: meta?.status || "unknown",
        warnings: meta?.warnings || [],
        workspaces
      }
    };
  } catch (error) {
    context.error(`workspaces API failed: ${error.message}`);
    return {
      status: 500,
      headers: { "Content-Type": "application/json" },
      jsonBody: { error: "Snapshot unavailable." }
    };
  }
}

app.http("workspaces", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "api/workspaces",
  handler: workspaces
});
