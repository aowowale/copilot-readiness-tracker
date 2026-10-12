// Provisioning for an approved workspace request (Phase 3 execution). Runs only for a request
// that a different person approved, in the configured mode: dry-run (default) checks everything
// and creates nothing; live creates the Microsoft 365 group and Team with the executor
// identity, then re-reads the result before calling it provisioned.
//
// Sensitivity labels are applied only when an Approver/admin supplies the tenant's verified
// label-id mapping and the separate executor has Group.ReadWrite.All. Dry-run still writes nothing.

import { randomBytes } from "node:crypto";

export class ProvisioningError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "ProvisioningError";
    this.status = status;
  }
}

const GUID = /^[0-9a-fA-F-]{36}$/;
const iso = (date) => new Date(date).toISOString();
const odata = (value) => String(value).replace(/'/g, "''");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nicknameFor(name) {
  const slug = String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  return `${slug}-${randomBytes(2).toString("hex")}`;
}

async function resolveOwners(readGraph, owners) {
  const ids = [];
  const problems = [];
  for (const owner of owners) {
    try {
      const user = await readGraph.get(`/users/${GUID.test(owner) ? owner : encodeURIComponent(owner)}?$select=id,displayName,userType,accountEnabled`);
      if (user.userType === "Guest") problems.push(`${owner} is a guest and cannot own a workspace.`);
      else if (user.accountEnabled === false) problems.push(`${owner} is disabled.`);
      else ids.push(user.id);
    } catch (error) {
      problems.push(error?.status === 404 ? `${owner} was not found.` : `${owner} could not be checked.`);
    }
  }
  return { ids: [...new Set(ids)], problems };
}

