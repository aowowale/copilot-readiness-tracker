import { caseFromFinding, evaluateWorkspace } from "../policies/workspace-health.js";

export async function reconcileWorkspaceHealth({ workspaces, evaluatedAt, repository }) {
  const evaluations = workspaces.map((workspace) => ({
    workspace,
    evaluation: evaluateWorkspace(workspace, { evaluatedAt })
  }));
  const resourceIds = evaluations.map(({ workspace }) => workspace.id);
  const existing = await repository.readFindingsForResources(resourceIds);
  const existingById = new Map(existing.map((finding) => [finding.findingId, finding]));
  const activeIds = new Set();
  const activeFindings = [];

  for (const { evaluation } of evaluations) {
    for (const finding of evaluation.findings) {
      const previous = existingById.get(finding.findingId);
      activeIds.add(finding.findingId);
      activeFindings.push({
        ...finding,
        firstDetectedAt: previous?.firstDetectedAt || previous?.evaluatedAt || finding.evaluatedAt,
        lastDetectedAt: finding.evaluatedAt,
        resolvedAt: null
      });
    }
  }

  const resolvedFindings = existing
    .filter((finding) => finding.status === "active" && !activeIds.has(finding.findingId))
    .map((finding) => ({ ...finding, status: "resolved", resolvedAt: evaluatedAt }));

  for (const finding of [...activeFindings, ...resolvedFindings]) {
    await repository.writeFinding(finding);
  }

  let casesCreated = 0;
  for (const finding of activeFindings) {
    const governanceCase = caseFromFinding(finding);
    if (governanceCase && await repository.createCaseIfAbsent(governanceCase)) casesCreated += 1;
  }

  return {
    workspaces: evaluations.map(({ workspace, evaluation }) => ({
      ...workspace,
      policyPackVersion: evaluation.policyPackVersion,
      evaluatedAt: evaluation.evaluatedAt,
      health: evaluation.health
    })),
    activeFindings,
    resolvedFindings,
    casesCreated
  };
}