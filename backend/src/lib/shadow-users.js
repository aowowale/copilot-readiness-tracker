// Shadow users have access to a workspace's SharePoint site but are not members or
// owners of its Team or Microsoft 365 Group. Graph does not expose direct site
// permissions, so principals come from a controlled feed (for example a SharePoint
// Advanced Management permissions report). No feed entry means Unknown, never zero.

const MAX_FEED_PRINCIPALS = 2000;

export function parseSitePrincipalsFeed(json) {
  if (!json) return {};
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("SITE_PRINCIPALS_FEED_JSON is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SITE_PRINCIPALS_FEED_JSON must be an object keyed by workspace id.");
  }

  let total = 0;
  const feed = {};
  for (const [workspaceId, principals] of Object.entries(parsed)) {
    if (!Array.isArray(principals)) throw new Error(`Site principals for ${workspaceId} must be an array.`);
    total += principals.length;
    if (total > MAX_FEED_PRINCIPALS) throw new Error(`Site principals feed exceeds ${MAX_FEED_PRINCIPALS} entries.`);
    feed[workspaceId] = principals
      .filter((principal) => principal && typeof principal.id === "string" && principal.id)
      .map((principal) => ({
        id: principal.id.slice(0, 100),
        name: typeof principal.name === "string" ? principal.name.slice(0, 200) : null,
        type: principal.type === "group" ? "group" : "user"
      }));
  }
  return feed;
}

export function findShadowUsers(principals, memberIds, { limit = 25 } = {}) {
  if (!Array.isArray(principals) || !(memberIds instanceof Set)) return null;
  const shadow = principals.filter((principal) => principal.type === "user" && !memberIds.has(principal.id));
  return {
    count: shadow.length,
    users: shadow.slice(0, limit).map((principal) => ({ id: principal.id, name: principal.name || null }))
  };
}
