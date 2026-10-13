import test from "node:test";
import assert from "node:assert/strict";
import { applyEvidence, evidenceAgeHours, parseEvidenceFeed, sitePrincipalsFromEvidence } from "../src/lib/evidence.js";
import { scoreWorkspace } from "../src/lib/risk.js";
import { deleteGate } from "../src/lib/owner-tasks.js";

const feedText = (overrides = {}) => JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-10-08T00:00:00Z",
  sources: { exposure: "SharePoint Data Access Governance report" },
  workspaces: {
    t1: { exposure: "High", highRiskObjects: 12, legalHold: false, retentionLocked: false, rcd: true, sitePrincipals: [{ id: "u1" }] },
    t2: { exposure: "Severe", highRiskObjects: -1, legalHold: "no", activityDays: 4 }
  },
  ...overrides
});

const base = (id) => ({ id, name: id, owners: ["A", "B"], guests: 0, labels: ["Internal"], shadowUsers: { count: 0 }, exposure: "Unknown", highRiskObjects: null, legalHold: null, retentionLocked: null, rcd: false });

test("a valid feed is parsed and invalid fields are rejected with a reason", () => {
  const feed = parseEvidenceFeed(feedText());
  assert.equal(feed.workspaces.t1.exposure, "High");
  assert.deepEqual(feed.workspaces.t2, { activityDays: 4 });
  assert.equal(feed.problems.length, 3);
});

test("a malformed or unsupported feed is refused", () => {
  assert.throws(() => parseEvidenceFeed("nope"), /not valid JSON/);
  assert.throws(() => parseEvidenceFeed(feedText({ schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => parseEvidenceFeed(feedText({ generatedAt: "yesterday" })), /generatedAt/);
  assert.throws(() => parseEvidenceFeed(feedText({ workspaces: [] })), /workspaces/);
});

test("fresh evidence fills Unknown facts and records its provenance", () => {
  const feed = parseEvidenceFeed(feedText());
  const now = new Date("2026-10-09T00:00:00Z");
  const result = applyEvidence([base("t1"), base("t3")], feed, { now });
  const [t1, t3] = result.workspaces;
  assert.equal(result.stale, false);
  assert.equal(t1.exposure, "High");
  assert.equal(t1.highRiskObjects, 12);
  assert.equal(t1.rcd, true);
  assert.equal("sitePrincipals" in t1, false);
  assert.deepEqual(t1.evidence.fields.sort(), ["exposure", "highRiskObjects", "legalHold", "rcd", "retentionLocked"]);
  assert.equal(t3.exposure, "Unknown");
  assert.equal(result.missing, 1);
  assert.equal(scoreWorkspace(t1).missing.length, 0);
});

test("a stale feed applies nothing, so its facts return to Unknown", () => {
  const feed = parseEvidenceFeed(feedText());
  const now = new Date("2026-10-20T00:00:00Z");
  const result = applyEvidence([base("t1")], feed, { now, maxAgeHours: 72 });
  assert.equal(result.stale, true);
  assert.equal(result.workspaces[0].exposure, "Unknown");
  assert.equal(deleteGate(result.workspaces[0]).allowed, false);
  assert.ok(evidenceAgeHours(feed, now) > 72);
});

test("positive no-hold evidence is what opens the delete gate", () => {
  const feed = parseEvidenceFeed(feedText());
  const [fresh] = applyEvidence([base("t1")], feed, { now: new Date("2026-10-09T00:00:00Z") }).workspaces;
  assert.equal(deleteGate(fresh).allowed, true);
});

test("site principals in the feed feed shadow-user detection", () => {
  const principals = sitePrincipalsFromEvidence(parseEvidenceFeed(feedText()));
  assert.deepEqual(principals.t1, [{ id: "u1", name: null, type: "user" }]);
});

test("OneDrive admin metadata is validated without requiring or inspecting file contents", () => {
  const site = { url: "https://contoso-my.sharepoint.com/personal/user_contoso_com", title: "Personal site", ownerUpn: "USER@contoso.com", lastActivityAt: "2026-10-01T00:00:00Z", storageMb: 1200, sharingCapability: "Anyone", lockState: "Unlock", status: "Active" };
  const feed = parseEvidenceFeed(feedText({ onedrive: [site], onedriveComplete: true }));
  assert.equal(feed.onedrive.length, 1);
  assert.equal(feed.onedrive[0].ownerUpn, "user@contoso.com");
  assert.equal(feed.onedrive[0].sharingCapability, "Anyone");
  assert.equal(feed.onedriveComplete, true);
  assert.equal("files" in feed.onedrive[0], false);
  assert.throws(() => parseEvidenceFeed(feedText({ onedrive: [{ ...site, url: "http://contoso.sharepoint.com/personal/user" }] })), /HTTPS SharePoint URL/);
  assert.throws(() => parseEvidenceFeed(feedText({ onedrive: [{ ...site, storageMb: -1 }] })), /storageMb/);
});

test("Copilot usage CSV is parsed as freshness-governed evidence", () => {
  const csv = "Report Refresh Date,User Principal Name,Display Name,Last Activity Date,Microsoft Teams Copilot Last Activity Date\n2026-10-08,user@contoso.com,User,2026-10-07,2026-10-07\n";
  const feed = parseEvidenceFeed(feedText({ copilotUsageCsv: csv }));
  assert.equal(feed.copilotUsage.people.length, 1);
  assert.equal(feed.copilotUsage.people[0].userPrincipalName, "user@contoso.com");
  assert.throws(() => parseEvidenceFeed(feedText({ copilotUsageCsv: 42 })), /must be a string/);
});
