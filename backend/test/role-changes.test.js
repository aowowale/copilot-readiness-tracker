import test from "node:test";
import assert from "node:assert/strict";
import { classifyEntitlements, createDryRunActions, normalizeRoleChange, parseRoleChangeFeed, proposeActions } from "../src/lib/role-changes.js";

test("normalizes a role change and records changed controlled attributes", () => {
  const roleChange = normalizeRoleChange({
    userId: "user-1",
    before: { department: "Finance", positionCode: "FIN-1" },
    after: { department: "Operations", positionCode: "OPS-1" },
    effectiveAt: "2026-09-17"
  });

  assert.deepEqual(roleChange.changedAttributes, ["department", "positionCode"]);
  assert.equal(roleChange.status, "proposed");
  assert.equal(roleChange.actionPosture, "dry-run");
});

test("proposes removal for access outside the new baseline and review for discretionary access", () => {
  const roleChange = normalizeRoleChange({ userId: "user-1", caseId: "case-1" });
  const entitlements = classifyEntitlements([
    { resourceId: "finance-team", classification: "role-based" },
    { resourceId: "project-team", classification: "project/discretionary" }
  ], { allowedResourceIds: ["operations-team", "project-team"] });
  const actions = proposeActions(entitlements, roleChange);

  assert.equal(actions.length, 2);
  assert.equal(actions[0].actionType, "remove-access");
  assert.equal(actions[1].actionType, "review-access");
  assert.ok(actions.every((action) => action.dryRun && action.requiresApproval));
});

test("parses a controlled feed without enabling tenant mutation", () => {
  const records = parseRoleChangeFeed(JSON.stringify({ roleChanges: [{ userId: "user-2", before: { department: "A" }, after: { department: "B" }, currentEntitlements: [{ resourceId: "old-team", classification: "role-based" }], allowedResourceIds: ["new-team"] }] }));
  assert.equal(records.length, 1);
  assert.equal(records[0].userId, "user-2");
  assert.equal(records[0].actionPosture, "dry-run");
  assert.equal(createDryRunActions(records[0])[0].actionType, "remove-access");
});

test("rejects duplicate case IDs and unsafe identifiers", () => {
  assert.throws(() => parseRoleChangeFeed(JSON.stringify([
    { caseId: "same/id", userId: "user-1" },
    { caseId: "same/id", userId: "user-2" }
  ])), /duplicate caseId/);
  const record = parseRoleChangeFeed(JSON.stringify([{ caseId: "safe/id", userId: "user-3" }]))[0];
  assert.equal(record.caseId, "safe-id");
});