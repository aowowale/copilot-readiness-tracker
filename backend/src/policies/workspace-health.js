const POLICY_PACK_VERSION = "workspace-health-v1";

export const workspacePolicies = [
  {
    id: "workspace-owner-minimum-two",
    version: "1.0.0",
    title: "At least two workspace owners",
    category: "ownership",
    severity: "high",
    automationLevel: "recommend",
    nativeControl: "SharePoint Advanced Management site ownership policy",
    expected: "Two or more active owners",
    rationale: "A second owner prevents abandoned workspaces and keeps business decisions with the people closest to the work.",
    recommendedAction: "Assign and validate at least two active business owners.",
    ownerRole: "Workspace.Owner",
    slaDays: 14,
    caseEligible: true,
    evaluate(workspace) {
      if (!Array.isArray(workspace.owners)) {
        return {
          status: "unknown",
          observed: "Owner source unavailable",
          evidence: { ownerCount: null, owners: null }
        };
      }
      const ownerCount = workspace.owners.length;
      return {
        status: ownerCount >= 2 ? "healthy" : "attention",
        observed: `${ownerCount} owner${ownerCount === 1 ? "" : "s"}`,
        evidence: { ownerCount, owners: Array.isArray(workspace.owners) ? workspace.owners : [] }
      };
    }
  },
  {
    id: "workspace-activity-source-available",
    version: "1.0.0",
    title: "Activity evidence is available",
    category: "activity",
    severity: "informational",
    automationLevel: "observe",
    nativeControl: "Tenant-approved Teams activity source",
    expected: "A sourced activity age and active-channel count",
    rationale: "Lifecycle decisions must not treat missing activity data as inactivity.",
    recommendedAction: "Connect or refresh the tenant-approved activity source.",
    ownerRole: "Governance.Operator",
    slaDays: null,
    caseEligible: false,
    evaluate(workspace) {
      const available = Number.isFinite(workspace.activityDays) && Number.isFinite(workspace.activeChannels);
      return {
        status: available ? "healthy" : "unknown",
        observed: available
          ? `${workspace.activityDays} days since activity; ${workspace.activeChannels} active channels`
          : "Activity source unavailable",
        evidence: {
          activityDays: workspace.activityDays ?? null,
          activeChannels: workspace.activeChannels ?? null
        }
      };
    }
  },
  {
    id: "workspace-exposure-source-available",
    version: "1.0.0",
    title: "Exposure evidence is available",
    category: "exposure",
    severity: "informational",
    automationLevel: "observe",
    nativeControl: "SharePoint Data Access Governance",
    expected: "A sourced SharePoint exposure classification",
    rationale: "Unknown exposure cannot be interpreted as safe for Copilot or broad collaboration.",
    recommendedAction: "Connect or refresh the approved SharePoint exposure report.",
    ownerRole: "Governance.Operator",
    slaDays: null,
    caseEligible: false,
    evaluate(workspace) {
      const available = workspace.exposure && workspace.exposure !== "Unknown";
      return {
        status: available ? "healthy" : "unknown",
        observed: available ? `${workspace.exposure} exposure` : "Exposure source unavailable",
        evidence: {
          exposure: workspace.exposure || "Unknown",
          exposureCount: Number.isFinite(workspace.exposureCount) ? workspace.exposureCount : null
        }
      };
    }
  }
];

function stableKey(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 512);
}

function dueAt(evaluatedAt, slaDays) {
  if (!Number.isInteger(slaDays)) return null;
  const date = new Date(evaluatedAt);
  date.setUTCDate(date.getUTCDate() + slaDays);
  return date.toISOString();
}

export function evaluateWorkspace(workspace, { evaluatedAt = new Date().toISOString() } = {}) {
  if (!workspace?.id) throw new Error("Workspace policy evaluation requires an id.");

  const factors = workspacePolicies.map((policy) => {
    const result = policy.evaluate(workspace);
    return {
      policyId: policy.id,
      policyVersion: policy.version,
      title: policy.title,
      category: policy.category,
      status: result.status,
      severity: policy.severity,
      observed: result.observed,
      expected: policy.expected,
      rationale: policy.rationale,
      recommendedAction: policy.recommendedAction,
      automationLevel: policy.automationLevel,
      nativeControl: policy.nativeControl,
      ownerRole: policy.ownerRole,
      evidence: result.evidence
    };
  });

  const findings = factors.filter((factor) => factor.status !== "healthy").map((factor) => {
    const policy = workspacePolicies.find((item) => item.id === factor.policyId);
    return {
      findingId: stableKey(`${workspace.id}-${factor.policyId}`),
      resourceId: workspace.id,
      resourceName: workspace.name || workspace.id,
      resourceType: workspace.type || "Workspace",
      policyPackVersion: POLICY_PACK_VERSION,
      ...factor,
      status: "active",
      complianceStatus: factor.status,
      caseEligible: policy.caseEligible,
      evaluatedAt,
      dueAt: dueAt(evaluatedAt, policy.slaDays),
      source: "normalized-workspace-snapshot"
    };
  });

  const attention = factors.filter((factor) => factor.status === "attention").length;
  const unknown = factors.filter((factor) => factor.status === "unknown").length;
  return {
    policyPackVersion: POLICY_PACK_VERSION,
    evaluatedAt,
    health: {
      status: attention ? "attention" : unknown ? "unknown" : "healthy",
      healthy: factors.length - attention - unknown,
      attention,
      unknown,
      total: factors.length,
      factors
    },
    findings
  };
}

export function caseFromFinding(finding) {
  if (!finding?.caseEligible || finding.complianceStatus !== "attention") return null;
  return {
    caseId: stableKey(`finding-${finding.findingId}`),
    caseType: "workspace-governance",
    findingId: finding.findingId,
    resourceId: finding.resourceId,
    resourceName: finding.resourceName,
    policyId: finding.policyId,
    policyVersion: finding.policyVersion,
    policyPackVersion: finding.policyPackVersion,
    severity: finding.severity,
    title: finding.title,
    rationale: finding.rationale,
    recommendedAction: finding.recommendedAction,
    ownerRole: finding.ownerRole,
    dueAt: finding.dueAt,
    status: "detected",
    actionPosture: "dry-run",
    version: 0,
    detectedAt: finding.evaluatedAt,
    updatedAt: finding.evaluatedAt
  };
}

export function policyCatalog() {
  return {
    policyPackVersion: POLICY_PACK_VERSION,
    policies: workspacePolicies.map(({ evaluate, caseEligible, ...policy }) => ({ ...policy, caseEligible }))
  };
}