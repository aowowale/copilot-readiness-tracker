// Policy coverage and violation KPIs, computed from the evaluated inventory and the
// findings store. Coverage counts only workspaces where a policy could be evaluated.

import { classifyStale, DEFAULT_STALE_DAYS } from "./stale.js";

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export function buildPosture(workspaces, findings = [], suppressions = [], now = new Date(), { staleDays = DEFAULT_STALE_DAYS } = {}) {
  const discovered = workspaces.length;
  const byPolicy = new Map();
  const violationList = [];
  const suppressed = new Map(
    suppressions
      .filter((item) => item.status === "active" && new Date(item.expiresAt) > now)
      .map((item) => [`${item.workspaceId}|${item.policyId}`, item])
  );

  for (const workspace of workspaces) {
    for (const factor of workspace.health?.factors || []) {
      const row = byPolicy.get(factor.policyId) || {
        policyId: factor.policyId,
        title: factor.title,
        severity: factor.severity,
        nativeControl: factor.nativeControl,
        evaluated: 0,
        unknown: 0,
        compliant: 0,
        violating: 0,
        suppressed: 0
      };
      if (factor.status === "unknown") row.unknown += 1;
      else {
        row.evaluated += 1;
        if (factor.status === "healthy") row.compliant += 1;
        else {
          const suppression = suppressed.get(`${workspace.id}|${factor.policyId}`) || null;
          if (suppression) row.suppressed += 1;
          else row.violating += 1;
          violationList.push({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            policyId: factor.policyId,
            title: factor.title,
            observed: factor.observed,
            severity: factor.severity,
            suppression: suppression && {
              suppressionId: suppression.suppressionId,
              reason: suppression.reason,
              expiresAt: suppression.expiresAt,
              createdBy: suppression.createdByName || suppression.createdBy
            }
          });
        }
      }
      byPolicy.set(factor.policyId, row);
    }
  }

  const policies = [...byPolicy.values()].map((row) => ({
    ...row,
    notEvaluated: discovered - row.evaluated,
    coveragePct: pct(row.evaluated, discovered),
    source: `/api/findings?policyId=${encodeURIComponent(row.policyId)}`
  }));

  const open = findings.filter((finding) => finding.status === "active" && finding.complianceStatus === "attention" && !suppressed.has(`${finding.resourceId}|${finding.policyId}`));
  const fixed = findings.filter((finding) => finding.status === "resolved");
  const topRules = policies
    .filter((row) => row.violating)
    .sort((left, right) => right.violating - left.violating)
    .slice(0, 5)
    .map((row) => ({ policyId: row.policyId, title: row.title, violating: row.violating }));

  const evaluatedAny = workspaces.filter((workspace) => (workspace.health?.factors || []).some((factor) => factor.status !== "unknown")).length;
  const riskLevels = { High: 0, Medium: 0, Low: 0, Unknown: 0 };
  for (const workspace of workspaces) riskLevels[workspace.risk?.level || "Unknown"] += 1;

  return {
    discovered,
    managed: evaluatedAny,
    unmanaged: discovered - evaluatedAny,
    managedPct: pct(evaluatedAny, discovered),
    policies,
    violations: { open: open.length, fixed: fixed.length, suppressed: violationList.filter((item) => item.suppression).length },
    violationList,
    topRules,
    stale: classifyStale(workspaces, staleDays),
    riskLevels
  };
}
