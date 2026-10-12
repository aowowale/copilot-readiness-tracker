import test from "node:test";
import assert from "node:assert/strict";
import { caseFromFinding, evaluateWorkspace, policyCatalog } from "../src/policies/workspace-health.js";

const evaluatedAt = "2026-09-23T12:00:00.000Z";

function workspace(overrides = {}) {
  return {
    id: "team-1",
    name: "Operations",
    type: "Private team",
    owners: ["Adele", "Alex"],
    activityDays: 4,
    activeChannels: 3,
    exposure: "Low",
    exposureCount: 0,
    ...overrides
  };
}

test("reports healthy factors when all initial evidence meets policy", () => {
  const result = evaluateWorkspace(workspace(), { evaluatedAt });
  assert.equal(result.health.status, "healthy");
  assert.equal(result.health.healthy, 3);
  assert.deepEqual(result.findings, []);
});

test("creates an explainable owner finding and a stable dry-run case", () => {
  const result = evaluateWorkspace(workspace({ owners: ["Adele"] }), { evaluatedAt });
  const finding = result.findings.find((item) => item.policyId === "workspace-owner-minimum-two");

  assert.equal(result.health.status, "attention");
  assert.equal(finding.observed, "1 owner");
  assert.equal(finding.expected, "Two or more active owners");
  assert.equal(finding.dueAt, "2026-10-07T12:00:00.000Z");
  assert.equal(finding.findingId, "team-1-workspace-owner-minimum-two");

  const governanceCase = caseFromFinding(finding);
  assert.equal(governanceCase.caseId, "finding-team-1-workspace-owner-minimum-two");
  assert.equal(governanceCase.status, "detected");
  assert.equal(governanceCase.actionPosture, "dry-run");
});

test("keeps unavailable activity and exposure explicit without creating cases", () => {
  const result = evaluateWorkspace(workspace({
    activityDays: null,
    activeChannels: null,
    exposure: "Unknown"
  }), { evaluatedAt });

  assert.equal(result.health.status, "unknown");
  assert.equal(result.health.unknown, 2);
  assert.ok(result.findings.every((finding) => finding.complianceStatus === "unknown"));
  assert.ok(result.findings.every((finding) => caseFromFinding(finding) === null));
});

test("keeps unavailable ownership explicit without creating a false owner-gap case", () => {
  const result = evaluateWorkspace(workspace({ owners: null }), { evaluatedAt });
  const finding = result.findings.find((item) => item.policyId === "workspace-owner-minimum-two");

  assert.equal(result.health.status, "unknown");
  assert.equal(finding.complianceStatus, "unknown");
  assert.equal(finding.observed, "Owner source unavailable");
  assert.equal(caseFromFinding(finding), null);
});

test("rejects resources without stable identifiers", () => {
  assert.throws(() => evaluateWorkspace({ name: "Missing ID" }), /requires an id/);
});

test("publishes policy metadata without executable functions", () => {
  const catalog = policyCatalog();
  assert.equal(catalog.policyPackVersion, "workspace-health-v1");
  assert.equal(catalog.policies.length, 3);
  assert.ok(catalog.policies.every((policy) => policy.evaluate === undefined));
});