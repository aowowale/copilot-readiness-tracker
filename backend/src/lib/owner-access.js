import { GOVERNANCE_QUEUE, canActOnTask } from "./owner-tasks.js";
import { readObjectId } from "./auth.js";

export const OWNER_ROLES = ["Workspace.Owner", "Governance.Operator"];

export function actorFor(request, principal) {
  return { id: readObjectId(request) || principal.id, name: principal.name, upn: principal.upn || null, roles: principal.roles };
}

// Queue tasks are worked by governance operators; everything else by an assignee.
export function mayAct(task, actor) {
  return canActOnTask(task, actor)
    || (task.assigneeIds.includes(GOVERNANCE_QUEUE.id) && actor.roles.includes("Governance.Operator"));
}