export async function provisionWorkspace({ request, actor, readGraph, writeGraph, mode, sensitivityLabelIds = {}, minOwners = 2, retryDelayMs = 5000, graphBaseUrl = "https://graph.microsoft.com/v1.0", now = new Date() }) {
  if (request.status !== "approved") throw new ProvisioningError("Only an approved request can be provisioned.");
  if (!["not-executed", "failed", "simulated"].includes(request.provisioning)) throw new ProvisioningError(`This request is already ${request.provisioning}.`);
  if (request.decidedBy === actor.id) throw new ProvisioningError("The person who approved the request cannot also provision it.", 403);
  if (mode === "live" && !(writeGraph && typeof writeGraph.post === "function")) throw new ProvisioningError("Live provisioning needs the executor identity.");

  const requestedLabel = typeof request.sensitivityLabel === "string" ? request.sensitivityLabel : "";
  const labelId = sensitivityLabelIds[requestedLabel] || null;
  const updated = {
    ...request,
    provisioningMode: mode,
    provisionedBy: actor.id,
    provisionedByName: actor.name || null,
    provisioningAt: iso(now),
    labelApplied: false,
    labelStatus: mode === "live" ? (labelId ? "pending" : "unmapped") : "not-applied-dry-run",
    provisioningDetail: null
  };
  let result = "error";
  let detail = null;
  let workspaceId = request.provisionedWorkspaceId || null;

  try {
    const owners = await resolveOwners(readGraph, request.owners);
    if (owners.problems.length || owners.ids.length < minOwners) {
      updated.provisioning = "failed";
      result = "owners-invalid";
      detail = [...owners.problems, owners.ids.length < minOwners ? `At least ${minOwners} valid owners are needed.` : null].filter(Boolean).join(" ");
    } else {
      const duplicate = (await readGraph.getAll(`/groups?$filter=displayName eq '${odata(request.name)}'&$select=id&$top=1`))[0];
      if (duplicate) {
        updated.provisioning = "failed";
        result = "name-taken";
        detail = "A group with this name already exists.";
      } else if (mode !== "live") {
        updated.provisioning = "simulated";
        result = "dry-run";
        detail = `Would create "${request.name}" (${request.visibility}) with ${owners.ids.length} owners${labelId ? ` and apply the "${requestedLabel}" sensitivity label` : `; sensitivity label "${requestedLabel || "(none)"}" has no verified tenant label-id mapping`}.`;
      } else if (!labelId) {
        updated.provisioning = "failed";
        result = "label-unmapped";
        updated.labelStatus = "unmapped";
        detail = `The requested sensitivity label "${requestedLabel || "(none)"}" has no verified tenant label-id mapping. No group was created.`;
      } else {
        const body = {
          displayName: request.name,
          description: String(request.purpose).slice(0, 1000),
          mailNickname: nicknameFor(request.name),
          mailEnabled: true,
          securityEnabled: false,
          groupTypes: ["Unified"],
          visibility: request.visibility,
          assignedLabels: [{ labelId }],
          "owners@odata.bind": owners.ids.map((id) => `${graphBaseUrl}/users/${id}`),
          "members@odata.bind": owners.ids.map((id) => `${graphBaseUrl}/users/${id}`)
        };
        const created = await writeGraph.post("/groups", body);
        workspaceId = created.id;
        // A new group takes a moment to be known to the Teams service.
        for (let attempt = 1; ; attempt += 1) {
          try { await writeGraph.put(`/groups/${workspaceId}/team`, {}); break; } catch (error) {
            if (attempt >= 6) throw error;
            await sleep(retryDelayMs);
          }
        }
        const labeledGroup = await readGraph.get(`/groups/${workspaceId}?$select=id,assignedLabels`);
        const labelConfirmed = (labeledGroup.assignedLabels || []).some((label) => label.labelId === labelId);
        if (!labelConfirmed) {
          updated.provisioning = "failed";
          updated.provisionedWorkspaceId = workspaceId;
          updated.labelStatus = "unverified";
          result = "label-unverified";
          detail = `The workspace ${workspaceId} was created, but Microsoft Graph did not confirm the requested sensitivity label. Check it before retrying.`;
        }
        let confirmedOwners = [];
        if (labelConfirmed) {
          updated.labelApplied = true;
          updated.labelStatus = "verified";
          for (let attempt = 1; attempt <= 6; attempt += 1) {
            try { confirmedOwners = await readGraph.getAll(`/groups/${workspaceId}/owners?$select=id`); if (confirmedOwners.length) break; } catch { /* not replicated yet */ }
            await sleep(retryDelayMs);
          }
        }
        if (!labelConfirmed) {
          // Keep the label-unverified result above. A partially provisioned group needs manual review.
        } else if (confirmedOwners.length >= minOwners) {
          updated.provisioning = "provisioned";
          updated.provisionedWorkspaceId = workspaceId;
          result = "created";
        } else {
          updated.provisioning = "failed";
          updated.provisionedWorkspaceId = workspaceId;
          result = "unverified";
          detail = `The group ${workspaceId} was created but its owners could not be confirmed. Check it before retrying.`;
        }
      }
    }
  } catch (error) {
    updated.provisioning = "failed";
    if (!updated.labelApplied && requestedLabel && updated.labelStatus === "pending") updated.labelStatus = "failed";
    if (workspaceId) updated.provisionedWorkspaceId = workspaceId;
    result = "error";
    detail = `Graph returned ${error.status || "an error"}${workspaceId ? `; group ${workspaceId} may have been created` : ""}.`;
  }

  updated.provisioningDetail = detail;
  updated.version = Number(request.version || 0) + 1;
  const verification = {
    verificationId: `${request.requestId}-prov-${Date.parse(now) || Date.now()}`,
    caseId: request.requestId,
    requestId: request.requestId,
    checkedAt: updated.provisioningAt,
    result,
    method: "group-owners-read"
  };
  const audit = {
    auditId: `${request.requestId}-provision-${Date.parse(now) || Date.now()}`,
    caseId: request.requestId,
    eventType: "workspace-provisioning",
    requestId: request.requestId,
    mode,
    outcome: updated.provisioning,
    workspaceId: updated.provisionedWorkspaceId || null,
    actorId: actor.id,
    actorName: actor.name || null,
    occurredAt: updated.provisioningAt
  };
  return { request: updated, verification, audit };
}
