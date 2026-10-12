import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { actorFor, mayAct, OWNER_ROLES } from "../lib/owner-access.js";
import {
  reviewDecision,
  saveStep,
  submitDecision,
  taskSummary,
  TaskRuleError
} from "../lib/owner-tasks.js";
import {
  readDecision,
  readDecisions,
  readActions,
  createActionIfAbsent,
  readSnapshot,
  readTaskForUpdate,
  readTasksWithEtag,
  readWorkspaceMetadata,
  mergeWorkspaceMetadata,
  updateTaskIfUnchanged,
  writeAction,
  writeAudit,
  writeDecision,
  writeVerification
} from "../lib/store.js";
import { metadataFromStep } from "../lib/metadata.js";
import { latestWorkspaceTasks, submitMoverDecisions } from "../lib/movers.js";
import { executeLifecycleDecision } from "../lib/lifecycle-execution.js";
import { createGraphClient } from "../lib/graph.js";

// Owner workflow API. Records progress and decisions only; it never changes the tenant.

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

async function workspaceFor(config, workspaceId) {
  const { workspaces } = await readSnapshot(config);
  return workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

async function listTasks(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, [...TENANT_READER_ROLES, "Workspace.Owner"], { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);

    const actor = actorFor(request, authorization.principal);
    const isReader = actor.roles.some((role) => TENANT_READER_ROLES.includes(role));
    const wantsAll = request.query.get("scope") === "all";
    if (wantsAll && !isReader) return response({ error: "You do not have permission to access this resource." }, 403);

    const now = new Date();
    const tasks = (await readTasksWithEtag(config))
      .map((entry) => entry.record)
      .filter((task) => wantsAll || mayAct(task, actor))
      .map((task) => taskSummary(task, now));
    return response({ source: "backend", scope: wantsAll ? "all" : "mine", tasks, meta: { count: tasks.length } });
  } catch (error) {
    context.error(`owner tasks API failed: ${error.message}`);
    return response({ error: "Owner tasks unavailable." }, 500);
  }
}

async function taskDetail(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, [...TENANT_READER_ROLES, "Workspace.Owner"], { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);

    const actor = actorFor(request, authorization.principal);
    const found = await readTaskForUpdate(config, request.params.taskId);
    if (!found) return response({ error: "Task not found." }, 404);
    const isReader = actor.roles.some((role) => TENANT_READER_ROLES.includes(role));
    if (!isReader && !mayAct(found.record, actor)) return response({ error: "You do not have permission to access this resource." }, 403);

    const workspace = await workspaceFor(config, found.record.workspaceId);
    const metadata = (await readWorkspaceMetadata(config, { workspaceId: found.record.workspaceId }).catch(() => []))[0] || null;
    return response({
      source: "backend",
      task: taskSummary(found.record),
      metadata,
      workspace: workspace && {
        id: workspace.id, name: workspace.name, owners: workspace.owners, ownerDetails: workspace.ownerDetails,
        members: workspace.members, guests: workspace.guests, labels: workspace.labels, shadowUsers: workspace.shadowUsers,
        risk: workspace.risk, health: workspace.health, legalHold: workspace.legalHold ?? null,
        retentionLocked: workspace.retentionLocked ?? null, evidence: workspace.evidence || null,
        renewedAt: workspace.renewedAt || null, expiresAt: workspace.expiresAt || null
      }
    });
  } catch (error) {
    context.error(`owner task detail API failed: ${error.message}`);
    return response({ error: "Task unavailable." }, 500);
  }
}

