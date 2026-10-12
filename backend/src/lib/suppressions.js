// False-positive tagging. A suppression hides one policy violation on one workspace from the
// open-violation counts for a limited time. It never changes the underlying finding, and it
// expires on its own, so a tag cannot quietly hide a problem forever.

export const MAX_SUPPRESSION_DAYS = 180;
export const DEFAULT_SUPPRESSION_DAYS = 90;
const MIN_REASON_LENGTH = 10;
const DAY_MS = 86_400_000;

export class SuppressionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "SuppressionError";
    this.status = status;
  }
}

const key = (workspaceId, policyId) => `${workspaceId}|${policyId}`.replace(/[^a-zA-Z0-9|._-]/g, "-").slice(0, 400);

export function createSuppression({ workspaceId, policyId, reason, days, actor, violationExists, now = new Date() }) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof policyId !== "string" || !policyId) {
    throw new SuppressionError("A workspace and a policy are required.");
  }
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < MIN_REASON_LENGTH) throw new SuppressionError(`Explain why this is a false positive (at least ${MIN_REASON_LENGTH} characters).`);
  const length = days === undefined ? DEFAULT_SUPPRESSION_DAYS : days;
  if (!Number.isInteger(length) || length < 1 || length > MAX_SUPPRESSION_DAYS) {
    throw new SuppressionError(`Days must be a whole number from 1 to ${MAX_SUPPRESSION_DAYS}.`);
  }
  if (!violationExists) throw new SuppressionError("That workspace has no open violation for this policy.", 409);

  return {
    suppressionId: key(workspaceId, policyId).replace("|", "--"),
    workspaceId,
    policyId,
    reason: text.slice(0, 500),
    status: "active",
    createdBy: actor.id,
    createdByName: actor.name || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(new Date(now).getTime() + length * DAY_MS).toISOString()
  };
}

export function revokeSuppression(suppression, actor, now = new Date()) {
  if (suppression.status !== "active") throw new SuppressionError("This tag is already revoked.", 409);
  return { ...suppression, status: "revoked", revokedBy: actor.id, revokedByName: actor.name || null, revokedAt: new Date(now).toISOString() };
}
