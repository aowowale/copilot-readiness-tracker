import { diffWorkspaces } from "./drift.js";

const KNOWN_EXPOSURE = new Set(["High", "Medium", "Low"]);
const safe = (value) => String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);

// Keep an approved baseline lean and limited to governance facts. Do not snapshot file names,
// user activity logs, or other content. Owner count is used rather than display names.
export function baselineSnapshot(workspace) {
  return {
    id: workspace.id,
    name: workspace.name || workspace.id,
    type: workspace.type || null,
    owners: Array.isArray(workspace.owners) ? workspace.owners.map((_, index) => `owner-${index + 1}`) : null,
    guests: Number.isFinite(workspace.guests) ? workspace.guests : null,
    shadowUsers: Number.isFinite(workspace.shadowUsers?.count) ? { count: workspace.shadowUsers.count } : null,
    exposure: KNOWN_EXPOSURE.has(workspace.exposure) ? workspace.exposure : null,
    labels: Array.isArray(workspace.labels) ? [...workspace.labels] : null
  };
}

export function previewBaseline({ workspace, currentBaseline = null, now = new Date() }) {
  if (!workspace?.id) throw new Error("A workspace is required to preview a baseline.");
  const snapshot = baselineSnapshot(workspace);
  const changes = currentBaseline?.snapshot
    ? diffWorkspaces([currentBaseline.snapshot], [snapshot], new Date(now).toISOString())
    : [];
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name || workspace.id,
    existingVersion: currentBaseline?.version || 0,
    isFirstBaseline: !currentBaseline,
    knownFields: ["owners", "guests", "shadowUsers", "exposure", "privacy", "sensitivity label"].filter((field) => {
      if (field === "owners") return Array.isArray(snapshot.owners);
      if (field === "guests") return Number.isFinite(snapshot.guests);
      if (field === "shadowUsers") return Number.isFinite(snapshot.shadowUsers?.count);
      if (field === "exposure") return KNOWN_EXPOSURE.has(snapshot.exposure);
      if (field === "privacy") return typeof snapshot.type === "string";
      return Array.isArray(snapshot.labels);
    }),
    unknownFields: ["owners", "guests", "shadowUsers", "exposure", "privacy", "sensitivity label"].filter((field) => {
      if (field === "owners") return !Array.isArray(snapshot.owners);
      if (field === "guests") return !Number.isFinite(snapshot.guests);
      if (field === "shadowUsers") return !Number.isFinite(snapshot.shadowUsers?.count);
      if (field === "exposure") return !KNOWN_EXPOSURE.has(snapshot.exposure);
      if (field === "privacy") return typeof snapshot.type !== "string";
      return !Array.isArray(snapshot.labels);
    }),
    changes,
    snapshot
  };
}

export function createBaselineRecord({ preview, actor, reason, current = null, now = new Date() }) {
  const text = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  if (text.length < 10) throw new Error("Explain why this baseline is approved (at least 10 characters).");
  const version = (current?.version || 0) + 1;
  const approvedAt = new Date(now).toISOString();
  return {
    baselineId: `${safe(preview.workspaceId)}-v${version}`,
    workspaceId: preview.workspaceId,
    workspaceName: preview.workspaceName,
    version,
    status: "active",
    snapshot: preview.snapshot,
    knownFields: preview.knownFields,
    unknownFields: preview.unknownFields,
    reason: text,
    approvedBy: actor.id,
    approvedByName: actor.name || null,
    approvedAt,
    updatedAt: approvedAt
  };
}

const fieldKnown = (baseline, workspace, field) => {
  switch (field) {
    case "owners": return Array.isArray(baseline.snapshot.owners) && Array.isArray(workspace.owners);
    case "guests": return Number.isFinite(baseline.snapshot.guests) && Number.isFinite(workspace.guests);
    case "shadowUsers": return Number.isFinite(baseline.snapshot.shadowUsers?.count) && Number.isFinite(workspace.shadowUsers?.count);
    case "exposure": return KNOWN_EXPOSURE.has(baseline.snapshot.exposure) && KNOWN_EXPOSURE.has(workspace.exposure);
    case "privacy": return typeof baseline.snapshot.type === "string" && typeof workspace.type === "string";
    case "sensitivityLabel": return Array.isArray(baseline.snapshot.labels) && Array.isArray(workspace.labels);
    default: return false;
  }
};

export function reconcileBaselineAlerts({ baselines, workspaces, alerts, now = new Date() }) {
  const when = new Date(now).toISOString();
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const alertsById = new Map(alerts.map((alert) => [alert.alertId, alert]));
  const next = new Map(alertsById);
  const touched = new Set();

  for (const baseline of baselines) {
    if (baseline.status !== "active") continue;
    const workspace = workspacesById.get(baseline.workspaceId);
    if (!workspace) continue;
    const changes = diffWorkspaces([baseline.snapshot], [workspace], when);
    const changesByField = new Map(changes.map((change) => [change.field, change]));
    for (const field of ["owners", "guests", "shadowUsers", "exposure", "privacy", "sensitivityLabel"]) {
      const alertId = `${safe(baseline.workspaceId)}-${field}`;
      const old = next.get(alertId);
      const change = changesByField.get(field);
      if (change && change.direction !== "better") {
        const isNewCycle = !old || old.status === "resolved";
        next.set(alertId, {
          alertId,
          workspaceId: workspace.id,
          workspaceName: workspace.name || baseline.workspaceName,
          field,
          label: change.label,
          baselineId: baseline.baselineId,
          baselineVersion: baseline.version,
          from: change.from,
          to: change.to,
          direction: change.direction,
          severity: change.severity,
          status: isNewCycle ? "open" : old.status,
          cycle: isNewCycle ? (old?.cycle || 0) + 1 : old.cycle,
          openedAt: isNewCycle ? when : old.openedAt,
          lastSeenAt: when,
          acknowledgedAt: isNewCycle ? null : old.acknowledgedAt || null,
          acknowledgedBy: isNewCycle ? null : old.acknowledgedBy || null,
          version: (old?.version || 0) + 1,
          currentUnknown: false
        });
        touched.add(alertId);
      } else if (old && ["open", "acknowledged"].includes(old.status)) {
        if (!fieldKnown(baseline, workspace, field)) {
          next.set(alertId, { ...old, lastCheckedAt: when, currentUnknown: true, version: (old.version || 0) + 1 });
        } else {
          next.set(alertId, { ...old, status: "resolved", resolvedAt: when, currentUnknown: false, version: (old.version || 0) + 1 });
        }
        touched.add(alertId);
      }
    }
  }

  return [...next.values()].filter((alert) => touched.has(alert.alertId));
}
