import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { buildPosture } from "../lib/posture.js";
import { summarizeSources } from "../lib/runs.js";
import { summarizeTrend } from "../lib/trend.js";
import { readFindings, readRuns, readSnapshot, readSuppressions, readTrend } from "../lib/store.js";

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

async function posture(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);

    const [{ workspaces, meta }, findings, suppressions] = await Promise.all([
      readSnapshot(config),
      readFindings(config, { limit: 1000 }),
      readSuppressions(config)
    ]);
    return response({
      source: "backend",
      collectedAt: meta?.collectedAt || null,
      posture: buildPosture(workspaces, findings, suppressions, new Date(), { staleDays: config.staleWorkspaceDays }),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        type: workspace.type,
        guests: workspace.guests,
        owners: workspace.owners,
        exposure: workspace.exposure,
        labels: workspace.labels,
        shadowUsers: workspace.shadowUsers,
        risk: workspace.risk || null,
        renewedAt: workspace.renewedAt || null,
        expiresAt: workspace.expiresAt || null
      }))
    });
  } catch (error) {
    context.error(`posture API failed: ${error.message}`);
    return response({ error: "Posture unavailable." }, 500);
  }
}

async function sources(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);

    const runs = await readRuns(config);
    return response({
      source: "backend",
      staleAfterHours: config.staleSourceHours,
      sources: summarizeSources(runs, { staleHours: config.staleSourceHours }),
      history: runs.slice(0, 50)
    });
  } catch (error) {
    context.error(`sources API failed: ${error.message}`);
    return response({ error: "Source status unavailable." }, 500);
  }
}

async function postureHistory(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const days = Math.min(Math.max(Number.parseInt(request.query.get("days") || "90", 10) || 90, 1), 365);
    const points = await readTrend(config, { days });
    return response({ source: "backend", days, points, summary: summarizeTrend(points) });
  } catch (error) {
    context.error(`posture history API failed: ${error.message}`);
    return response({ error: "Posture history unavailable." }, 500);
  }
}

app.http("posture", { methods: ["GET"], authLevel: "anonymous", route: "api/posture", handler: posture });
app.http("postureHistory", { methods: ["GET"], authLevel: "anonymous", route: "api/posture/history", handler: postureHistory });
app.http("sources", { methods: ["GET"], authLevel: "anonymous", route: "api/sources", handler: sources });
