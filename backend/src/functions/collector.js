import { app } from "@azure/functions";
import { authorize } from "../lib/auth.js";
import { getConfig } from "../lib/config.js";
import { createGraphClient } from "../lib/graph.js";
import { collectWorkspaces } from "../lib/collect.js";
import { parseRoleChangeFeed } from "../lib/role-changes.js";
import { syncMoverTasks } from "../lib/mover-sync.js";
import { createMailer, deliverNotifications, planNotifications } from "../lib/notifications.js";
import { reconcileWorkspaceHealth } from "../lib/finding-service.js";
import { parseSitePrincipalsFeed } from "../lib/shadow-users.js";
import { applyEvidence, evidenceAgeHours, parseEvidenceFeed, sitePrincipalsFromEvidence } from "../lib/evidence.js";
import { collectAgents, collectCopilot } from "../lib/ai-collect.js";
import { scoreWorkspace, DEFAULT_DEFINITION } from "../lib/risk.js";
import { effectiveDefinition } from "../lib/risk-definitions.js";
import { diffWorkspaces } from "../lib/drift.js";
import { reconcileBaselineAlerts } from "../lib/baselines.js";
import { buildRunRecord } from "../lib/runs.js";
import { syncOwnerTasks } from "../lib/owner-task-sync.js";
import { buildPosture } from "../lib/posture.js";
import { buildTrendPoint } from "../lib/trend.js";
import {
  createCaseIfAbsent,
  createTaskIfAbsent,
  readFindings,
  readEvidenceFeedText,
  readTasksWithEtag,
  readRiskDefinition,
  readSnapshot,
  readSuppressions,
  updateTaskIfUnchanged,
  replaceAgents,
  readNotification,
  readBaselines,
  readDriftAlerts,
  writeNotification,
  writeOneDriveInventory,
  writeDriftAlert,
  writeCopilot,
  writeChanges,
  writeFinding,
  writeRun,
  writeSnapshot,
  writeTrendPoint
} from "../lib/store.js";