// Shared guard for owner writes: authorize, check assignment and the expected version.
async function loadForWrite(request, config) {
  const authorization = authorize(request, OWNER_ROLES, { allowLocal: false });
  if (!authorization.ok) return { error: response({ error: authorization.error }, authorization.status) };

  const body = await request.json().catch(() => null);
  if (!body || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
    return { error: response({ error: "A non-negative expectedVersion is required." }, 400) };
  }

  const actor = actorFor(request, authorization.principal);
  const found = await readTaskForUpdate(config, request.params.taskId);
  if (!found) return { error: response({ error: "Task not found." }, 404) };
  if (!mayAct(found.record, actor)) return { error: response({ error: "This task is not assigned to you." }, 403) };
  if (Number(found.record.version) !== body.expectedVersion) {
    return { error: response({ error: "The task changed. Reload and try again." }, 409) };
  }
  return { body, actor, found };
}

function failure(error, context, label) {
  if (error instanceof TaskRuleError) return response({ error: error.message }, error.status);
  context.error(`${label} failed: ${error.message}`);
  return response({ error: `${label} failed.` }, 500);
}

async function saveTaskStep(request, context) {
  try {
    const config = getConfig();
    const loaded = await loadForWrite(request, config);
    if (loaded.error) return loaded.error;

    const task = saveStep(loaded.found.record, request.params.step, loaded.body.data, loaded.actor);
    if (!(await updateTaskIfUnchanged(config, task, loaded.found.etag))) {
      return response({ error: "The task changed. Reload and try again." }, 409);
    }
    // Best effort: the register must never block an owner from saving their step.
    const fields = metadataFromStep(request.params.step, task.steps[request.params.step]?.data, loaded.actor);
    if (fields) await mergeWorkspaceMetadata(config, task.workspaceId, fields).catch((error) => context.warn(`Metadata not saved: ${error.message}`));
    return response({ task: taskSummary(task) });
  } catch (error) {
    return failure(error, context, "Saving the step");
  }
}

async function decide(request, context) {
  try {
    const config = getConfig();
    const loaded = await loadForWrite(request, config);
    if (loaded.error) return loaded.error;

    const workspace = await workspaceFor(config, loaded.found.record.workspaceId);
    const result = submitDecision(
      loaded.found.record,
      { choice: loaded.body.choice, reason: loaded.body.reason },
      loaded.actor,
      workspace
    );
    if (!(await updateTaskIfUnchanged(config, result.task, loaded.found.etag))) {
      return response({ error: "The task changed. Reload and try again." }, 409);
    }
    // Deterministic ids make these writes safe to repeat if the request is retried.
    await writeDecision(config, result.decision);
    await writeAudit(config, result.audit);
    return response({ task: taskSummary(result.task), decision: result.decision });
  } catch (error) {
    return failure(error, context, "Recording the decision");
  }
}

// A manager decides keep or remove for each Team a mover belongs to. Removals become pending
// requests on each workspace's own review; the workspace owner confirms them.
async function decideMover(request, context) {
  try {
    const config = getConfig();
    const loaded = await loadForWrite(request, config);
    if (loaded.error) return loaded.error;

    const tasks = (await readTasksWithEtag(config)).map((entry) => entry.record);
    const result = submitMoverDecisions({
      task: loaded.found.record,
      decisions: loaded.body.decisions,
      actor: loaded.actor,
      workspaceTasks: latestWorkspaceTasks(tasks)
    });
    if (!(await updateTaskIfUnchanged(config, result.task, loaded.found.etag))) {
      return response({ error: "The task changed. Reload and try again." }, 409);
    }
    for (const action of result.requests) {
      // A removal that already ran is not reopened.
      const existing = (await readActions(config, action.caseId)).find((item) => item.actionId === action.actionId);
      if (existing?.status === "verified") continue;
      const created = await createActionIfAbsent(config, action);
      if (!created) continue;
      await writeAudit(config, {
        auditId: `${action.actionId}-requested`, caseId: action.caseId, eventType: "action-proposed", actionId: action.actionId,
        actionType: action.actionType, targetUserId: action.targetUserId, origin: action.origin, actorId: loaded.actor.id, actorName: loaded.actor.name || null, occurredAt: action.requestedAt
      });
    }
    await writeDecision(config, result.decision);
    await writeAudit(config, result.audit);
    return response({ task: taskSummary(result.task), removalRequests: result.requests.length, unrouted: result.unrouted });
  } catch (error) {
    return failure(error, context, "Recording the access review");
  }
}

