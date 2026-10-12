// Self-service workspace requests and the provisioning catalog (Phase 3). A request is checked
// against its template's guardrails when it is submitted, then approved or rejected by a
// governance operator. Approval is recorded only; provisioning is a later, separately
// authorised step, so nothing here creates a workspace.

import { randomUUID } from "node:crypto";

export const CATALOG = Object.freeze([
  {
    templateId: "project-team",
    name: "Project team",
    description: "A time-bound team for a project. Internal people only.",
    visibility: ["Private"],
    guestsAllowed: false,
    minOwners: 2,
    defaultLifetimeDays: 365,
    sensitivityLabel: "Internal"
  },
  {
    templateId: "department",
    name: "Department or function",
    description: "A long-running team for an organisational unit.",
    visibility: ["Private", "Public"],
    guestsAllowed: false,
    minOwners: 2,
    defaultLifetimeDays: null,
    sensitivityLabel: "Internal"
  },
  {
    templateId: "partner-collaboration",
    name: "Partner collaboration",
    description: "A team that includes named external guests. Reviewed more often.",
    visibility: ["Private"],
    guestsAllowed: true,
    minOwners: 2,
    defaultLifetimeDays: 180,
    sensitivityLabel: "Confidential"
  }
]);

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

const NAME = /^[\p{L}\p{N} .&()'-]{3,64}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const GUID = /^[0-9a-fA-F-]{36}$/;
const MIN_PURPOSE = 20;

export function createRequest({ input, actor, now = new Date() }) {
  const template = CATALOG.find((item) => item.templateId === input?.templateId);
  if (!template) throw new RequestError("Choose a template from the catalog.");

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!NAME.test(name)) throw new RequestError("The name must be 3 to 64 characters: letters, numbers, spaces and . & ( ) ' -");
  const purpose = typeof input.purpose === "string" ? input.purpose.trim() : "";
  if (purpose.length < MIN_PURPOSE) throw new RequestError(`Describe the purpose in at least ${MIN_PURPOSE} characters.`);

  const visibility = input.visibility || template.visibility[0];
  if (!template.visibility.includes(visibility)) throw new RequestError(`This template allows: ${template.visibility.join(", ")}.`);

  const owners = Array.isArray(input.owners) ? [...new Set(input.owners.map((owner) => String(owner).trim().toLowerCase()).filter(Boolean))] : [];
  if (owners.length < template.minOwners) throw new RequestError(`Name at least ${template.minOwners} different owners.`);
  if (owners.length > 5) throw new RequestError("Name at most 5 owners.");
  if (owners.some((owner) => !EMAIL.test(owner) && !GUID.test(owner))) throw new RequestError("Owners must be user principal names (name@company.com) or user IDs.");

  const guestsRequested = input.guestsRequested === true;
  if (guestsRequested && !template.guestsAllowed) throw new RequestError("This template does not allow guests. Use Partner collaboration.");

  return {
    requestId: `req-${randomUUID()}`,
    requestType: "new-workspace",
    templateId: template.templateId,
    templateName: template.name,
    name,
    purpose: purpose.slice(0, 1000),
    visibility,
    owners,
    guestsRequested,
    sensitivityLabel: template.sensitivityLabel,
    lifetimeDays: template.defaultLifetimeDays,
    status: "pending",
    provisioning: "not-executed",
    requestedBy: actor.id,
    requestedByName: actor.name || null,
    requestedAt: new Date(now).toISOString(),
    version: 0
  };
}

export function decideRequest({ request, outcome, reason, actor, now = new Date() }) {
  if (request.status !== "pending") throw new RequestError(`This request is already ${request.status}.`, 409);
  if (!["approve", "reject"].includes(outcome)) throw new RequestError("Outcome must be approve or reject.");
  if (actor.id === request.requestedBy) throw new RequestError("You cannot decide your own request.", 403);
  const text = typeof reason === "string" ? reason.trim() : "";
  if (outcome === "reject" && text.length < 5) throw new RequestError("Give a reason when rejecting, so the requester knows what to change.");

  const decidedAt = new Date(now).toISOString();
  const updated = {
    ...request,
    status: outcome === "approve" ? "approved" : "rejected",
    decidedBy: actor.id,
    decidedByName: actor.name || null,
    decidedAt,
    decisionReason: text.slice(0, 500) || null,
    version: Number(request.version || 0) + 1
  };
  const audit = {
    auditId: `${request.requestId}-${updated.status}`,
    caseId: request.requestId,
    eventType: `workspace-request-${updated.status}`,
    requestId: request.requestId,
    actorId: actor.id,
    actorName: actor.name || null,
    occurredAt: decidedAt
  };
  return { request: updated, audit };
}

export function visibleRequests(requests, actor, isOperator) {
  return requests
    .filter((request) => isOperator || request.requestedBy === actor.id)
    .sort((left, right) => String(right.requestedAt).localeCompare(String(left.requestedAt)));
}
