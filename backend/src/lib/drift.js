// Workspace drift: what changed between two collector snapshots. Only facts that are known on
// both sides are compared. A change to or from Unknown is a change in data availability, not
// in the workspace, so it is never reported as drift.

const EXPOSURE_RANK = { Low: 0, Medium: 1, High: 2 };

const FIELDS = [
  {
    field: "owners", label: "Owners",
    read: (ws) => (Array.isArray(ws.owners) ? ws.owners.length : null),
    judge: (from, to) => (to < from ? { direction: "worse", severity: to === 0 ? "high" : "medium" } : to > from ? { direction: "better", severity: "info" } : null)
  },
  {
    field: "guests", label: "Guests",
    read: (ws) => (Number.isFinite(ws.guests) ? ws.guests : null),
    judge: (from, to) => (to > from ? { direction: "worse", severity: to - from >= 5 ? "high" : "medium" } : to < from ? { direction: "better", severity: "info" } : null)
  },
  {
    field: "shadowUsers", label: "Shadow users",
    read: (ws) => (Number.isFinite(ws.shadowUsers?.count) ? ws.shadowUsers.count : null),
    judge: (from, to) => (to > from ? { direction: "worse", severity: "medium" } : to < from ? { direction: "better", severity: "info" } : null)
  },
  {
    field: "exposure", label: "Exposure",
    read: (ws) => (ws.exposure in EXPOSURE_RANK ? ws.exposure : null),
    judge: (from, to) => (EXPOSURE_RANK[to] > EXPOSURE_RANK[from] ? { direction: "worse", severity: "high" } : { direction: "better", severity: "info" })
  },
  {
    field: "privacy", label: "Privacy",
    read: (ws) => (ws.type === "Public team" || ws.type === "Private team" ? ws.type : null),
    judge: (from, to) => (to === "Public team" ? { direction: "worse", severity: "high" } : { direction: "better", severity: "info" })
  },
  {
    field: "sensitivityLabel", label: "Sensitivity label",
    read: (ws) => (Array.isArray(ws.labels) ? ws.labels.join(", ") || "None" : null),
    judge: (from, to) => (to === "None" ? { direction: "worse", severity: "high" } : from === "None" ? { direction: "better", severity: "info" } : { direction: "changed", severity: "medium" })
  },
  {
    field: "archived", label: "Archived",
    read: (ws) => (typeof ws.type === "string" ? ws.type === "Archived team" : null),
    judge: () => ({ direction: "changed", severity: "info" })
  }
];

const safe = (value) => String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);

export function diffWorkspaces(previous, current, detectedAt = new Date().toISOString()) {
  const before = new Map(previous.map((workspace) => [workspace.id, workspace]));
  const day = new Date(detectedAt).toISOString().slice(0, 10);
  const changes = [];

  for (const workspace of current) {
    const old = before.get(workspace.id);
    if (!old) continue;
    for (const rule of FIELDS) {
      const from = rule.read(old);
      const to = rule.read(workspace);
      if (from === null || to === null || from === to) continue;
      const verdict = rule.judge(from, to);
      if (!verdict) continue;
      changes.push({
        changeId: `${day}-${safe(workspace.id)}-${rule.field}`,
        day,
        detectedAt,
        workspaceId: workspace.id,
        workspaceName: workspace.name || workspace.id,
        field: rule.field,
        label: rule.label,
        from: String(from),
        to: String(to),
        ...verdict
      });
    }
  }
  return changes;
}
