// Microsoft 365 Copilot licences and adoption. Licences come from the tenant's subscribed SKUs
// and each user's assigned licences; adoption comes from the Copilot usage report. If a source
// is unavailable the result says so: missing data is Unknown, never zero adoption.

import { normalizeHeader, parseCsv } from "./csv.js";

const DAY_MS = 86_400_000;
export const ADOPTION_WINDOW_DAYS = 30;

// Seat licences only. Copilot Studio messages, credits and agent SKUs are not per-user seats.
const NOT_A_SEAT = /(studio|credit|message|agent|metered|pay|security|capacity)/i;

export function splitCopilotSkus(skus) {
  const copilot = skus.filter((sku) => /copilot/i.test(sku.skuPartNumber || ""));
  return {
    seats: copilot.filter((sku) => !NOT_A_SEAT.test(sku.skuPartNumber)),
    other: copilot.filter((sku) => NOT_A_SEAT.test(sku.skuPartNumber))
  };
}

export function summarizeLicences({ skus, licensedUsers }) {
  const { seats, other } = splitCopilotSkus(skus);
  const rows = seats.map((sku) => {
    const enabled = sku.prepaidUnits?.enabled ?? null;
    const consumed = sku.consumedUnits ?? null;
    return {
      skuId: sku.skuId,
      skuPartNumber: sku.skuPartNumber,
      enabled,
      consumed,
      available: Number.isFinite(enabled) && Number.isFinite(consumed) ? Math.max(0, enabled - consumed) : null,
      suspended: sku.prepaidUnits?.suspended ?? 0
    };
  });
  const sum = (key) => (rows.length && rows.every((row) => Number.isFinite(row[key])) ? rows.reduce((total, row) => total + row[key], 0) : null);
  return {
    hasCopilotSeats: rows.length > 0,
    skus: rows,
    otherCopilotSkus: other.map((sku) => sku.skuPartNumber),
    seatsPurchased: sum("enabled"),
    seatsAssigned: sum("consumed"),
    seatsAvailable: sum("available"),
    licensedUserCount: Array.isArray(licensedUsers) ? licensedUsers.length : null
  };
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function parseUsageReport(text) {
  const rows = parseCsv(text);
  const people = [];
  let refreshDate = null;
  for (const row of rows) {
    const byHeader = Object.fromEntries(Object.entries(row).map(([header, value]) => [normalizeHeader(header), value]));
    refreshDate = refreshDate || toDate(byHeader.reportrefreshdate);
    const apps = {};
    for (const [header, value] of Object.entries(byHeader)) {
      if (header === "lastactivitydate" || !header.endsWith("lastactivitydate")) continue;
      const app = header.slice(0, -"lastactivitydate".length).replace(/copilot$/, "") || "copilot";
      const date = toDate(value);
      if (date) apps[app] = date.toISOString().slice(0, 10);
    }
    const lastActivity = toDate(byHeader.lastactivitydate);
    people.push({
      userPrincipalName: (byHeader.userprincipalname || "").toLowerCase(),
      displayName: byHeader.displayname || null,
      lastActivityDate: lastActivity ? lastActivity.toISOString().slice(0, 10) : null,
      apps
    });
  }
  // When the tenant conceals names in reports, the "UPN" is a hash and cannot be joined to users.
  const concealed = people.length > 0 && people.every((person) => person.userPrincipalName && !person.userPrincipalName.includes("@"));
  return { people, concealed, refreshDate: refreshDate ? refreshDate.toISOString().slice(0, 10) : null };
}

export function buildAdoption({ licensedUsers, report, now = new Date(), windowDays = ADOPTION_WINDOW_DAYS }) {
  const withinWindow = (isoDate) => isoDate && (new Date(now) - new Date(isoDate)) / DAY_MS <= windowDays;
  const byApp = {};
  for (const person of report.people) {
    if (!withinWindow(person.lastActivityDate)) continue;
    for (const [app, date] of Object.entries(person.apps)) if (withinWindow(date)) byApp[app] = (byApp[app] || 0) + 1;
  }
  const activeInReport = report.people.filter((person) => withinWindow(person.lastActivityDate)).length;

  if (report.concealed || !Array.isArray(licensedUsers)) {
    return {
      windowDays, refreshDate: report.refreshDate, joinable: false, reason: report.concealed ? "The tenant conceals user names in reports, so activity cannot be matched to licence holders." : "The licence holders could not be read.",
      licensed: Array.isArray(licensedUsers) ? licensedUsers.length : null, activeUsers: activeInReport, inactiveUsers: null, adoptionPct: null, byApp, reclaim: []
    };
  }

  const reportByUser = new Map(report.people.map((person) => [person.userPrincipalName, person]));
  const reclaim = [];
  let active = 0;
  for (const user of licensedUsers) {
    const person = reportByUser.get(String(user.userPrincipalName || "").toLowerCase());
    if (withinWindow(person?.lastActivityDate)) { active += 1; continue; }
    const last = person?.lastActivityDate || null;
    reclaim.push({
      userPrincipalName: user.userPrincipalName,
      displayName: user.displayName || null,
      accountEnabled: user.accountEnabled !== false,
      lastActivityDate: last,
      daysSinceActivity: last ? Math.floor((new Date(now) - new Date(last)) / DAY_MS) : null
    });
  }
  // Never-used seats first, then the longest idle.
  reclaim.sort((left, right) => (right.daysSinceActivity ?? Infinity) - (left.daysSinceActivity ?? Infinity));

  return {
    windowDays, refreshDate: report.refreshDate, joinable: true, reason: null,
    licensed: licensedUsers.length, activeUsers: active, inactiveUsers: reclaim.length,
    adoptionPct: licensedUsers.length ? Math.round((active / licensedUsers.length) * 1000) / 10 : null,
    byApp, reclaim
  };
}
