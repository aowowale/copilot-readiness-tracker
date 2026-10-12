import test from "node:test";
import assert from "node:assert/strict";
import { buildGuestInventory } from "../src/lib/guests.js";
import { CATALOG, createRequest, decideRequest, RequestError, visibleRequests } from "../src/lib/requests.js";

const now = new Date("2026-10-01T00:00:00Z");
const guest = (id, name, mail, createdAt) => ({ id, displayName: name, mail, createdAt });

test("the guest inventory merges guests across workspaces and flags old accounts", () => {
  const shared = guest("g1", "Gail", "gail@partner.com", "2025-01-01T00:00:00Z");
  const result = buildGuestInventory([
    { id: "w1", name: "One", owners: ["A"], guests: 2, guestUsers: [shared, guest("g2", "Gus", "gus@other.org", "2026-09-01T00:00:00Z")] },
    { id: "w2", name: "Two", owners: [], guests: 1, guestUsers: [shared] },
    { id: "w3", name: "Three", owners: ["A"], guests: 0, guestUsers: [] },
    { id: "w4", name: "Four", owners: ["A"], guests: null }
  ], { now, reviewDays: 180 });

  assert.equal(result.totals.guestAccounts, 2);
  assert.equal(result.totals.workspacesWithGuests, 2);
  assert.equal(result.totals.workspacesUnknown, 1);
  assert.equal(result.totals.needReview, 1);
  assert.equal(result.totals.inOwnerlessWorkspaces, 1);
  assert.equal(result.guests[0].id, "g1");
  assert.equal(result.guests[0].workspaceCount, 2);
  assert.equal(result.guests[0].needsReview, true);
  assert.deepEqual(result.domains.map((item) => item.domain).sort(), ["other.org", "partner.com"]);
});

test("a capped guest list is reported as incomplete, and an unknown age is not a pass", () => {
  const result = buildGuestInventory([
    { id: "w1", name: "Big", owners: ["A"], guests: 30, guestUsers: [guest("g1", "Gail", "gail@partner.com", null)] }
  ], { now });
  assert.deepEqual(result.incomplete, [{ workspaceId: "w1", workspaceName: "Big", guests: 30, listed: 1 }]);
  assert.equal(result.guests[0].needsReview, null);
  assert.equal(result.totals.unknownAge, 1);
  assert.equal(result.totals.needReview, 0);
});

const actor = { id: "u1", name: "Requester" };
const valid = { templateId: "project-team", name: "Apollo Launch", purpose: "Coordinate the Apollo launch across three teams.", owners: ["a@contoso.com", "B@contoso.com"] };

test("a valid request is recorded as pending and never provisioned", () => {
  const record = createRequest({ input: valid, actor, now });
  assert.equal(record.status, "pending");
  assert.equal(record.provisioning, "not-executed");
  assert.equal(record.visibility, "Private");
  assert.deepEqual(record.owners, ["a@contoso.com", "b@contoso.com"]);
  assert.match(record.requestId, /^req-/);
});

test("guardrails reject weak or non-compliant requests", () => {
  const bad = (change, pattern) => assert.throws(() => createRequest({ input: { ...valid, ...change }, actor }), pattern);
  bad({ templateId: "nope" }, /catalog/);
  bad({ name: "x" }, /name must be/);
  bad({ name: "<script>alert(1)</script>" }, /name must be/);
  bad({ purpose: "short" }, /at least 20/);
  bad({ owners: ["a@contoso.com"] }, /at least 2/);
  bad({ owners: ["a@contoso.com", "A@contoso.com"] }, /at least 2/);
  bad({ owners: ["a@contoso.com", "not an email"] }, /user principal names/);
  bad({ visibility: "Public" }, /allows: Private/);
  bad({ guestsRequested: true }, /does not allow guests/);
  assert.doesNotThrow(() => createRequest({ input: { ...valid, templateId: "partner-collaboration", guestsRequested: true }, actor }));
  assert.ok(CATALOG.every((template) => template.minOwners >= 2));
});

test("decisions need a different person and cannot be repeated", () => {
  const pending = createRequest({ input: valid, actor, now });
  assert.throws(() => decideRequest({ request: pending, outcome: "approve", actor }), /own request/);
  assert.throws(() => decideRequest({ request: pending, outcome: "reject", reason: "no", actor: { id: "op1" } }), /reason/);
  const approved = decideRequest({ request: pending, outcome: "approve", actor: { id: "op1", name: "Op" }, now });
  assert.equal(approved.request.status, "approved");
  assert.equal(approved.request.provisioning, "not-executed");
  assert.equal(approved.audit.eventType, "workspace-request-approved");
  assert.throws(() => decideRequest({ request: approved.request, outcome: "reject", reason: "changed my mind", actor: { id: "op2" } }), RequestError);
});

test("requesters see only their own requests; operators see all", () => {
  const mine = createRequest({ input: valid, actor, now });
  const theirs = createRequest({ input: valid, actor: { id: "u2" }, now });
  assert.deepEqual(visibleRequests([mine, theirs], actor, false).map((item) => item.requestedBy), ["u1"]);
  assert.equal(visibleRequests([mine, theirs], actor, true).length, 2);
});
