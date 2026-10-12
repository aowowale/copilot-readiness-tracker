import { app } from "@azure/functions";
import { getConfig } from "../lib/config.js";
import { authorize, TENANT_READER_ROLES } from "../lib/auth.js";
import { createGraphClient } from "../lib/graph.js";
import { actorFor, mayAct, OWNER_ROLES } from "../lib/owner-access.js";
import {
  executeAction,
  ExecutionRuleError,
  listGroupPeople,
  proposeMemberRemovals
} from "../lib/execution.js";
import { proposePermissionRevocations, scanSharing } from "../lib/sharing.js";
import {
  readActionHistory,
  readActionForUpdate,
  readActions,
  createActionIfAbsent,
  readTaskForUpdate,
  updateActionIfUnchanged,
  writeAction,
  writeAudit,
  writeVerification
} from "../lib/store.js";

// Owner-executed membership removal. Proposals only read; confirming an action runs it in the
// configured mode. Dry-run is the default and changes nothing. Live mode uses the separate
// executor identity, never the read-only collector identity.

function response(jsonBody, status = 200) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, jsonBody };
}

function failure(error, context, label) {
  if (error instanceof ExecutionRuleError) return response({ error: error.message }, error.status);
  context.error(`${label} failed: ${error.message}`);
  return response({ error: `${label} failed.` }, 500);
}

async function authorizedTask(request, config) {
  const authorization = authorize(request, OWNER_ROLES, { allowLocal: false });
  if (!authorization.ok) return { error: response({ error: authorization.error }, authorization.status) };
  const actor = actorFor(request, authorization.principal);
  const found = await readTaskForUpdate(config, request.params.taskId);
  if (!found) return { error: response({ error: "Task not found." }, 404) };
  if (!mayAct(found.record, actor)) return { error: response({ error: "This task is not assigned to you." }, 403) };
  return { actor, task: found.record };
}

async function taskMembers(request, context) {
  try {
    const config = getConfig();
    const access = await authorizedTask(request, config);
    if (access.error) return access.error;
    const people = await listGroupPeople(createGraphClient(config), access.task.workspaceId);
    // Removals a manager asked for after a role change wait here for the owner to confirm.
    const pending = (await readActions(config, access.task.taskId))
      .filter((action) => action.origin === "role-change" && ["proposed", "failed", "simulated"].includes(action.status));
    return response({
      source: "backend",
      executionMode: config.executionMode,
      pendingRequests: pending,
      members: people.members.map((member) => ({ ...member, removable: member.id !== access.actor.id }))
    });
  } catch (error) {
    return failure(error, context, "Loading members");
  }
}

async function proposeRemovals(request, context) {
  try {
    const config = getConfig();
    const access = await authorizedTask(request, config);
    if (access.error) return access.error;
    const body = await request.json().catch(() => null);
    if (!body) return response({ error: "A request body is required." }, 400);

    const { actions, rejected } = await proposeMemberRemovals({
      task: access.task,
      userIds: body.userIds,
      reason: body.reason,
      actor: access.actor,
      graph: createGraphClient(config)
    });
    for (const action of actions) {
      const created = await createActionIfAbsent(config, action);
      if (!created) continue;
      await writeAudit(config, {
        auditId: `${action.actionId}-proposed`, caseId: action.caseId, eventType: "action-proposed", actionId: action.actionId,
        actionType: action.actionType, targetUserId: action.targetUserId, actorId: access.actor.id, actorName: access.actor.name || null, occurredAt: action.requestedAt
      });
    }
    return response({ executionMode: config.executionMode, actions, rejected });
  } catch (error) {
    return failure(error, context, "Proposing removals");
  }
}

async function sharingReview(request, context) {
  try {
    const config = getConfig();
    const access = await authorizedTask(request, config);
    if (access.error) return access.error;
    const scan = await scanSharing({ graph: createGraphClient(config), workspaceId: access.task.workspaceId });
    // The drive id stays on the server; revocation targets are item and permission ids only.
    const { driveId, ...rest } = scan;
    return response({ source: "backend", executionMode: config.executionMode, ...rest });
  } catch (error) {
    if (error?.status === 403) return response({ error: "Sharing review needs the Sites.Read.All permission for the collector identity." }, 409);
    return failure(error, context, "Reviewing sharing");
  }
}

