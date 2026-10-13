import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/lib/csv.js";
import { buildAdoption, parseUsageReport, splitCopilotSkus, summarizeLicences } from "../src/lib/copilot.js";
import { agentsFromTeamsApps, buildAgentInventory, parseAgentsFeed } from "../src/lib/agents.js";
import { collectAgents, collectCopilot } from "../src/lib/ai-collect.js";
import { parseEvidenceFeed } from "../src/lib/evidence.js";

const now = new Date("2026-10-01T00:00:00Z");

test("the CSV reader handles quotes, commas, CRLF and a BOM", () => {
  const rows = parseCsv('\uFEFFName,Note\r\n"Smith, Ann","said ""hi"""\r\nBo,plain\r\n');
  assert.deepEqual(rows, [{ Name: "Smith, Ann", Note: 'said "hi"' }, { Name: "Bo", Note: "plain" }]);
  assert.deepEqual(parseCsv(""), []);
});

test("only per-user Copilot seat licences count as seats", () => {
  const skus = [
    { skuId: "s1", skuPartNumber: "Microsoft_365_Copilot", consumedUnits: 40, prepaidUnits: { enabled: 50 } },
    { skuId: "s2", skuPartNumber: "Microsoft_Copilot_Studio_Messages", consumedUnits: 1, prepaidUnits: { enabled: 1 } },
    { skuId: "s3", skuPartNumber: "SPE_E5" }
  ];
  const split = splitCopilotSkus(skus);
  assert.deepEqual(split.seats.map((sku) => sku.skuPartNumber), ["Microsoft_365_Copilot"]);
  const summary = summarizeLicences({ skus, licensedUsers: new Array(38).fill({}) });
  assert.equal(summary.seatsPurchased, 50);
  assert.equal(summary.seatsAssigned, 40);
  assert.equal(summary.seatsAvailable, 10);
  assert.equal(summary.licensedUserCount, 38);
  assert.deepEqual(summary.otherCopilotSkus, ["Microsoft_Copilot_Studio_Messages"]);
  assert.equal(summarizeLicences({ skus: [{ skuId: "x", skuPartNumber: "SPE_E5" }], licensedUsers: null }).hasCopilotSeats, false);
});

const csv = [
  "Report Refresh Date,User Principal Name,Display Name,Last Activity Date,Microsoft Teams Copilot Last Activity Date,Word Copilot Last Activity Date,Copilot Chat Last Activity Date",
  "2026-09-30,ann@contoso.com,Ann,2026-09-28,2026-09-28,,2026-09-20",
  "2026-09-30,bo@contoso.com,Bo,2026-07-01,,2026-07-01,",
  "2026-09-30,cy@contoso.com,Cy,,,,"
].join("\n");

test("the usage report is parsed into last activity per person and per app", () => {
  const report = parseUsageReport(csv);
  assert.equal(report.refreshDate, "2026-09-30");
  assert.equal(report.concealed, false);
  assert.equal(report.people[0].apps.microsoftteams, "2026-09-28");
  assert.equal(report.people[0].apps.copilotchat, "2026-09-20");
  assert.equal(report.people[2].lastActivityDate, null);
});

test("adoption joins licence holders to activity and lists idle seats, never-used first", () => {
  const licensedUsers = [
    { userPrincipalName: "Ann@contoso.com", displayName: "Ann", accountEnabled: true },
    { userPrincipalName: "bo@contoso.com", displayName: "Bo", accountEnabled: true },
    { userPrincipalName: "cy@contoso.com", displayName: "Cy", accountEnabled: true },
    { userPrincipalName: "dee@contoso.com", displayName: "Dee (not in report)", accountEnabled: false }
  ];
  const result = buildAdoption({ licensedUsers, report: parseUsageReport(csv), now });
  assert.equal(result.joinable, true);
  assert.equal(result.licensed, 4);
  assert.equal(result.activeUsers, 1);
  assert.equal(result.adoptionPct, 25);
  assert.deepEqual(result.reclaim.map((person) => person.userPrincipalName), ["cy@contoso.com", "dee@contoso.com", "bo@contoso.com"]);
  assert.equal(result.reclaim.at(-1).daysSinceActivity, 92);
  assert.equal(result.byApp.microsoftteams, 1);
});

test("concealed report names cannot be matched, so adoption is not computed", () => {
  const concealed = parseUsageReport("User Principal Name,Last Activity Date\n3F9A1C22AB,2026-09-28\n8B77D0E1CC,2026-09-29");
  assert.equal(concealed.concealed, true);
  const result = buildAdoption({ licensedUsers: [{ userPrincipalName: "ann@contoso.com" }], report: concealed, now });
  assert.equal(result.joinable, false);
  assert.equal(result.adoptionPct, null);
  assert.equal(result.activeUsers, 2);
  assert.deepEqual(result.reclaim, []);
  assert.match(result.reason, /conceals/);
});

test("agents from the Teams catalog need a bot, and owner and age stay Unknown", () => {
  const agents = agentsFromTeamsApps([
    { id: "a1", displayName: "HR Helper", distributionMethod: "organization", appDefinitions: [{ publishingState: "published", lastModifiedDateTime: "2026-01-01T00:00:00Z", bot: { id: "b" } }] },
    { id: "a2", displayName: "Plain tab app", distributionMethod: "organization", appDefinitions: [{ publishingState: "published" }] }
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].owners, null);
  assert.equal(agents[0].sharedWith, "Everyone");
  const inventory = buildAgentInventory(agents, { now, staleDays: 180 });
  assert.equal(inventory.agents[0].ownerState, "unknown");
  assert.equal(inventory.totals.ownerless, 0);
  assert.equal(inventory.totals.ownerUnknown, 1);
  assert.equal(inventory.totals.stale, 1);
});

