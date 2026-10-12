// Guest lifecycle: one inventory of external guests across all workspaces. Guest accounts are
// captured per workspace (capped), so the inventory says when a list is incomplete instead of
// presenting a partial list as complete. Sign-in activity is not collected (it needs extra
// permissions and licensing), so age is measured from when the guest account was created.

export const DEFAULT_GUEST_REVIEW_DAYS = 180;
const DAY_MS = 86_400_000;

const domainOf = (mail) => (typeof mail === "string" && mail.includes("@") ? mail.split("@").pop().toLowerCase() : null);

export function buildGuestInventory(workspaces, { now = new Date(), reviewDays = DEFAULT_GUEST_REVIEW_DAYS } = {}) {
  const byGuest = new Map();
  const incomplete = [];
  let workspacesWithGuests = 0;
  let unknownWorkspaces = 0;

  for (const workspace of workspaces) {
    if (!Number.isFinite(workspace.guests)) { unknownWorkspaces += 1; continue; }
    if (workspace.guests === 0) continue;
    workspacesWithGuests += 1;
    const listed = Array.isArray(workspace.guestUsers) ? workspace.guestUsers : [];
    if (listed.length < workspace.guests) incomplete.push({ workspaceId: workspace.id, workspaceName: workspace.name, guests: workspace.guests, listed: listed.length });

    const ownerless = Array.isArray(workspace.owners) && workspace.owners.length === 0;
    for (const guest of listed) {
      const entry = byGuest.get(guest.id) || {
        id: guest.id,
        displayName: guest.displayName,
        mail: guest.mail,
        domain: domainOf(guest.mail),
        createdAt: guest.createdAt || null,
        workspaces: []
      };
      entry.workspaces.push({ id: workspace.id, name: workspace.name, ownerless });
      byGuest.set(guest.id, entry);
    }
  }

  const guests = [...byGuest.values()].map((guest) => {
    const ageDays = guest.createdAt ? Math.floor((new Date(now) - new Date(guest.createdAt)) / DAY_MS) : null;
    return {
      ...guest,
      workspaceCount: guest.workspaces.length,
      ageDays,
      needsReview: ageDays === null ? null : ageDays > reviewDays,
      inOwnerlessWorkspace: guest.workspaces.some((workspace) => workspace.ownerless)
    };
  }).sort((left, right) => right.workspaceCount - left.workspaceCount || String(left.displayName).localeCompare(String(right.displayName)));

  const domains = new Map();
  for (const guest of guests) {
    const key = guest.domain || "Unknown";
    domains.set(key, (domains.get(key) || 0) + 1);
  }

  return {
    reviewDays,
    totals: {
      guestAccounts: guests.length,
      workspacesWithGuests,
      workspacesUnknown: unknownWorkspaces,
      needReview: guests.filter((guest) => guest.needsReview === true).length,
      unknownAge: guests.filter((guest) => guest.needsReview === null).length,
      inOwnerlessWorkspaces: guests.filter((guest) => guest.inOwnerlessWorkspace).length
    },
    domains: [...domains.entries()].map(([domain, count]) => ({ domain, count })).sort((left, right) => right.count - left.count),
    incomplete,
    guests
  };
}