async function proposeRevocations(request, context) {
  try {
    const config = getConfig();
    const access = await authorizedTask(request, config);
    if (access.error) return access.error;
    const body = await request.json().catch(() => null);
    if (!body) return response({ error: "A request body is required." }, 400);

    const { actions, rejected } = await proposePermissionRevocations({
      task: access.task,
      targets: body.targets,
      reason: body.reason,
      actor: access.actor,
      graph: createGraphClient(config)
    });
    for (const action of actions) {
      const created = await createActionIfAbsent(config, action);
      if (!created) continue;
      await writeAudit(config, {
        auditId: `${action.actionId}-proposed`, caseId: action.caseId, eventType: "action-proposed", actionId: action.actionId,
        actionType: action.actionType, permissionId: action.permissionId, actorId: access.actor.id, actorName: access.actor.name || null, occurredAt: action.requestedAt
      });
    }
    return response({ executionMode: config.executionMode, actions, rejected });
  } catch (error) {
    if (error?.status === 403) return response({ error: "Sharing review needs the Sites.Read.All permission for the collector identity." }, 409);
    return failure(error, context, "Proposing revocations");
  }
}

async function confirmAction(request, context) {
  try {
    const config = getConfig();
    const access = await authorizedTask(request, config);
    if (access.error) return access.error;

    const live = config.executionMode === "live";
    if (live && !config.executorClientId) throw new ExecutionRuleError("Live execution is on but no executor identity is configured.");

    const foundAction = await readActionForUpdate(config, access.task.taskId, request.params.actionId);
    if (!foundAction) return response({ error: "Action not found." }, 404);
    const action = foundAction.record;
    if (!["proposed", "failed", "simulated"].includes(action.status)) return response({ error: `This action is already ${action.status}.` }, 409);

    const graph = live
      ? createGraphClient(config, { clientId: config.executorClientId, writable: true })
      : createGraphClient(config);
    const reserved = { ...action, status: "executing", executionStartedAt: new Date().toISOString(), executionStartedBy: access.actor.id };
    if (!(await updateActionIfUnchanged(config, reserved, foundAction.etag))) return response({ error: "Another confirmation started first. Refresh the action list." }, 409);
    const result = await executeAction({ action, actor: access.actor, graph, mode: live ? "live" : "dry-run" });
    await writeAction(config, result.action);
    await writeVerification(config, result.verification);
    await writeAudit(config, result.audit);
    return response({ executionMode: config.executionMode, action: result.action, verification: result.verification });
  } catch (error) {
    return failure(error, context, "Confirming the action");
  }
}

async function actionHistory(request, context) {
  try {
    const config = getConfig();
    const authorization = authorize(request, TENANT_READER_ROLES, { allowLocal: config.allowLocalAuth });
    if (!authorization.ok) return response({ error: authorization.error }, authorization.status);
    const limit = Math.min(Math.max(Number.parseInt(request.query.get("limit") || "200", 10) || 200, 1), 1000);
    const actions = await readActionHistory(config, { limit, workspaceId: request.query.get("workspaceId") || undefined });
    return response({ source: "backend", executionMode: config.executionMode, actions, meta: { count: actions.length } });
  } catch (error) {
    return failure(error, context, "Loading action history");
  }
}

app.http("ownerTaskMembers", { methods: ["GET"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/members", handler: taskMembers });
app.http("ownerTaskRemovals", { methods: ["POST"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/removals", handler: proposeRemovals });
app.http("ownerTaskSharing", { methods: ["GET"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/sharing", handler: sharingReview });
app.http("ownerTaskRevocations", { methods: ["POST"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/revocations", handler: proposeRevocations });
app.http("ownerActionConfirm", { methods: ["POST"], authLevel: "anonymous", route: "api/owner/tasks/{taskId}/actions/{actionId}/confirm", handler: confirmAction });
app.http("actionHistory", { methods: ["GET"], authLevel: "anonymous", route: "api/actions", handler: actionHistory });
