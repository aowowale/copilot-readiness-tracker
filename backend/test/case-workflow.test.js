import test from "node:test";
import assert from "node:assert/strict";
import { availableTransitions, rolesForTransition, transitionCase } from "../src/lib/case-workflow.js";

const actor = { id: "operator-1", name: "Governance operator" };

test("moves an existing proposed case into the governed lifecycle", () => {
  const result = transitionCase(
    { caseId: "case-1", status: "proposed", policyVersion: "ownership-v1" },
    "triage",
    actor,
    { occurredAt: "2026-09-23T12:00:00.000Z", reason: "Validated source evidence" }
  );

  assert.equal(result.record.status, "triaged");
  assert.equal(result.record.version, 1);
  assert.equal(result.audit.fromStatus, "proposed");
  assert.equal(result.audit.toStatus, "triaged");
  assert.equal(result.audit.policyVersion, "ownership-v1");
});

test("rejects skipped and unknown transitions", () => {
  assert.throws(
    () => transitionCase({ caseId: "case-1", status: "triaged" }, "execute", actor),
    /not allowed from triaged/
  );
  assert.throws(
    () => transitionCase({ caseId: "case-1", status: "triaged" }, "invent", actor),
    /Unknown case transition/
  );
});

test("prevents transitions from terminal states", () => {
  assert.throws(
    () => transitionCase({ caseId: "case-1", status: "closed" }, "triage", actor),
    /not allowed from closed/
  );
});

test("lists only valid transitions for the current state", () => {
  assert.deepEqual(availableTransitions("awaiting-approval"), ["approve", "reject", "grant-exception", "cancel"]);
});

test("separates operator, approver, and executor authority", () => {
  assert.deepEqual(rolesForTransition("triage"), ["Governance.Operator"]);
  assert.deepEqual(rolesForTransition("approve"), ["Approver"]);
  assert.deepEqual(rolesForTransition("execute"), ["Executor"]);
  assert.deepEqual(rolesForTransition("unknown"), []);
});

test("requires a case identity and authenticated actor", () => {
  assert.throws(() => transitionCase({}, "triage", actor), /caseId/);
  assert.throws(() => transitionCase({ caseId: "case-1" }, "triage", {}), /authenticated actor/);
});