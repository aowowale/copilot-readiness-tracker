import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { readNotifications } from "../lib/store.js";

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

// Delivery history for governance roles. Email addresses are never returned, only names.
async function notifications(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const limit = Math.min(Math.max(Number.parseInt(request.query.get("limit") || "100", 10) || 100, 1), 500);
    const records = (await readNotifications(config, { limit })).map(({ recipientId, ...rest }) => rest);
    return response({ source: "backend", mode: config.notificationMode, notifications: records, meta: { count: records.length } });
  } catch (error) {
    context.error(`notifications API failed: ${error.message}`);
    return response({ error: "Notification history unavailable." }, 500);
  }
}

app.http("notifications", { methods: ["GET"], authLevel: "anonymous", route: "api/notifications", handler: notifications });
