import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { buildAgentInventory } from "../lib/agents.js";
import { readAgents, readCopilot, readRuns } from "../lib/store.js";
import { summarizeSources } from "../lib/runs.js";

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

const AGENT_SOURCES = ["agent-inventory"];
const COPILOT_SOURCES = ["copilot-licences", "copilot-usage"];

async function sourceStatus(config, names) {
  const runs = await readRuns(config);
  return summarizeSources(runs, { staleHours: config.staleSourceHours }).filter((item) => names.includes(item.source));
}

async function agents(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const [records, sources] = await Promise.all([readAgents(config), sourceStatus(config, AGENT_SOURCES)]);
    return response({ source: "backend", sources, ...buildAgentInventory(records, { staleDays: config.agentStaleDays }) });
  } catch (error) {
    context.error(`agents API failed: ${error.message}`);
    return response({ error: "Agent inventory unavailable." }, 500);
  }
}

// Licence holders with no recent activity are named only when COPILOT_SHOW_USERS allows it, and
// only to governance roles. Counts are always returned.
async function copilot(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const [{ summary, reclaim }, sources] = await Promise.all([readCopilot(config), sourceStatus(config, COPILOT_SOURCES)]);
    return response({
      source: "backend",
      collectedAt: summary?.collectedAt || null,
      licences: summary?.licences || null,
      adoption: summary?.adoption || null,
      collection: summary?.sources || [],
      sources,
      usersHidden: !config.copilotShowUsers,
      reclaim: config.copilotShowUsers ? reclaim : []
    });
  } catch (error) {
    context.error(`copilot API failed: ${error.message}`);
    return response({ error: "Copilot data unavailable." }, 500);
  }
}

app.http("agents", { methods: ["GET"], authLevel: "anonymous", route: "api/agents", handler: agents });
app.http("copilot", { methods: ["GET"], authLevel: "anonymous", route: "api/copilot", handler: copilot });
