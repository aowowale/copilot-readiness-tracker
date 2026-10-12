import { DEFAULT_DEFINITION, INPUT_IDS, scoreWorkspace } from "./risk.js";

// Risk definitions: how much each input is worth and where the levels start. Changing one
// needs the Approver role and a reason, is versioned, and only takes effect at the next
// collector run. A preview shows which workspaces would change level before anyone saves.

export class DefinitionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DefinitionError";
    this.status = status;
  }
}

const MAX_WEIGHT = 50;

export function validateDefinition(input) {
  if (!input || typeof input !== "object") throw new DefinitionError("A definition is required.");
  const weights = {};
  for (const id of INPUT_IDS) {
    const value = input.weights?.[id];
    if (!Number.isInteger(value) || value < 0 || value > MAX_WEIGHT) {
      throw new DefinitionError(`The weight for ${id} must be a whole number from 0 to ${MAX_WEIGHT}.`);
    }
    weights[id] = value;
  }
  if (INPUT_IDS.filter((id) => weights[id] > 0).length < 3) throw new DefinitionError("At least three inputs must have a weight above 0, so one fact cannot decide the level alone.");

  const { high, medium } = input.thresholds || {};
  if (!Number.isInteger(high) || !Number.isInteger(medium) || medium < 1 || high > 100 || medium >= high) {
    throw new DefinitionError("Thresholds must be whole numbers with 1 <= medium < high <= 100.");
  }
  const minCoverage = input.minCoverage;
  if (typeof minCoverage !== "number" || minCoverage < 0.3 || minCoverage > 1) {
    throw new DefinitionError("Minimum evidence must be between 0.3 and 1, so a score is never based on too little data.");
  }
  return { weights, thresholds: { high, medium }, minCoverage };
}

export function activateDefinition({ input, reason, actor, current, now = new Date() }) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 10) throw new DefinitionError("Explain the change (at least 10 characters).");
  const next = validateDefinition(input);
  const version = (current?.version || 0) + 1;
  return {
    definitionId: `v${String(version).padStart(4, "0")}`,
    version,
    ...next,
    reason: text.slice(0, 500),
    changedBy: actor.id,
    changedByName: actor.name || null,
    changedAt: new Date(now).toISOString()
  };
}

export function previewDefinition(workspaces, candidate) {
  const validated = { version: -1, ...validateDefinition(candidate) };
  const before = { High: 0, Medium: 0, Low: 0, Unknown: 0 };
  const after = { High: 0, Medium: 0, Low: 0, Unknown: 0 };
  const changes = [];
  for (const workspace of workspaces) {
    const was = workspace.risk?.level || "Unknown";
    const now = scoreWorkspace(workspace, validated).level;
    before[was] += 1;
    after[now] += 1;
    if (was !== now) changes.push({ workspaceId: workspace.id, workspaceName: workspace.name, from: was, to: now });
  }
  return { before, after, changes };
}

export function effectiveDefinition(stored) {
  return stored ? { version: stored.version, weights: stored.weights, thresholds: stored.thresholds, minCoverage: stored.minCoverage } : DEFAULT_DEFINITION;
}