test("the agents feed is validated and an empty owner list means no owner", () => {
  const { agents, problems } = parseAgentsFeed([
    { id: "x1", name: "Claims Bot", platform: "Copilot Studio", owners: [], lastModifiedAt: "2026-09-20", status: "Published", sharedWith: "Everyone", connectors: ["SharePoint"] },
    { name: "Unowned info", platform: "Power Platform" },
    { platform: "no name" }
  ]);
  assert.equal(agents.length, 2);
  assert.equal(problems.length, 1);
  const inventory = buildAgentInventory(agents, { now });
  const claims = inventory.agents.find((agent) => agent.name === "Claims Bot");
  assert.equal(claims.ownerState, "none");
  assert.equal(claims.broadlyShared, true);
  assert.equal(claims.stale, false);
  const unknown = inventory.agents.find((agent) => agent.name === "Unowned info");
  assert.equal(unknown.ownerState, "unknown");
  assert.equal(unknown.stale, null);
  assert.equal(inventory.totals.ownerless, 1);
  assert.throws(() => parseAgentsFeed("nope"), /array/);
});

test("the evidence feed carries agents alongside workspaces", () => {
  const feed = parseEvidenceFeed(JSON.stringify({ schemaVersion: 1, generatedAt: "2026-10-01T00:00:00Z", workspaces: {}, agents: [{ name: "Bot", owners: ["a@contoso.com"] }, { nope: true }] }));
  assert.equal(feed.agents.length, 1);
  assert.equal(feed.problems.length, 1);
});

test("agent collection merges catalog and feed, and a catalog failure is a warning not a crash", async () => {
  const graph = { getAll: async () => { const error = new Error("denied"); error.status = 403; throw error; } };
  const feedAgents = parseAgentsFeed([{ name: "Claims Bot" }]).agents;
  const result = await collectAgents(graph, { evidenceAgents: feedAgents });
  assert.equal(result.agents.length, 1);
  assert.deepEqual([...result.sourcesRead], ["evidence-feed"]);
  assert.match(result.warnings[0], /AppCatalog\.Read\.All/);
});

function fakeCopilotGraph({ skus, users = [], reportText, reportFails = false }) {
  return {
    urls: [],
    getAll: async function (path) {
      if (path.startsWith("/subscribedSkus")) return skus;
      if (path.startsWith("/users?")) return users;
      return [];
    },
    getText: async function (url) {
      this.urls.push(url);
      if (reportFails) { const error = new Error("nf"); error.status = 404; throw error; }
      return reportText;
    }
  };
}

test("Copilot collection reports licences and adoption when every source works", async () => {
  const graph = fakeCopilotGraph({
    skus: [{ skuId: "s1", skuPartNumber: "Microsoft_365_Copilot", consumedUnits: 2, prepaidUnits: { enabled: 5 } }],
    users: [{ id: "1", userPrincipalName: "ann@contoso.com" }, { id: "2", userPrincipalName: "cy@contoso.com" }],
    reportText: csv
  });
  const result = await collectCopilot(graph, { graphBaseUrl: "https://graph.example/v1.0" }, now);
  assert.equal(result.licences.seatsAvailable, 3);
  assert.equal(result.adoption.joinable, true);
  assert.equal(result.adoption.inactiveUsers, 1);
  assert.deepEqual(result.sources.map((item) => item.status), ["ok", "ok"]);
});

test("the usage report falls back to the preview path, and a missing report leaves adoption Unknown", async () => {
  const skus = [{ skuId: "s1", skuPartNumber: "Microsoft_365_Copilot", consumedUnits: 1, prepaidUnits: { enabled: 1 } }];
  const missing = fakeCopilotGraph({ skus, users: [{ id: "1", userPrincipalName: "ann@contoso.com" }], reportFails: true });
  const result = await collectCopilot(missing, { graphBaseUrl: "https://graph.example/v1.0" }, now);
  assert.equal(missing.urls.length, 2);
  assert.match(missing.urls[1], /\/beta\/reports\//);
  assert.equal(result.adoption, null);
  assert.equal(result.licences.seatsAssigned, 1);
  assert.equal(result.sources.at(-1).status, "failed");
  assert.match(result.sources.at(-1).detail, /404|Not available/);
});

test("a fresh evidence usage report bypasses unsupported sovereign-cloud report routes", async () => {
  const graph = fakeCopilotGraph({
    skus: [{ skuId: "s1", skuPartNumber: "Microsoft_365_Copilot", consumedUnits: 1, prepaidUnits: { enabled: 1 } }],
    users: [{ id: "1", userPrincipalName: "ann@contoso.com" }],
    reportFails: true
  });
  const evidenceReport = parseUsageReport(csv);
  const result = await collectCopilot(graph, { graphBaseUrl: "https://graph.microsoft.us/v1.0" }, now, evidenceReport);
  assert.equal(graph.urls.length, 0);
  assert.equal(result.adoption.joinable, true);
  assert.match(result.sources.at(-1).detail, /evidence feed/);
});

test("a tenant with no Copilot seat licence is reported as such, not as zero adoption", async () => {
  const graph = fakeCopilotGraph({ skus: [{ skuId: "x", skuPartNumber: "SPE_E5" }] });
  const result = await collectCopilot(graph, { graphBaseUrl: "https://graph.example/v1.0" }, now);
  assert.equal(result.licences.hasCopilotSeats, false);
  assert.equal(result.adoption, null);
  assert.equal(result.sources.at(-1).status, "skipped");
});
