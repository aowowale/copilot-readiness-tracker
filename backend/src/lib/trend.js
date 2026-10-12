// One posture point per day, so exposure and violations can be shown over time. Counts keep
// an Unknown bucket: a trend never turns missing data into an improvement.

const dayOf = (iso) => new Date(iso).toISOString().slice(0, 10);

export function buildTrendPoint(workspaces, posture, collectedAt) {
  const exposure = { High: 0, Medium: 0, Low: 0, Unknown: 0 };
  let guests = 0;
  let guestsUnknown = 0;
  for (const workspace of workspaces) {
    const level = ["High", "Medium", "Low"].includes(workspace.exposure) ? workspace.exposure : "Unknown";
    exposure[level] += 1;
    if (Number.isFinite(workspace.guests)) guests += workspace.guests;
    else guestsUnknown += 1;
  }
  return {
    day: dayOf(collectedAt),
    collectedAt: new Date(collectedAt).toISOString(),
    discovered: posture.discovered,
    managedPct: posture.managedPct,
    riskLevels: posture.riskLevels,
    exposure,
    guests,
    guestsUnknown,
    openViolations: posture.violations.open,
    suppressedViolations: posture.violations.suppressed || 0
  };
}

// Compares the oldest and newest points in a window. A field is null when either end is unknown.
export function summarizeTrend(points) {
  if (points.length < 2) return { points: points.length, changes: null };
  const first = points[0];
  const last = points.at(-1);
  const delta = (read) => {
    const a = read(first);
    const b = read(last);
    return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
  };
  return {
    points: points.length,
    from: first.day,
    to: last.day,
    changes: {
      highRisk: delta((p) => p.riskLevels?.High),
      highExposure: delta((p) => p.exposure?.High),
      openViolations: delta((p) => p.openViolations),
      guests: first.guestsUnknown || last.guestsUnknown ? null : delta((p) => p.guests)
    }
  };
}
