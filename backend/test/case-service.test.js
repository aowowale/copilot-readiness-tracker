import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCaseTransition,
  CaseNotFoundError,
  CaseVersionConflictError
} from "../src/lib/case-service.js";

const actor = { id: "operator-1", name: "Governance operator" };

test("atomically persists a valid case transition and its audit event", async () => {
  const commits = [];
  const repository = {
    readCaseForUpdate: async () => ({
      record: { caseId: "case-1", status: "proposed", version: 2 },
      etag: "etag-2"
    }),
    commitCaseTransition: async (...args) => commits.push(args)
  };

  const result = await applyCaseTransition({
    caseId: "case-1",
    transition: "triage",
    expectedVersion: 2,
    actor,
    options: { occurredAt: "2026-09-23T12:00:00.000Z" },
    repository
  });

  assert.equal(result.record.version, 3);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][0].status, "triaged");
  assert.equal(commits[0][1].eventType, "case-transition");
  assert.equal(commits[0][2], "etag-2");
});

test("rejects stale versions without writing", async () => {
  let committed = false;
  const repository = {
    readCaseForUpdate: async () => ({
      record: { caseId: "case-1", status: "proposed", version: 3 },
      etag: "etag-3"
    }),
    commitCaseTransition: async () => { committed = true; }
  };

  await assert.rejects(
    applyCaseTransition({ caseId: "case-1", transition: "triage", expectedVersion: 2, actor, repository }),
    CaseVersionConflictError
  );
  assert.equal(committed, false);
});

test("reports a missing case", async () => {
  const repository = {
    readCaseForUpdate: async () => null,
    commitCaseTransition: async () => assert.fail("must not commit")
  };

  await assert.rejects(
    applyCaseTransition({ caseId: "missing", transition: "triage", expectedVersion: 0, actor, repository }),
    CaseNotFoundError
  );
});

test("maps an Azure ETag failure to a version conflict", async () => {
  const repository = {
    readCaseForUpdate: async () => ({
      record: { caseId: "case-1", status: "proposed", version: 0 },
      etag: "etag-0"
    }),
    commitCaseTransition: async () => {
      const error = new Error("Precondition failed");
      error.statusCode = 412;
      throw error;
    }
  };

  await assert.rejects(
    applyCaseTransition({ caseId: "case-1", transition: "triage", expectedVersion: 0, actor, repository }),
    CaseVersionConflictError
  );
});