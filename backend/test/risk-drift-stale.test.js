import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEFINITION, scoreWorkspace } from "../src/lib/risk.js";
import { activateDefinition, DefinitionError, effectiveDefinition, previewDefinition, validateDefinition } from "../src/lib/risk-definitions.js";
import { diffWorkspaces } from "../src/lib/drift.js";
import { classifyStale } from "../src/lib/stale.js";
import { buildPosture } from "../src/lib/posture.js";

const actor = { id: "ap1", name: "Approver" };
const known = { owners: ["A"], guests: 7, exposure: "High", labels: [], shadowUsers: { count: 3 }, highRiskObjects: 12 };
const goodDefinition = { weights: { owners: 25, exposure: 25, guests: 10, shadowUsers: 15, sensitivityLabel: 10, highRiskObjects: 15 }, thresholds: { high: 50, medium: 25 }, minCoverage: 0.5 };

test("the default definition reproduces risk-v1 exactly", () => {
  const result = scoreWorkspace(known);
  assert.equal(result.modelVersion, "risk-v1");
  assert.equal(result.definitionVersion, 0);
  assert.deepEqual(result.inputs.map((input) => input.points), [10, 25, 10, 8, 10, 15]);
  assert.equal(scoreWorkspace(known, effectiveDefinition(null)).score, scoreWorkspace(known, DEFAULT_DEFINITION).score);
});

test("a custom definition changes weights and thresholds and is recorded in the result", () => {
  const custom = { version: 3, ...validateDefinition({ ...goodDefinition, weights: { ...goodDefinition.weights, exposure: 50, guests: 0 }, thresholds: { high: 80, medium: 40 } }) };
  const result = scoreWorkspace(known, custom);
  assert.equal(result.modelVersion, "risk-v1+definition-3");
  assert.equal(result.inputs.find((input) => input.id === "exposure").max, 50);
  assert.equal(result.inputs.find((input) => input.id === "guests").points, 0);
});

test("unsafe definitions are rejected", () => {
  const bad = (change) => () => validateDefinition({ ...goodDefinition, ...change });
  assert.throws(bad({ weights: { ...goodDefinition.weights, owners: -1 } }), DefinitionError);
  assert.throws(bad({ weights: { ...goodDefinition.weights, owners: 51 } }), /0 to 50/);
  assert.throws(bad({ weights: { owners: 25, exposure: 25, guests: 0, shadowUsers: 0, sensitivityLabel: 0, highRiskObjects: 0 } }), /three inputs/);
  assert.throws(bad({ thresholds: { high: 30, medium: 30 } }), /Thresholds/);
  assert.throws(bad({ minCoverage: 0.1 }), /Minimum evidence/);
});

test("a definition change needs a reason and increments the version", () => {
  assert.throws(() => activateDefinition({ input: goodDefinition, reason: "short", actor, current: null }), /at least 10/);
  const first = activateDefinition({ input: goodDefinition, reason: "Align with policy", actor, current: null });
  const second = activateDefinition({ input: goodDefinition, reason: "Raise the bar", actor, current: first });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(second.definitionId, "v0002");
});

test("a preview lists exactly the workspaces whose level would change", () => {
  const workspaces = [
    { id: "a", name: "A", ...known, risk: scoreWorkspace(known) },
    { id: "b", name: "B", owners: ["x", "y"], guests: 0, exposure: "Low", labels: ["Internal"], shadowUsers: { count: 0 }, highRiskObjects: 0, risk: { level: "Low" } }
  ];
  const strict = { ...goodDefinition, thresholds: { high: 95, medium: 90 } };
  const result = previewDefinition(workspaces, strict);
  assert.deepEqual(result.changes.map((change) => [change.workspaceId, change.from, change.to]), [["a", "High", "Low"]]);
  assert.deepEqual(result.before, { High: 1, Medium: 0, Low: 1, Unknown: 0 });
  assert.deepEqual(result.after, { High: 0, Medium: 0, Low: 2, Unknown: 0 });
});

const base = { id: "t1", name: "Ops", type: "Private team", owners: ["A", "B"], guests: 1, exposure: "Low", labels: ["Internal"], shadowUsers: { count: 0 } };

test("drift reports worsening and improving changes with a severity", () => {
  const current = { ...base, owners: ["A"], guests: 7, exposure: "High", type: "Public team", labels: [], shadowUsers: { count: 2 } };
  const changes = diffWorkspaces([base], [current], "2026-03-02T03:00:00Z");
  const byField = Object.fromEntries(changes.map((change) => [change.field, change]));
  assert.equal(byField.owners.severity, "medium");
  assert.equal(byField.guests.severity, "high");
  assert.equal(byField.exposure.direction, "worse");
  assert.equal(byField.privacy.severity, "high");
  assert.equal(byField.sensitivityLabel.severity, "high");
  assert.equal(byField.shadowUsers.direction, "worse");
  assert.equal(byField.owners.changeId, "2026-03-02-t1-owners");
  assert.equal(diffWorkspaces([current], [{ ...current, owners: ["A", "B"] }], "2026-03-02T03:00:00Z")[0].direction, "better");
});

test("losing every owner is a high-severity change", () => {
  assert.equal(diffWorkspaces([base], [{ ...base, owners: [] }])[0].severity, "high");
});

test("a change to or from Unknown is not drift", () => {
  const unknown = { ...base, owners: null, guests: null, exposure: "Unknown", labels: null, shadowUsers: null, type: "Team" };
  assert.deepEqual(diffWorkspaces([base], [unknown]), []);
  assert.deepEqual(diffWorkspaces([unknown], [base]), []);
  assert.deepEqual(diffWorkspaces([base], [base]), []);
  assert.deepEqual(diffWorkspaces([], [base]), []);
});

test("stale classification separates stale, active and Unknown activity", () => {
  const result = classifyStale([
    { id: "1", name: "Old", activityDays: 400, owners: ["A"] },
    { id: "2", name: "Fresh", activityDays: 5 },
    { id: "3", name: "NoSource", activityDays: null },
    { id: "4", name: "Older", activityDays: 900 }
  ], 180);
  assert.deepEqual(result.stale.map((item) => item.id), ["4", "1"]);
  assert.equal(result.active, 1);
  assert.equal(result.unknown, 1);
  assert.equal(buildPosture([{ id: "1", name: "Old", activityDays: 400 }], []).stale.stale.length, 1);
});
