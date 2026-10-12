import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { buildGuestInventory } from "../lib/guests.js";
import { readSnapshot } from "../lib/store.js";

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

// Read-only. Removal goes through the owner-executed flow, which re-checks membership first.
async function guests(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const { workspaces, meta } = await readSnapshot(config);
    return response({ source: "backend", collectedAt: meta?.collectedAt || null, ...buildGuestInventory(workspaces, { reviewDays: config.guestReviewDays }) });
  } catch (error) {
    context.error(`guests API failed: ${error.message}`);
    return response({ error: "Guest inventory unavailable." }, 500);
  }
}

app.http("guests", { methods: ["GET"], authLevel: "anonymous", route: "api/guests", handler: guests });
