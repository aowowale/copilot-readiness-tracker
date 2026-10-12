// Agent inventory (Phase 3). Agents come from two kinds of source: the Teams app catalog (Graph,
// organisation-published apps that contain a bot) and an administrator-supplied feed for agents
// the tenant's APIs do not list (Copilot Studio and Power Platform exports, an Agent 365 export).
// Every record names its source. A fact a source does not provide is Unknown: an agent with no
// owner information is "owner unknown", never "ownerless".

export const DEFAULT_AGENT_STALE_DAYS = 180;
const DAY_MS = 86_400_000;
const SHARING = new Set(["Everyone", "Specific people", "Only owner"]);
const STATUS = new Set(["Published", "Draft", "Disabled"]);
const MAX_AGENTS = 5000;

const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const dateOf = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};

export function agentsFromTeamsApps(apps) {
  return apps
    .filter((app) => (app.appDefinitions || []).some((definition) => definition.bot))
    .map((app) => {
      const definitions = app.appDefinitions || [];
      const modified = definitions.map((definition) => dateOf(definition.lastModifiedDateTime)).filter(Boolean).sort().at(-1) || null;
      const state = String(definitions[0]?.publishingState || "").toLowerCase();
      return {
        agentId: `teams-${app.id}`,
        name: text(app.displayName, 200) || app.id,
        platform: "Teams app (bot)",
        source: "teams-app-catalog",
        owners: null,
        createdAt: null,
        lastModifiedAt: modified,
        status: state === "published" ? "Published" : "Unknown",
        // Published to the organisation catalog means anyone in the organisation can install it.
        sharedWith: app.distributionMethod === "organization" ? "Everyone" : "Unknown",
        connectors: null
      };
    });
}

export function parseAgentsFeed(list) {
  if (list === undefined) return { agents: [], problems: [] };
  if (!Array.isArray(list)) throw new Error("agents must be an array.");
  if (list.length > MAX_AGENTS) throw new Error(`The agents list exceeds ${MAX_AGENTS} entries.`);
  const agents = [];
  const problems = [];

  list.forEach((raw, index) => {
    const name = text(raw?.name, 200);
    if (!name) { problems.push(`agents[${index}]: a name is required`); return; }
    const owners = Array.isArray(raw.owners) ? raw.owners.map((owner) => text(owner, 200)).filter(Boolean).slice(0, 10) : null;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    agents.push({
      agentId: text(raw.id, 120) ? `feed-${text(raw.id, 120)}` : `feed-${slug}-${index}`,
      name,
      platform: text(raw.platform, 60) || "Other",
      source: "evidence-feed",
      owners,
      createdAt: dateOf(raw.createdAt),
      lastModifiedAt: dateOf(raw.lastModifiedAt),
      status: STATUS.has(raw.status) ? raw.status : "Unknown",
      sharedWith: SHARING.has(raw.sharedWith) ? raw.sharedWith : "Unknown",
      connectors: Array.isArray(raw.connectors) ? raw.connectors.map((item) => text(item, 80)).filter(Boolean).slice(0, 20) : null
    });
  });
  return { agents, problems };
}

export function buildAgentInventory(agents, { now = new Date(), staleDays = DEFAULT_AGENT_STALE_DAYS } = {}) {
  const enriched = agents.map((agent) => {
    const ageDays = agent.lastModifiedAt ? Math.floor((new Date(now) - new Date(agent.lastModifiedAt)) / DAY_MS) : null;
    return {
      ...agent,
      ownerState: agent.owners === null || agent.owners === undefined ? "unknown" : agent.owners.length ? "assigned" : "none",
      daysSinceModified: ageDays,
      stale: ageDays === null ? null : ageDays > staleDays,
      broadlyShared: agent.sharedWith === "Unknown" ? null : agent.sharedWith === "Everyone"
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  const byPlatform = new Map();
  for (const agent of enriched) byPlatform.set(agent.platform, (byPlatform.get(agent.platform) || 0) + 1);

  return {
    staleDays,
    totals: {
      agents: enriched.length,
      ownerless: enriched.filter((agent) => agent.ownerState === "none").length,
      ownerUnknown: enriched.filter((agent) => agent.ownerState === "unknown").length,
      stale: enriched.filter((agent) => agent.stale === true).length,
      staleUnknown: enriched.filter((agent) => agent.stale === null).length,
      broadlyShared: enriched.filter((agent) => agent.broadlyShared === true).length
    },
    byPlatform: [...byPlatform.entries()].map(([platform, count]) => ({ platform, count })).sort((left, right) => right.count - left.count),
    agents: enriched
  };
}
