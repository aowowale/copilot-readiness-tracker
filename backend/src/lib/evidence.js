import { parseSitePrincipalsFeed } from "./shadow-users.js";
import { parseAgentsFeed } from "./agents.js";
import { parseUsageReport } from "./copilot.js";

// Workspace evidence feed. Some facts have no Graph source (SharePoint exposure and
// high-risk objects from Data Access Governance, legal hold and retention from Purview,
// site permissions, SharePoint activity). An administrator exports them and uploads one
// JSON file to the feeds container. The feed is validated, source-tagged and ignored
// once stale: an expired fact is Unknown again, never carried forward as current.

const MAX_WORKSPACES = 20000;
const MAX_COUNT = 10_000_000;
const EXPOSURE = new Set(["High", "Medium", "Low"]);
const COUNT_FIELDS = ["exposureCount", "highRiskObjects", "activityDays", "activeChannels"];
const BOOLEAN_FIELDS = ["legalHold", "retentionLocked", "rcd"];
const MAX_ONEDRIVE_SITES = 10000;
const ONEDRIVE_SHARING = new Set(["Disabled", "ExistingExternalUserSharingOnly", "ExternalUserSharingOnly", "ExternalUserAndGuestSharing", "Anyone"]);
const MAX_COPILOT_USAGE_CSV_BYTES = 20 * 1024 * 1024;

