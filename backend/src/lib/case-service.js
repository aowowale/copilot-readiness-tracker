import { transitionCase } from "./case-workflow.js";

export class CaseNotFoundError extends Error {}
export class CaseVersionConflictError extends Error {}

export async function applyCaseTransition({
  caseId,
  transition,
  expectedVersion,
  actor,
  options = {},
  repository
}) {
  const current = await repository.readCaseForUpdate(caseId);
  if (!current) throw new CaseNotFoundError("Case not found.");

  const currentVersion = Number(current.record.version) || 0;
  if (expectedVersion !== currentVersion) {
    throw new CaseVersionConflictError(
      `Case version ${expectedVersion} is stale; current version is ${currentVersion}.`
    );
  }

  const result = transitionCase(current.record, transition, actor, options);
  try {
    await repository.commitCaseTransition(result.record, result.audit, current.etag);
  } catch (error) {
    if (error?.statusCode === 409 || error?.statusCode === 412) {
      throw new CaseVersionConflictError("The case changed before this transition could be saved.");
    }
    throw error;
  }
  return result;
}