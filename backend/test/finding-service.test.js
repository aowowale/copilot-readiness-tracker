import test from "node:test";
import assert from "node:assert/strict";
import { reconcileWorkspaceHealth } from "../src/lib/finding-service.js";

const evaluatedAt = "2026-09-23T12:00:00.000Z";

function workspace(owners) {
  return {
    id: "team-1",
    name: "Operations",
    type: "Private team",
    owners,
    activityDays: 2,
    activeChannels: 1,
    exposure: "Low",
    exposureCount: 0
  };
}

test("persists active findings and creates each case only once", async () => {
  const written = [];
  const cases = new Set();
  const repository = {
    readFindingsForResources: async () => [],
    writeFinding: async (finding) => written.push(finding),
    createCaseIfAbsent: async (governanceCase) => {
      if (cases.has(governanceCase.caseId)) return false;
      cases.add(governanceCase.caseId);
      return true;
    }
  };

  const result = await reconcileWorkspaceHealth({ workspaces: [workspace(["Adele"])], evaluatedAt, repository });
  assert.equal(result.activeFindings.length, 1);
  assert.equal(result.casesCreated, 1);
  assert.equal(result.workspaces[0].health.status, "attention");
  assert.equal(written[0].firstDetectedAt, evaluatedAt);
});

test("preserves first detection and does not replace an existing case", async () => {
  const previous = {
    findingId: "team-1-workspace-owner-minimum-two",
    resourceId: "team-1",
    policyId: "workspace-owner-minimum-two",
    status: "active",
    evaluatedAt: "2026-09-01T00:00:00.000Z",
    firstDetectedAt: "2026-09-01T00:00:00.000Z"
  };
  const written = [];
  const repository = {
    readFindingsForResources: async () => [previous],
    writeFinding: async (finding) => written.push(finding),
    createCaseIfAbsent: async () => false
  };

  const result = await reconcileWorkspaceHealth({ workspaces: [workspace([])], evaluatedAt, repository });
  assert.equal(result.casesCreated, 0);
  assert.equal(written[0].firstDetectedAt, previous.firstDetectedAt);
  assert.equal(written[0].lastDetectedAt, evaluatedAt);
});

test("resolves disappeared findings only for evaluated workspaces", async () => {
  const previous = {
    findingId: "team-1-workspace-owner-minimum-two",
    resourceId: "team-1",
    policyId: "workspace-owner-minimum-two",
    status: "active",
    firstDetectedAt: "2026-09-01T00:00:00.000Z"
  };
  const written = [];
  const repository = {
    readFindingsForResources: async (resourceIds) => resourceIds.includes("team-1") ? [previous] : [],
    writeFinding: async (finding) => written.push(finding),
    createCaseIfAbsent: async () => false
  };

  const result = await reconcileWorkspaceHealth({
    workspaces: [workspace(["Adele", "Alex"])],
    evaluatedAt,
    repository
  });
  assert.equal(result.activeFindings.length, 0);
  assert.equal(result.resolvedFindings.length, 1);
  assert.equal(written[0].status, "resolved");
  assert.equal(written[0].resolvedAt, evaluatedAt);
});