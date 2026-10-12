import test from "node:test";
import assert from "node:assert/strict";
import { collectWorkspaces } from "../src/lib/collect.js";

test("preserves an owner query failure as unknown source data", async () => {
  const graph = {
    get: async (path) => path.startsWith("/groups/")
      ? { id: "team-1", displayName: "Operations", visibility: "Private", mailNickname: "operations" }
      : { isArchived: false },
    getAll: async (path) => {
      if (path.includes("/owners?")) throw new Error("Forbidden");
      return [];
    }
  };

  const result = await collectWorkspaces(graph, {
    pilotTeamIds: ["team-1"],
    maxWorkspaces: 0
  });

  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].owners, null);
  assert.deepEqual(result.workspaces[0].findings, ["Owner data is unavailable"]);
  assert.match(result.warnings[0], /Owners for Team team-1 could not be read/);
});
test("collects owner details with managers, labels, dates and shadow users", async () => {
  const graph = {
    get: async (path) => {
      if (path.startsWith("/users/o1/manager")) return { id: "m1", displayName: "Manager" };
      if (path.startsWith("/users/o2/manager")) { const e = new Error("none"); e.status = 404; throw e; }
      if (path.startsWith("/groups/")) {
        return { id: "team-1", displayName: "Ops", visibility: "Private", mailNickname: "ops", createdDateTime: "2025-01-01T00:00:00Z", assignedLabels: [] };
      }
      return { isArchived: false };
    },
    getAll: async (path) => {
      if (path.includes("/owners?")) return [{ id: "o1", displayName: "One" }, { id: "o2", displayName: "Two" }];
      if (path.includes("/members?")) return [{ id: "o1", userType: "Member" }, { id: "g1", userType: "Guest" }];
      return [];
    }
  };
  const sitePrincipals = { "team-1": [{ id: "o1", type: "user" }, { id: "x9", name: "Direct", type: "user" }] };

  const { workspaces, warnings } = await collectWorkspaces(graph, { pilotTeamIds: ["team-1"], maxWorkspaces: 0, sitePrincipals });
  const [workspace] = workspaces;
  assert.deepEqual(workspace.ownerDetails, [
    { id: "o1", displayName: "One", mail: null, managerId: "m1", managerName: "Manager", managerMail: null },
    { id: "o2", displayName: "Two", mail: null }
  ]);
  assert.deepEqual(workspace.labels, []);
  assert.equal(workspace.createdAt, "2025-01-01T00:00:00Z");
  assert.equal(workspace.guests, 1);
  assert.deepEqual(workspace.shadowUsers, { count: 1, users: [{ id: "x9", name: "Direct" }] });
  assert.equal(workspace.legalHold, null);
  assert.deepEqual(warnings, []);
});

test("without a site-permission feed shadow users stay Unknown", async () => {
  const graph = {
    get: async (path) => path.startsWith("/groups/") ? { id: "t", displayName: "T" } : { isArchived: false },
    getAll: async () => []
  };
  const { workspaces } = await collectWorkspaces(graph, { pilotTeamIds: ["t"], maxWorkspaces: 0 });
  assert.equal(workspaces[0].shadowUsers, null);
});
