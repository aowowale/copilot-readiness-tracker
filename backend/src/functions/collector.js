import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { createGraphClient } from "../lib/graph.js";
import { collectWorkspaces } from "../lib/collect.js";
import { writeSnapshot } from "../lib/store.js";

// Scheduled read-only collector. Writes a snapshot; never mutates the tenant.
async function collector(myTimer, context) {
  const config = getConfig();
  const graph = createGraphClient(config);

  context.log(`Collector starting for ${config.pilotTeamIds.length} pilot team(s).`);
  const { workspaces, warnings } = await collectWorkspaces(graph, config, context);

  if (!workspaces.length) {
    // Do not overwrite a good snapshot with empty data.
    context.warn("No workspaces collected; snapshot not written.");
    return;
  }

  await writeSnapshot(config, workspaces, {
    collectedAt: new Date().toISOString(),
    status: warnings.length ? "partial" : "ok",
    warnings
  });

  context.log(`Collector wrote ${workspaces.length} workspace(s). Warnings: ${warnings.length}.`);
}

app.timer("collector", {
  schedule: process.env.COLLECTOR_SCHEDULE || "0 0 3 * * *",
  handler: collector
});