function parseOneDriveSites(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("The evidence feed onedrive field must be an array.");
  if (input.length > MAX_ONEDRIVE_SITES) throw new Error(`The evidence feed exceeds ${MAX_ONEDRIVE_SITES} OneDrive sites.`);
  const sites = [];
  const seen = new Set();
  for (const [index, site] of input.entries()) {
    if (!site || typeof site !== "object" || Array.isArray(site)) throw new Error(`OneDrive entry ${index + 1} must be an object.`);
    let url;
    try { url = new URL(site.url); } catch { throw new Error(`OneDrive entry ${index + 1} needs an absolute URL.`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || ![".sharepoint.com", ".sharepoint.us", ".sharepoint-mil.us"].some(suffix => host.endsWith(suffix))) throw new Error(`OneDrive entry ${index + 1} must use an HTTPS SharePoint URL.`);
    const key = url.toString().replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ownerUpn = typeof site.ownerUpn === "string" && site.ownerUpn.length <= 320 ? site.ownerUpn.trim().toLowerCase() : null;
    const lastActivity = site.lastActivityAt ? new Date(site.lastActivityAt) : null;
    if (lastActivity && Number.isNaN(lastActivity.valueOf())) throw new Error(`OneDrive entry ${index + 1} has an invalid lastActivityAt.`);
    const storageMb = site.storageMb === undefined || site.storageMb === null ? null : site.storageMb;
    if (storageMb !== null && (!Number.isFinite(storageMb) || storageMb < 0 || storageMb > 1_000_000_000)) throw new Error(`OneDrive entry ${index + 1} storageMb must be a non-negative number.`);
    const sharingCapability = ONEDRIVE_SHARING.has(site.sharingCapability) ? site.sharingCapability : null;
    sites.push({
      siteKey: key,
      url: url.toString().replace(/\/$/, ""),
      title: typeof site.title === "string" ? site.title.slice(0, 200) : null,
      ownerUpn,
      lastActivityAt: lastActivity?.toISOString() || null,
      storageMb,
      sharingCapability,
      lockState: typeof site.lockState === "string" ? site.lockState.slice(0, 40) : null,
      status: typeof site.status === "string" ? site.status.slice(0, 40) : null,
      source: "sharepoint-online-admin-export"
    });
  }
  return sites;
}

export function parseEvidenceFeed(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The evidence feed is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The evidence feed must be a JSON object.");
  if (parsed.schemaVersion !== 1) throw new Error("The evidence feed schemaVersion must be 1.");

  const generatedAt = new Date(parsed.generatedAt);
  if (Number.isNaN(generatedAt.valueOf())) throw new Error("The evidence feed needs a valid generatedAt timestamp.");
  if (!parsed.workspaces || typeof parsed.workspaces !== "object" || Array.isArray(parsed.workspaces)) {
    throw new Error("The evidence feed needs a workspaces object keyed by team id.");
  }
  const ids = Object.keys(parsed.workspaces);
  if (ids.length > MAX_WORKSPACES) throw new Error(`The evidence feed exceeds ${MAX_WORKSPACES} workspaces.`);

  const workspaces = {};
  const problems = [];
  for (const id of ids) {
    const entry = parsed.workspaces[id];
    if (!entry || typeof entry !== "object") {
      problems.push(`${id}: entry is not an object`);
      continue;
    }
    const clean = {};
    if (entry.exposure !== undefined) {
      if (EXPOSURE.has(entry.exposure)) clean.exposure = entry.exposure;
      else problems.push(`${id}: exposure must be High, Medium or Low`);
    }
    for (const field of COUNT_FIELDS) {
      if (entry[field] === undefined) continue;
      if (Number.isInteger(entry[field]) && entry[field] >= 0 && entry[field] <= MAX_COUNT) clean[field] = entry[field];
      else problems.push(`${id}: ${field} must be a non-negative integer`);
    }
    for (const field of BOOLEAN_FIELDS) {
      if (entry[field] === undefined) continue;
      if (typeof entry[field] === "boolean") clean[field] = entry[field];
      else problems.push(`${id}: ${field} must be true or false`);
    }
    if (entry.sitePrincipals !== undefined) clean.sitePrincipals = entry.sitePrincipals;
    workspaces[id] = clean;
  }

  const sources = {};
  if (parsed.sources && typeof parsed.sources === "object") {
    for (const [field, label] of Object.entries(parsed.sources)) {
      if (typeof label === "string") sources[field.slice(0, 50)] = label.slice(0, 200);
    }
  }
  // Agents that no tenant API lists (Copilot Studio and Power Platform exports, Agent 365).
  const { agents, problems: agentProblems } = parseAgentsFeed(parsed.agents);
  const onedrive = parseOneDriveSites(parsed.onedrive);
  let copilotUsage = null;
  if (parsed.copilotUsageCsv !== undefined) {
    if (typeof parsed.copilotUsageCsv !== "string" || Buffer.byteLength(parsed.copilotUsageCsv) > MAX_COPILOT_USAGE_CSV_BYTES) throw new Error("The evidence feed copilotUsageCsv must be a string no larger than 20 MB.");
    copilotUsage = parseUsageReport(parsed.copilotUsageCsv);
    if (copilotUsage.people.length > MAX_WORKSPACES) throw new Error(`The Copilot usage export exceeds ${MAX_WORKSPACES} users.`);
  }
  return { generatedAt: generatedAt.toISOString(), sources, workspaces, agents, onedrive, onedriveComplete: parsed.onedriveComplete === true, copilotUsage, problems: [...problems, ...agentProblems] };
}

export function sitePrincipalsFromEvidence(feed) {
  const map = {};
  for (const [id, entry] of Object.entries(feed.workspaces)) {
    if (entry.sitePrincipals !== undefined) map[id] = entry.sitePrincipals;
  }
  return parseSitePrincipalsFeed(JSON.stringify(map));
}

export function evidenceAgeHours(feed, now = new Date()) {
  return Math.max(0, Math.round(((now - new Date(feed.generatedAt)) / 3_600_000) * 10) / 10);
}

// Overlays fresh evidence onto collected workspaces. A stale feed applies nothing.
export function applyEvidence(workspaces, feed, { now = new Date(), maxAgeHours = 72 } = {}) {
  const ageHours = evidenceAgeHours(feed, now);
  if (ageHours > maxAgeHours) {
    return { workspaces, applied: 0, missing: workspaces.length, stale: true, ageHours };
  }

  let applied = 0;
  const merged = workspaces.map((workspace) => {
    const { sitePrincipals, ...facts } = feed.workspaces[workspace.id] || {};
    const fields = Object.keys(facts);
    if (!fields.length) return workspace;
    applied += 1;
    return { ...workspace, ...facts, evidence: { generatedAt: feed.generatedAt, fields, sources: feed.sources } };
  });
  return { workspaces: merged, applied, missing: workspaces.length - applied, stale: false, ageHours };
}
