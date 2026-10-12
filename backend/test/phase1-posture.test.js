import test from "node:test";
import assert from "node:assert/strict";
import { scoreWorkspace } from "../src/lib/risk.js";
import { findShadowUsers, parseSitePrincipalsFeed } from "../src/lib/shadow-users.js";
import { buildRunRecord, summarizeSources } from "../src/lib/runs.js";
import { buildPosture } from "../src/lib/posture.js";
import { evaluateWorkspace } from "../src/policies/workspace-health.js";

const known = {
  owners: ["A"], guests: 7, exposure: "High", labels: [], shadowUsers: { count: 3 }, highRiskObjects: 12
};

test("risk exposes every input and is reproducible", () => {
  const first = scoreWorkspace(known);
  assert.deepEqual(first, scoreWorkspace(known));
  assert.equal(first.inputs.length, 6);
  assert.equal(first.level, "High");
  assert.deepEqual(first.missing, []);
  assert.equal(first.renewalCadenceDays, 90);
});

test("a missing input is Unknown and never produces a Low level", () => {
  const result = scoreWorkspace({ owners: ["A", "B"], guests: 0, exposure: "Low", labels: ["Internal"], shadowUsers: { count: 0 } });
  assert.deepEqual(result.missing, ["highRiskObjects"]);
  assert.equal(result.level, "Unknown");
  assert.equal(result.renewalCadenceDays, 90);
});

test("a fully known low-risk workspace is Low", () => {
  const result = scoreWorkspace({ owners: ["A", "B"], guests: 0, exposure: "Low", labels: ["Internal"], shadowUsers: { count: 0 }, highRiskObjects: 0 });
  assert.equal(result.level, "Low");
  assert.equal(result.score, 0);
});

test("too little evidence yields no score", () => {
  const result = scoreWorkspace({ owners: ["A"], exposure: "Unknown" });
  assert.equal(result.score, null);
  assert.equal(result.level, "Unknown");
  assert.ok(result.scoreFloor >= 0);
});

test("shadow users are site principals that are not group members", () => {
  const principals = parseSitePrincipalsFeed(JSON.stringify({
    t1: [{ id: "u1", name: "In team" }, { id: "u2", name: "Direct only" }, { id: "g1", type: "group" }]
  }));
  const result = findShadowUsers(principals.t1, new Set(["u1"]));
  assert.equal(result.count, 1);
  assert.deepEqual(result.users, [{ id: "u2", name: "Direct only" }]);
});

test("no site-permission source means Unknown, not zero", () => {
  assert.equal(findShadowUsers(undefined, new Set(["u1"])), null);
});

test("the principals feed rejects invalid input", () => {
  assert.throws(() => parseSitePrincipalsFeed("not json"));
  assert.throws(() => parseSitePrincipalsFeed(JSON.stringify({ t1: "x" })));
  assert.deepEqual(parseSitePrincipalsFeed(""), {});
});

test("failed and stale sources stay visible", () => {
  const now = new Date("2026-01-03T00:00:00Z");
  const runs = [
    buildRunRecord({ source: "graph-teams", finishedAt: "2026-01-02T20:00:00Z", status: "ok", recordsRead: 5 }),
    buildRunRecord({ source: "graph-teams", finishedAt: "2026-01-01T00:00:00Z", status: "failed", error: "old" }),
    buildRunRecord({ source: "site-principals-feed", finishedAt: "2025-12-30T00:00:00Z", status: "partial", warnings: ["w"] })
  ];
  const summary = summarizeSources(runs, { now, staleHours: 36 });
  const teams = summary.find((item) => item.source === "graph-teams");
  const feed = summary.find((item) => item.source === "site-principals-feed");
  assert.equal(teams.status, "ok");
  assert.equal(teams.stale, false);
  assert.equal(feed.stale, true);
  assert.deepEqual(feed.warnings, ["w"]);
});

test("run records sort newest first by row key", () => {
  const older = buildRunRecord({ source: "a", finishedAt: "2026-01-01T00:00:00Z", status: "ok" });
  const newer = buildRunRecord({ source: "a", finishedAt: "2026-01-02T00:00:00Z", status: "ok" });
  assert.ok(newer.runId < older.runId);
});

test("posture separates managed from discovered and counts violations", () => {
  const evaluate = (workspace) => ({ ...workspace, health: evaluateWorkspace(workspace).health });
  const workspaces = [
    evaluate({ id: "1", name: "One", owners: ["A"], activityDays: null, activeChannels: null, exposure: "Unknown" }),
    evaluate({ id: "2", name: "Two", owners: ["A", "B"], activityDays: null, activeChannels: null, exposure: "Unknown" }),
    evaluate({ id: "3", name: "Three", owners: null, activityDays: null, activeChannels: null, exposure: "Unknown" })
  ];
  const result = buildPosture(workspaces, [
    { status: "active", complianceStatus: "attention" },
    { status: "resolved" }
  ]);
  const ownership = result.policies.find((row) => row.policyId === "workspace-owner-minimum-two");
  assert.equal(result.discovered, 3);
  assert.equal(ownership.evaluated, 2);
  assert.equal(ownership.violating, 1);
  assert.equal(ownership.notEvaluated, 1);
  assert.equal(result.violations.open, 1);
  assert.equal(result.violations.fixed, 1);
  assert.equal(result.topRules[0].policyId, "workspace-owner-minimum-two");
});
