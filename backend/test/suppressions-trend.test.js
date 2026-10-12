import test from "node:test";
import assert from "node:assert/strict";
import { createSuppression, DEFAULT_SUPPRESSION_DAYS, MAX_SUPPRESSION_DAYS, revokeSuppression, SuppressionError } from "../src/lib/suppressions.js";
import { buildPosture } from "../src/lib/posture.js";
import { buildTrendPoint, summarizeTrend } from "../src/lib/trend.js";
import { evaluateWorkspace } from "../src/policies/workspace-health.js";

const actor = { id: "op1", name: "Operator" };
const now = new Date("2026-03-01T00:00:00Z");
const valid = { workspaceId: "t1", policyId: "workspace-owner-minimum-two", reason: "Single owner is intentional here.", actor, violationExists: true, now };

test("a tag needs a real reason, a bounded duration and an existing violation", () => {
  assert.throws(() => createSuppression({ ...valid, reason: "nope" }), /at least 10/);
  assert.throws(() => createSuppression({ ...valid, days: 0 }), SuppressionError);
  assert.throws(() => createSuppression({ ...valid, days: MAX_SUPPRESSION_DAYS + 1 }), /from 1 to 180/);
  assert.throws(() => createSuppression({ ...valid, violationExists: false }), /no open violation/);
  const record = createSuppression(valid);
  assert.equal(record.status, "active");
  assert.equal(new Date(record.expiresAt) - now, DEFAULT_SUPPRESSION_DAYS * 86_400_000);
});

test("a tag can be revoked once", () => {
  const record = createSuppression(valid);
  const revoked = revokeSuppression(record, actor, now);
  assert.equal(revoked.status, "revoked");
  assert.throws(() => revokeSuppression(revoked, actor, now), /already revoked/);
});

const evaluate = (workspace) => ({ ...workspace, health: evaluateWorkspace(workspace).health });
const workspaces = [
  evaluate({ id: "t1", name: "One", owners: ["A"], activityDays: null, activeChannels: null, exposure: "Unknown", guests: 2 }),
  evaluate({ id: "t2", name: "Two", owners: ["A"], activityDays: null, activeChannels: null, exposure: "High", guests: 1 })
];

test("a tagged violation leaves the open counts but stays visible with its reason", () => {
  const suppression = createSuppression(valid);
  const result = buildPosture(workspaces, [
    { status: "active", complianceStatus: "attention", resourceId: "t1", policyId: valid.policyId },
    { status: "active", complianceStatus: "attention", resourceId: "t2", policyId: valid.policyId }
  ], [suppression], now);
  const ownership = result.policies.find((row) => row.policyId === valid.policyId);
  assert.equal(ownership.violating, 1);
  assert.equal(ownership.suppressed, 1);
  assert.equal(result.violations.open, 1);
  assert.equal(result.violations.suppressed, 1);
  const tagged = result.violationList.find((item) => item.workspaceId === "t1" && item.policyId === valid.policyId);
  assert.equal(tagged.suppression.reason, valid.reason);
});

test("an expired or revoked tag no longer hides anything", () => {
  const suppression = createSuppression({ ...valid, days: 1 });
  const later = new Date("2026-03-05T00:00:00Z");
  assert.equal(buildPosture(workspaces, [], [suppression], later).policies.find((row) => row.policyId === valid.policyId).violating, 2);
  const revoked = revokeSuppression(suppression, actor, now);
  assert.equal(buildPosture(workspaces, [], [revoked], now).policies.find((row) => row.policyId === valid.policyId).violating, 2);
});

test("a trend point keeps the Unknown bucket and trend changes are null when data is missing", () => {
  const posture = buildPosture(workspaces, []);
  const point = buildTrendPoint(workspaces, posture, "2026-03-01T03:00:00Z");
  assert.equal(point.day, "2026-03-01");
  assert.deepEqual(point.exposure, { High: 1, Medium: 0, Low: 0, Unknown: 1 });
  assert.equal(point.guests, 3);

  const later = { ...point, day: "2026-03-08", openViolations: point.openViolations + 2, guestsUnknown: 1, riskLevels: { ...point.riskLevels, High: 4 } };
  const summary = summarizeTrend([point, later]);
  assert.equal(summary.changes.openViolations, 2);
  assert.equal(summary.changes.guests, null);
  assert.equal(summarizeTrend([point]).changes, null);
});
