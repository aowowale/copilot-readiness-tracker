import { agentsFromTeamsApps } from "./agents.js";
import { buildAdoption, parseUsageReport, splitCopilotSkus, summarizeLicences } from "./copilot.js";

// Collection for the AI and agents views. Every call is read-only and fails soft: a source that
// cannot be read is reported with the reason, and what it would have shown stays Unknown.

const MAX_LICENSED_USERS = 20_000;
const enc = encodeURIComponent;

function reason(error, needs) {
  if (error?.status === 403 || error?.status === 401) return `Not permitted (${error.status}). The collector identity needs ${needs}.`;
  if (error?.status === 404) return "Not available in this tenant, cloud or API version (404).";
  return `Could not be read (${error?.status || error?.message || "error"}).`;
}

export async function collectAgents(graph, { evidenceAgents = [] } = {}) {
  const warnings = [];
  const agents = new Map();
  const sourcesRead = new Set();

  try {
    const apps = await graph.getAll(`/appCatalogs/teamsApps?$filter=${enc("distributionMethod eq 'organization'")}&$expand=${enc("appDefinitions($expand=bot)")}`);
    for (const agent of agentsFromTeamsApps(apps)) agents.set(agent.agentId, agent);
    sourcesRead.add("teams-app-catalog");
  } catch (error) {
    warnings.push(`Teams app catalog: ${reason(error, "AppCatalog.Read.All")}`);
  }

  if (evidenceAgents.length) sourcesRead.add("evidence-feed");
  for (const agent of evidenceAgents) agents.set(agent.agentId, agent);

  return { agents: [...agents.values()], sourcesRead, warnings };
}

export async function collectCopilot(graph, config, now = new Date(), evidenceUsageReport = null) {
  const sources = [];
  let skus;
  try {
    skus = await graph.getAll("/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits");
    sources.push({ source: "copilot-licences", status: "ok", detail: null });
  } catch (error) {
    return { licences: null, adoption: null, sources: [{ source: "copilot-licences", status: "failed", detail: reason(error, "Organization.Read.All") }] };
  }

  const { seats } = splitCopilotSkus(skus);
  if (!seats.length) {
    return { licences: summarizeLicences({ skus, licensedUsers: null }), adoption: null, sources: [...sources, { source: "copilot-usage", status: "skipped", detail: "No Microsoft 365 Copilot seat licence was found in this tenant." }] };
  }

  // Licence holders, per Copilot seat SKU. Needs the advanced-query header for the any() filter.
  let licensedUsers = null;
  try {
    const byId = new Map();
    for (const sku of seats) {
      const filter = enc(`assignedLicenses/any(l:l/skuId eq ${sku.skuId})`);
      const users = await graph.getAll(`/users?$filter=${filter}&$count=true&$select=id,displayName,userPrincipalName,accountEnabled&$top=999`, { ConsistencyLevel: "eventual" });
      for (const user of users) byId.set(user.id, user);
      if (byId.size > MAX_LICENSED_USERS) break;
    }
    licensedUsers = [...byId.values()].slice(0, MAX_LICENSED_USERS);
  } catch (error) {
    sources.push({ source: "copilot-licence-holders", status: "failed", detail: reason(error, "User.Read.All") });
  }
  const licences = summarizeLicences({ skus, licensedUsers });

  // The Copilot usage report. Tried on the stable path first, then the preview path.
  const betaBase = config.graphBaseUrl.replace(/\/v1\.0$/, "/beta");
  const attempts = [
    `${config.graphBaseUrl}/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D30')`,
    `${betaBase}/reports/getMicrosoft365CopilotUsageUserDetail(period='D30')`
  ];
  let report = evidenceUsageReport;
  let lastError = null;
  for (const url of report ? [] : attempts) {
    try {
      report = parseUsageReport(await graph.getText(url));
      break;
    } catch (error) {
      lastError = error;
      if (error?.status !== 404) break;
    }
  }
  if (!report) {
    sources.push({ source: "copilot-usage", status: "failed", detail: reason(lastError, "Reports.Read.All") });
    return { licences, adoption: null, licensedUsers, sources };
  }

  const adoption = buildAdoption({ licensedUsers, report, now });
  const evidenceDetail = evidenceUsageReport ? "Customer-approved Copilot usage export from the fresh evidence feed." : null;
  sources.push({ source: "copilot-usage", status: adoption.joinable ? "ok" : "partial", detail: adoption.reason || evidenceDetail });
  return { licences, adoption, licensedUsers, sources };
}
