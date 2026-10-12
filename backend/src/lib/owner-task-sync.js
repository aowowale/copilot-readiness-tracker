import { applyEscalation, buildOwnerTasks } from "./owner-tasks.js";

// Creates, refreshes and escalates owner tasks. Uses etags so the collector never
// overwrites a step or decision an owner saved while the run was in progress.
export async function syncOwnerTasks({ workspaces, repository, now = new Date() }) {
  const existing = await repository.readTasksWithEtag();
  const existingById = new Map(existing.map((entry) => [entry.record.taskId, entry]));
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  const { tasks: changed, created } = buildOwnerTasks({
    workspaces,
    existingTasks: existing.map((entry) => entry.record),
    now
  });

  const toWrite = new Map(changed.map((task) => [task.taskId, task]));
  for (const { record } of existing) {
    const escalated = applyEscalation(toWrite.get(record.taskId) || record, workspaceById.get(record.workspaceId), now);
    if (escalated) toWrite.set(record.taskId, escalated);
  }

  let written = 0;
  let conflicts = 0;
  let escalated = 0;
  for (const task of toWrite.values()) {
    const current = existingById.get(task.taskId);
    const ok = current
      ? await repository.updateTaskIfUnchanged(task, current.etag)
      : await repository.createTaskIfAbsent(task);
    if (ok) {
      written += 1;
      if (task.escalationLevel > (current?.record.escalationLevel || 0)) escalated += 1;
    } else conflicts += 1;
  }

  return { total: existing.length + created, created, written, escalated, conflicts };
}