// Scheduled read-only collector. Writes a snapshot; never mutates the tenant.
async function collector(myTimer, context) {
  const config = getConfig();
  const graph = createGraphClient(config);
  const collectedAt = new Date().toISOString();

  // Run history must never break the collection itself.
  const record = async (run) => {
    try {
      await writeRun(config, buildRunRecord({ finishedAt: new Date().toISOString(), ...run }));
    } catch (error) {
      context.warn(`Run record for ${run.source} could not be written: ${error.message}`);
    }
  };

  try {
    config.sitePrincipals = parseSitePrincipalsFeed(config.sitePrincipalsFeedJson);
    if (config.sitePrincipalsFeedJson) {
      await record({ source: "site-principals-feed", startedAt: collectedAt, status: "ok", recordsRead: Object.keys(config.sitePrincipals).length });
    }
  } catch (error) {
    config.sitePrincipals = {};
    context.error(error.message);
    await record({ source: "site-principals-feed", startedAt: collectedAt, status: "failed", error: error.message });
  }

  context.log(`Collector starting for ${config.pilotTeamIds.length} pilot team(s).`);
  let evidenceFeed = null;
  if (config.storageBlobEndpoint) {
    try {
      const text = await readEvidenceFeedText(config);
      if (text === null) {
        await record({ source: "evidence-feed", startedAt: collectedAt, status: "skipped", warnings: ["No evidence feed has been uploaded."] });
      } else {
        evidenceFeed = parseEvidenceFeed(text);
        config.sitePrincipals = { ...config.sitePrincipals, ...sitePrincipalsFromEvidence(evidenceFeed) };
      }
    } catch (error) {
      context.error(`Evidence feed rejected: ${error.message}`);
      await record({ source: "evidence-feed", startedAt: collectedAt, status: "failed", error: error.message });
    }
  }
  let collected = { workspaces: [], warnings: [] };
  try {
    collected = await collectWorkspaces(graph, config, context);
    await record({
      source: "graph-teams",
      startedAt: collectedAt,
      status: !collected.workspaces.length ? "failed" : collected.warnings.length ? "partial" : "ok",
      recordsRead: collected.workspaces.length,
      warnings: collected.warnings
    });
  } catch (error) {
    context.error(`Graph collection failed: ${error.message}`);
    await record({ source: "graph-teams", startedAt: collectedAt, status: "failed", error: error.message });
  }

  const { warnings } = collected;
  let enriched = collected.workspaces;
  if (evidenceFeed) {
    const result = applyEvidence(enriched, evidenceFeed, { maxAgeHours: config.evidenceMaxAgeHours });
    enriched = result.workspaces;
    const notes = [...evidenceFeed.problems];
    if (result.stale) notes.unshift(`The evidence feed is ${result.ageHours} hours old (limit ${config.evidenceMaxAgeHours}). It was ignored and its facts stay Unknown.`);
    else if (result.missing) notes.unshift(`${result.missing} of ${enriched.length} workspaces are not in the evidence feed.`);
    await record({
      source: "evidence-feed",
      startedAt: collectedAt,
      finishedAt: evidenceFeed.generatedAt,
      staleAfterHours: config.evidenceMaxAgeHours,
      status: result.stale ? "failed" : notes.length ? "partial" : "ok",
      recordsRead: result.applied,
      warnings: notes
    });
    if (!result.stale && (evidenceFeed.onedrive.length || evidenceFeed.onedriveComplete)) {
      try {
        await writeOneDriveInventory(config, {
          sites: evidenceFeed.onedrive,
          generatedAt: evidenceFeed.generatedAt,
          complete: evidenceFeed.onedriveComplete
        });
        await record({
          source: "onedrive-admin-export",
          startedAt: collectedAt,
          finishedAt: evidenceFeed.generatedAt,
          status: "ok",
          recordsRead: evidenceFeed.onedrive.length,
          warnings: ["OneDrive review contains site-level metadata only; no file names or contents were collected."]
        });
      } catch (error) {
        context.error(`OneDrive inventory write failed: ${error.message}`);
        await record({ source: "onedrive-admin-export", startedAt: collectedAt, status: "failed", error: error.message });
      }
    } else if (evidenceFeed.onedrive.length || evidenceFeed.onedriveComplete) {
      await record({
        source: "onedrive-admin-export",
        startedAt: collectedAt,
        finishedAt: evidenceFeed.generatedAt,
        status: "failed",
        recordsRead: 0,
        warnings: ["The OneDrive export is stale and was ignored."]
      });
    }
  }
  let definition = DEFAULT_DEFINITION;
  try {
    definition = effectiveDefinition(await readRiskDefinition(config));
  } catch (error) {
    context.warn(`Risk definition could not be read; using the default: ${error.message}`);
  }
  const workspaces = enriched.map((workspace) => ({ ...workspace, risk: scoreWorkspace(workspace, definition) }));
  let evaluated = workspaces;

  if (!workspaces.length) {
    // Do not overwrite a good snapshot with empty data.
    context.warn("No workspaces collected; snapshot not written.");
  } else {
    // Read the previous snapshot before it is overwritten, so drift can be computed.
    let previousWorkspaces = [];
    try {
      previousWorkspaces = (await readSnapshot(config)).workspaces;
    } catch (error) {
      context.warn(`Previous snapshot could not be read; drift is skipped this run: ${error.message}`);
    }

    await writeSnapshot(config, workspaces, {
      collectedAt,
      status: warnings.length ? "partial" : "ok",
      warnings
    });

    try {
      const result = await reconcileWorkspaceHealth({
        workspaces,
        evaluatedAt: collectedAt,
        repository: {
          readFindingsForResources: (resourceIds) => readFindings(config, { resourceIds, limit: 1000 }),
          writeFinding: (finding) => writeFinding(config, finding),
          createCaseIfAbsent: (governanceCase) => createCaseIfAbsent(config, governanceCase)
        }
      });
      evaluated = result.workspaces;
      await writeSnapshot(config, result.workspaces, {
        collectedAt,
        status: warnings.length ? "partial" : "ok",
        warnings,
        policyPackVersion: result.workspaces[0]?.policyPackVersion || null,
        findings: {
          active: result.activeFindings.length,
          resolved: result.resolvedFindings.length,
          casesCreated: result.casesCreated
        }
      });
      context.log(
        `Policy evaluation found ${result.activeFindings.length} active finding(s), resolved ${result.resolvedFindings.length}, and created ${result.casesCreated} case(s).`
      );
      await record({ source: "policy-evaluation", startedAt: collectedAt, status: "ok", recordsRead: workspaces.length });
    } catch (error) {
      context.error(`Policy evaluation failed; the raw workspace snapshot was retained: ${error.message}`);
      await record({ source: "policy-evaluation", startedAt: collectedAt, status: "failed", error: error.message });
    }

    try {
      const [findings, suppressions] = await Promise.all([readFindings(config, { limit: 1000 }), readSuppressions(config)]);
      const point = buildTrendPoint(evaluated, buildPosture(evaluated, findings, suppressions, new Date(), { staleDays: config.staleWorkspaceDays }), collectedAt);
      await writeTrendPoint(config, point);
      await record({ source: "trend-history", startedAt: collectedAt, status: "ok", recordsRead: 1 });
    } catch (error) {
      context.error(`Trend history failed: ${error.message}`);
      await record({ source: "trend-history", startedAt: collectedAt, status: "failed", error: error.message });
    }

    if (previousWorkspaces.length) {
      try {
        const changes = diffWorkspaces(previousWorkspaces, evaluated, collectedAt);
        await writeChanges(config, changes);
        await record({ source: "drift-detection", startedAt: collectedAt, status: "ok", recordsRead: previousWorkspaces.length, warnings: changes.length ? [`${changes.length} change(s) since the previous run.`] : [] });
      } catch (error) {
        context.error(`Drift detection failed: ${error.message}`);
        await record({ source: "drift-detection", startedAt: collectedAt, status: "failed", error: error.message });
      }
    }

    try {
      const [baselines, existingAlerts] = await Promise.all([readBaselines(config), readDriftAlerts(config)]);
      if (baselines.length) {
        const updated = reconcileBaselineAlerts({ baselines, workspaces: evaluated, alerts: existingAlerts, now: collectedAt });
        for (const alert of updated) await writeDriftAlert(config, alert);
        await record({
          source: "approved-baselines",
          startedAt: collectedAt,
          status: "ok",
          recordsRead: baselines.length,
          warnings: updated.filter(alert => alert.status === "open" && alert.lastSeenAt === collectedAt).length ? ["Drift against an approved baseline is open for review; no tenant change was made."] : []
        });
      } else {
        await record({ source: "approved-baselines", startedAt: collectedAt, status: "skipped", warnings: ["No approved baseline has been configured yet."] });
      }
    } catch (error) {
      context.error(`Approved baseline comparison failed: ${error.message}`);
      await record({ source: "approved-baselines", startedAt: collectedAt, status: "failed", error: error.message });
    }

    try {
      const sync = await syncOwnerTasks({
        workspaces: evaluated,
        repository: {
          readTasksWithEtag: () => readTasksWithEtag(config),
          createTaskIfAbsent: (task) => createTaskIfAbsent(config, task),
          updateTaskIfUnchanged: (task, etag) => updateTaskIfUnchanged(config, task, etag)
        }
      });
      context.log(`Owner tasks: ${sync.created} created, ${sync.escalated} escalated, ${sync.conflicts} skipped after concurrent edits.`);
      await record({
        source: "owner-tasks",
        startedAt: collectedAt,
        status: sync.conflicts ? "partial" : "ok",
        recordsRead: sync.total,
        warnings: sync.conflicts ? [`${sync.conflicts} task(s) changed during the run and were left for the next run.`] : []
      });
    } catch (error) {
      context.error(`Owner task sync failed: ${error.message}`);
      await record({ source: "owner-tasks", startedAt: collectedAt, status: "failed", error: error.message });
    }
  }

  // AI and agents: independent of workspaces, and each source fails soft with its own run record.
  try {
    const feedFresh = evidenceFeed && evidenceAgeHours(evidenceFeed) <= config.evidenceMaxAgeHours;
    const inventory = await collectAgents(graph, { evidenceAgents: feedFresh ? evidenceFeed.agents : [] });
    await replaceAgents(config, inventory.agents, inventory.sourcesRead, collectedAt);
    const notes = [...inventory.warnings];
    if (evidenceFeed && !feedFresh) notes.push("The evidence feed is stale, so its agents were not refreshed.");
    await record({
      source: "agent-inventory",
      startedAt: collectedAt,
      status: inventory.sourcesRead.size === 0 ? "failed" : notes.length ? "partial" : "ok",
      recordsRead: inventory.agents.length,
      warnings: notes
    });
  } catch (error) {
    context.error(`Agent inventory failed: ${error.message}`);
    await record({ source: "agent-inventory", startedAt: collectedAt, status: "failed", error: error.message });
  }

  try {
    const feedFresh = evidenceFeed && evidenceAgeHours(evidenceFeed) <= config.evidenceMaxAgeHours;
    const copilot = await collectCopilot(graph, config, new Date(), feedFresh ? evidenceFeed.copilotUsage : null);
    await writeCopilot(config, { collectedAt, licences: copilot.licences, adoption: copilot.adoption, sources: copilot.sources });
    for (const item of copilot.sources) {
      await record({
        source: item.source,
        startedAt: collectedAt,
        status: item.status === "ok" ? "ok" : item.status === "skipped" ? "skipped" : item.status === "partial" ? "partial" : "failed",
        recordsRead: item.source === "copilot-licences" ? (copilot.licences?.skus?.length ?? 0) : (copilot.adoption?.licensed ?? 0),
        warnings: item.detail ? [item.detail] : []
      });
    }
  } catch (error) {
    context.error(`Copilot collection failed: ${error.message}`);
    await record({ source: "copilot-licences", startedAt: collectedAt, status: "failed", error: error.message });
  }

  if (config.roleChangeFeedJson) {
    try {
      const roleChanges = parseRoleChangeFeed(config.roleChangeFeedJson, { maxRecords: config.maxRoleChanges });
      const result = await syncMoverTasks({
        roleChanges,
        workspaces: evaluated,
        graph,
        repository: {
          readTasksWithEtag: () => readTasksWithEtag(config),
          createTaskIfAbsent: (task) => createTaskIfAbsent(config, task)
        }
      });
      context.log(`Role changes: ${result.created} access review(s) created (${result.fromGraph} from Graph, ${result.fromFeed} from the feed entitlements).`);
      await record({
        source: "role-change-feed",
        startedAt: collectedAt,
        status: "ok",
        recordsRead: roleChanges.length,
        warnings: result.fromFeed ? [`${result.fromFeed} review(s) used the feed's entitlements because Graph could not list the person's Teams.`] : []
      });
    } catch (error) {
      context.error(`Role-change feed failed: ${error.message}`);
      await record({ source: "role-change-feed", startedAt: collectedAt, status: "failed", error: error.message });
    }
  }

  // Notifications run last so they see every task created above.
  if (config.notificationMode !== "off") {
    try {
      const [taskEntries, driftAlerts] = await Promise.all([readTasksWithEtag(config), readDriftAlerts(config)]);
      const tasks = taskEntries.map((entry) => entry.record);
      const live = config.notificationMode === "live";
      const mailer = live ? createMailer(createGraphClient(config, { clientId: config.executorClientId, writable: true }), config.notifySender) : null;
      const outcome = await deliverNotifications({
        planned: planNotifications({ tasks, workspaces: evaluated, driftAlerts: driftAlerts.filter(alert => alert.status === "open"), appUrl: config.appUrl, operatorEmail: config.notifyOperatorEmail }),
        repository: { readNotification: (key) => readNotification(config, key), writeNotification: (item) => writeNotification(config, item) },
        mailer,
        mode: config.notificationMode
      });
      context.log(`Notifications (${config.notificationMode}): ${outcome.sent} sent, ${outcome.simulated} simulated, ${outcome.skipped} skipped, ${outcome.failed} failed, ${outcome.alreadyDone} already done.`);
      await record({
        source: "notifications",
        startedAt: collectedAt,
        status: outcome.failed ? "partial" : "ok",
        recordsRead: outcome.planned,
        warnings: outcome.failed ? [`${outcome.failed} message(s) failed and will be retried.`] : outcome.skipped ? [`${outcome.skipped} message(s) skipped: no email address.`] : []
      });
    } catch (error) {
      context.error(`Notifications failed: ${error.message}`);
      await record({ source: "notifications", startedAt: collectedAt, status: "failed", error: error.message });
    }
  }

  context.log(`Collector wrote ${workspaces.length} workspace(s). Warnings: ${warnings.length}.`);
}

async function runCollector(request, context) {
  const authorization = authorize(request, ["Governance.Operator"], { allowLocal: false });
  if (!authorization.ok) {
    return { status: authorization.status, jsonBody: { error: authorization.error } };
  }

  try {
    await collector({ isPastDue: false }, context);
    return { status: 200, jsonBody: { source: "backend", status: "completed" } };
  } catch (error) {
    context.error(`Manual collector run failed: ${error.message}`);
    return { status: 500, jsonBody: { error: "Collector run failed." } };
  }
}

app.timer("collector", {
  schedule: process.env.COLLECTOR_SCHEDULE || "0 0 3 * * *",
  handler: collector
});
app.http("collectorRun", { methods: ["POST"], authLevel: "anonymous", route: "api/collector/run", handler: runCollector });
