import test from "node:test";
import assert from "node:assert/strict";
import { baselineSnapshot, createBaselineRecord, previewBaseline, reconcileBaselineAlerts } from "../src/lib/baselines.js";

const NOW = new Date("2026-10-10T00:00:00Z");
const workspace = (overrides = {}) => ({
  id: "w1", name: "Finance", type: "Private team", owners: ["A", "B"], guests: 1,
  shadowUsers: { count: 0 }, exposure: "Low", labels: ["Internal"], ...overrides
});
const baseline = () => {
  const ws = workspace();
  const preview = previewBaseline({ workspace: ws, now: NOW });
  return createBaselineRecord({ preview, actor: { id: "approver", name: "Approver" }, reason: "Approved after business owner validation.", now: NOW });
};

test("baseline snapshots contain governance metadata only and keep missing fields Unknown", () => {
  const snapshot = baselineSnapshot(workspace({ owners: null, guests: null, labels: null, exposure: "Unknown" }));
  assert.equal(snapshot.owners, null);
  assert.equal(snapshot.guests, null);
  assert.equal(snapshot.labels, null);
  assert.equal(snapshot.exposure, null);
  assert.equal("ownerDetails" in snapshot, false);
});

test("preview surfaces a new baseline and a concise diff before approval", () => {
  const first = previewBaseline({ workspace: workspace(), now: NOW });
  assert.equal(first.isFirstBaseline, true);
  assert.equal(first.knownFields.includes("owners"), true);
  assert.equal(first.unknownFields.length, 0);
  const current = workspace({ guests: 4, exposure: "High" });
  const next = previewBaseline({ workspace: current, currentBaseline: baseline(), now: NOW });
  assert.equal(next.existingVersion, 1);
  assert.equal(next.changes.length, 2);
  assert.ok(next.changes.some(item => item.direction === "worse"));
});

test("baseline approval requires rationale, versions snapshots and attributes approval", () => {
  const preview = previewBaseline({ workspace: workspace(), now: NOW });
  assert.throws(() => createBaselineRecord({ preview, actor: { id: "a" }, reason: "short", now: NOW }), /10 characters/);
  const record = createBaselineRecord({ preview, actor: { id: "approver", name: "Approver" }, reason: "Approved after review.", now: NOW });
  assert.equal(record.version, 1);
  assert.equal(record.status, "active");
  assert.equal(record.approvedBy, "approver");
  const next = createBaselineRecord({ preview: { ...preview, workspaceName: "Finance" }, actor: { id: "approver" }, reason: "Confirmed the updated expected state.", current: record, now: NOW });
  assert.equal(next.version, 2);
});

test("worsening drift opens once, Unknown does not resolve it, and recovery resolves it", () => {
  const approved = baseline();
  const changed = workspace({ guests: 4, exposure: "High" });
  const first = reconcileBaselineAlerts({ baselines: [approved], workspaces: [changed], alerts: [], now: NOW });
  assert.equal(first.length, 2);
  assert.ok(first.every(item => item.status === "open" && item.cycle === 1));
  const second = reconcileBaselineAlerts({ baselines: [approved], workspaces: [changed], alerts: first, now: new Date("2026-10-11T00:00:00Z") });
  assert.equal(second.length, 2);
  assert.ok(second.every(item => item.cycle === 1));
  const unknown = reconcileBaselineAlerts({ baselines: [approved], workspaces: [workspace({ guests: null, exposure: "Unknown" })], alerts: second, now: new Date("2026-10-12T00:00:00Z") });
  assert.ok(unknown.every(item => item.status === "open" && item.currentUnknown));
  const recovered = reconcileBaselineAlerts({ baselines: [approved], workspaces: [workspace()], alerts: unknown, now: new Date("2026-10-13T00:00:00Z") });
  assert.ok(recovered.every(item => item.status === "resolved"));
  const worsenedAgain = reconcileBaselineAlerts({ baselines: [approved], workspaces: [changed], alerts: recovered, now: new Date("2026-10-14T00:00:00Z") });
  assert.ok(worsenedAgain.every(item => item.status === "open" && item.cycle === 2));
});

test("improvement from the approved baseline does not create a drift alert", () => {
  const approved = baseline();
  const improved = reconcileBaselineAlerts({ baselines: [approved], workspaces: [workspace({ guests: 0 })], alerts: [], now: NOW });
  assert.equal(improved.length, 0);
});