async function listDecisions(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const limit = Math.min(Math.max(Number.parseInt(request.query.get("limit") || "200", 10) || 200, 1), 1000);
    const decisions = (await readDecisions(config, { workspaceId: request.query.get("workspaceId") || undefined, limit }))
      .map((decision) => ({
        ...decision,
        availableActions: decision.status === "approved-not-executed" && ["not-executed", "simulated"].includes(decision.executionStatus || "not-executed") && authorization.principal.roles.includes("Executor")
          ? [`execute-${decision.choice}`]
          : []
      }));
    return response({ source: "backend", decisions, meta: { count: decisions.length } });
  } catch (error) {
    context.error(`decisions API failed: ${error.message}`);
    return response({ error: "Decision register unavailable." }, 500);
  }
}

async function reviewDeleteRequest(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, ["Approver"], { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const approver = actorFor(request, authorization.principal);

    const body = await request.json().catch(() => null);
    if (!body || typeof body.outcome !== "string") return response({ error: "An outcome is required." }, 400);

    const decision = await readDecision(config, request.params.decisionId);
    if (!decision) return response({ error: "Decision not found." }, 404);
    const found = await readTaskForUpdate(config, decision.taskId);
    if (!found) return response({ error: "Task not found." }, 404);

    const result = reviewDecision(decision, found.record, { outcome: body.outcome, reason: body.reason }, approver);
    if (!(await updateTaskIfUnchanged(config, result.task, found.etag))) {
      return response({ error: "The task changed. Reload and try again." }, 409);
    }
    await writeDecision(config, result.decision);
    await writeAudit(config, result.audit);
    return response({ task: taskSummary(result.task), decision: result.decision });
  } catch (error) {
    return failure(error, context, "Reviewing the request");
  }
}

