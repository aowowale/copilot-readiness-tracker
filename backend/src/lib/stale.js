// Stale workspaces: no sourced activity for a long time. A workspace with no activity source is
// reported as Unknown, never as stale or active.

export const DEFAULT_STALE_DAYS = 180;

export function classifyStale(workspaces, staleDays = DEFAULT_STALE_DAYS) {
  const stale = [];
  let active = 0;
  let unknown = 0;
  for (const workspace of workspaces) {
    if (!Number.isFinite(workspace.activityDays)) { unknown += 1; continue; }
    if (workspace.activityDays > staleDays) {
      stale.push({ id: workspace.id, name: workspace.name, activityDays: workspace.activityDays, owners: workspace.owners ?? null });
    } else active += 1;
  }
  stale.sort((left, right) => right.activityDays - left.activityDays);
  return { thresholdDays: staleDays, stale, active, unknown };
}
