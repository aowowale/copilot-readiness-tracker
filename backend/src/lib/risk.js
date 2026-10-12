// Composite workspace risk. Every input is visible and reproducible. An input with no source is
// Unknown: it adds no points, shrinks the known maximum, and can never produce a "Low" level.
//
// The scoring shape is fixed in code (what counts as bad); a risk definition sets how much each
// input is worth and where the levels start. The default definition is model risk-v1.

export const RISK_MODEL_VERSION = "risk-v1";

export const DEFAULT_DEFINITION = Object.freeze({
  version: 0,
  weights: Object.freeze({ owners: 25, exposure: 25, guests: 10, shadowUsers: 15, sensitivityLabel: 10, highRiskObjects: 15 }),
  thresholds: Object.freeze({ high: 50, medium: 25 }),
  minCoverage: 0.5
});

const CADENCE_DAYS = { High: 90, Medium: 180, Low: 365, Unknown: 90 };

// Each input yields a fraction of its weight (0 = fine, 1 = worst) or null when Unknown.
const INPUTS = [
  {
    id: "owners",
    label: "Owners",
    evaluate(ws) {
      if (!Array.isArray(ws.owners)) return null;
      const count = ws.owners.length;
      return { fraction: count === 0 ? 1 : count === 1 ? 0.4 : 0, observed: `${count} owner${count === 1 ? "" : "s"}` };
    }
  },
  {
    id: "exposure",
    label: "Exposure",
    evaluate(ws) {
      const fraction = { high: 1, medium: 0.48, low: 0 }[String(ws.exposure || "").toLowerCase()];
      return fraction === undefined ? null : { fraction, observed: `${ws.exposure} exposure` };
    }
  },
  {
    id: "guests",
    label: "Guests",
    evaluate(ws) {
      if (!Number.isFinite(ws.guests)) return null;
      return { fraction: ws.guests === 0 ? 0 : ws.guests <= 5 ? 0.5 : 1, observed: `${ws.guests} guest${ws.guests === 1 ? "" : "s"}` };
    }
  },
  {
    id: "shadowUsers",
    label: "Shadow users",
    evaluate(ws) {
      const count = ws.shadowUsers?.count;
      if (!Number.isFinite(count)) return null;
      return { fraction: count === 0 ? 0 : count <= 5 ? 8 / 15 : 1, observed: `${count} shadow user${count === 1 ? "" : "s"}` };
    }
  },
  {
    id: "sensitivityLabel",
    label: "Sensitivity label",
    evaluate(ws) {
      if (!Array.isArray(ws.labels)) return null;
      return ws.labels.length ? { fraction: 0, observed: ws.labels.join(", ") } : { fraction: 1, observed: "No sensitivity label" };
    }
  },
  {
    id: "highRiskObjects",
    label: "High-risk objects",
    evaluate(ws) {
      if (!Number.isFinite(ws.highRiskObjects)) return null;
      return { fraction: ws.highRiskObjects === 0 ? 0 : ws.highRiskObjects <= 10 ? 8 / 15 : 1, observed: `${ws.highRiskObjects} object${ws.highRiskObjects === 1 ? "" : "s"}` };
    }
  }
];

export const INPUT_IDS = INPUTS.map((input) => input.id);

export function scoreWorkspace(workspace, definition = DEFAULT_DEFINITION) {
  const { weights, thresholds, minCoverage } = definition;
  const inputs = INPUTS.map((input) => {
    const result = input.evaluate(workspace || {});
    const max = weights[input.id];
    return {
      id: input.id,
      label: input.label,
      max,
      points: result ? Math.round(result.fraction * max) : null,
      observed: result ? result.observed : "Unknown"
    };
  });

  const known = inputs.filter((input) => input.points !== null);
  const knownMax = known.reduce((sum, input) => sum + input.max, 0);
  const rawPoints = known.reduce((sum, input) => sum + input.points, 0);
  const totalMax = inputs.reduce((sum, input) => sum + input.max, 0);
  const coverage = totalMax ? knownMax / totalMax : 0;
  const missing = inputs.filter((input) => input.points === null).map((input) => input.id);

  let score = null;
  let level = "Unknown";
  if (coverage >= minCoverage && knownMax > 0) {
    score = Math.round((rawPoints / knownMax) * 100);
    level = score >= thresholds.high ? "High" : score >= thresholds.medium ? "Medium" : "Low";
    if (level === "Low" && missing.length) level = "Unknown";
  }

  return {
    modelVersion: definition.version ? `${RISK_MODEL_VERSION}+definition-${definition.version}` : RISK_MODEL_VERSION,
    definitionVersion: definition.version || 0,
    score,
    scoreFloor: rawPoints,
    level,
    coverage: Math.round(coverage * 100) / 100,
    missing,
    inputs,
    renewalCadenceDays: CADENCE_DAYS[level]
  };
}