async function executeLifecycle(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, ["Executor"], { allowLocal: false });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const body = await request.json().catch(() => null);
    if (!body || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) return response({ error: "A non-negative expectedVersion is required." }, 400);
    const decision = await readDecision(config, request.params.decisionId);
    if (!decision || decision.taskId !== request.params.taskId) return response({ error: "Approved lifecycle decision not found." }, 404);
    const found = await readTaskForUpdate(config, request.params.taskId);
    if (!found) return response({ error: "Task not found." }, 404);
    if (found.record.version !== body.expectedVersion) return response({ error: "The task changed. Reload and try again." }, 409);
    if (found.record.lifecycleExecutionStatus === "executing" || found.record.lifecycleExecutionStatus === "execution-uncertain") {
      return response({ error: "A lifecycle action is already running or needs manual reconciliation. Do not retry it blindly." }, 409);
    }
    if (found.record.decision?.decisionId !== decision.decisionId) return response({ error: "This is not the current approved decision for the task." }, 409);

    const actor = actorFor(request, authorization.principal);
    const workspace = await workspaceFor(config, found.record.workspaceId);
    if (!workspace) return response({ error: "Workspace not found in the current snapshot." }, 404);
    const live = config.executionMode === "live";
    if (live && !config.lifecycleExecutionEnabled) return response({ error: "Live archive/delete execution is not enabled by the tenant administrator." }, 403);
    const graph = live
      ? createGraphClient(config, { clientId: config.executorClientId, writable: true })
      : createGraphClient(config);
    const options = {
      decision,
      workspace,
      actor,
      graph,
      mode: live ? "live" : "dry-run",
      lifecycleEnabled: config.lifecycleExecutionEnabled,
      maxEvidenceAgeHours: config.evidenceMaxAgeHours,
      confirmation: body.confirmation
    };

    // Validate all human/evidence/approval gates before taking the execution lock.
    const preview = await executeLifecycleDecision({ ...options, mode: "dry-run" });
    if (!live) {
      const task = { ...found.record, lifecycleExecutionStatus: "simulated", version: found.record.version + 1 };
      if (!(await updateTaskIfUnchanged(config, task, found.etag))) return response({ error: "The task changed. Reload and try again." }, 409);
      await writeDecision(config, preview.decision);
      await writeVerification(config, preview.verification);
      await writeAudit(config, preview.audit);
      return response({ executionMode: "dry-run", task: taskSummary(task), decision: preview.decision, verification: preview.verification });
    }

    if (!config.executorClientId) return response({ error: "Live lifecycle execution needs the separate executor identity." }, 409);
    const reservedTask = { ...found.record, lifecycleExecutionStatus: "executing", version: found.record.version + 1 };
    if (!(await updateTaskIfUnchanged(config, reservedTask, found.etag))) return response({ error: "The task changed. Reload and try again." }, 409);
    const executingDecision = { ...decision, executionStatus: "executing", executionMode: "live", executionStartedAt: new Date().toISOString(), executionActorId: actor.id, executionActorName: actor.name || null };
    await writeDecision(config, executingDecision);

    try {
      const result = await executeLifecycleDecision(options);
      const fresh = await readTaskForUpdate(config, request.params.taskId);
      const completedTask = { ...fresh.record, lifecycleExecutionStatus: "executed-and-verified", version: fresh.record.version + 1 };
      if (!(await updateTaskIfUnchanged(config, completedTask, fresh.etag))) throw new Error("Task version changed while recording lifecycle verification.");
      await writeDecision(config, result.decision);
      await writeVerification(config, result.verification);
      await writeAudit(config, result.audit);
      return response({ executionMode: "live", task: taskSummary(completedTask), decision: result.decision, verification: result.verification });
    } catch (error) {
      const fresh = await readTaskForUpdate(config, request.params.taskId).catch(() => null);
      if (fresh) {
        const uncertainTask = { ...fresh.record, lifecycleExecutionStatus: "execution-uncertain", version: fresh.record.version + 1 };
        await updateTaskIfUnchanged(config, uncertainTask, fresh.etag).catch(() => false);
      }
      const uncertainDecision = { ...executingDecision, executionStatus: "execution-uncertain", executionDetail: "The Microsoft 365 response could not be verified. Check the Team or group manually before any retry." };
      await writeDecision(config, uncertainDecision);
      await writeAudit(config, {
        auditId: `${decision.decisionId}-lifecycle-uncertain`, caseId: request.params.taskId,
        eventType: "lifecycle-action-uncertain", choice: decision.choice, actorId: actor.id,
        actorName: actor.name || null, occurredAt: new Date().toISOString(),
        reason: "Graph response or verification was inconclusive; manual reconciliation is required."
      });
      context.error(`Lifecycle action requires manual reconciliation: ${error.message}`);
      return response({ error: uncertainDecision.executionDetail, decision: uncertainDecision }, 502);
    }
  } catch (error) {
    return failure(error, context, "Executing the approved lifecycle decision");
  }
}

app.http("ownerTasks", { methods: ["GET"], authLevel: "anonymous", route: "api/owner/tasks", handler: listTasks });
app.http("ownerTaskDetail", { methods: ["GET"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}", handler: taskDetail });
app.http("ownerTaskStep", { methods: ["PUT"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/steps/{step}", handler: saveTaskStep });
app.http("ownerTaskDecision", { methods: ["POST"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/decision", handler: decide });
app.http("ownerMoverDecision", { methods: ["POST"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/mover-decision", handler: decideMover });
app.http("decisions", { methods: ["GET"], authLevel: "anonymous", route: "api/decisions", handler: listDecisions });
app.http("decisionReview", { methods: ["POST"], authLevel: "anonymous", route: "api/decisions/{decisionId}/review", handler: reviewDeleteRequest });
app.http("ownerLifecycleExecute", { methods: ["POST"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/decisions/{decisionId}/execute", handler: executeLifecycle });
