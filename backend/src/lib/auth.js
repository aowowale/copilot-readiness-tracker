const PRINCIPAL_HEADER = "x-ms-client-principal";

export const TENANT_READER_ROLES = [
  "Governance.Reader",
  "Governance.Operator",
  "Approver",
  "Executor",
  "Auditor"
];

function headerValue(request, name) {
  return request.headers?.get?.(name) || request.headers?.[name] || null;
}

export function readClientPrincipal(request) {
  const encoded = headerValue(request, PRINCIPAL_HEADER);
  if (!encoded) return null;

  try {
    const principal = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const claims = Array.isArray(principal.claims) ? principal.claims : [];
    const claimValues = (types) => claims
      .filter((claim) => types.includes(claim.typ))
      .map((claim) => claim.val)
      .filter(Boolean);

    return {
      id: principal.userId || claimValues([
        "http://schemas.microsoft.com/identity/claims/objectidentifier",
        "oid"
      ])[0] || null,
      name: principal.userDetails || claimValues(["name", "preferred_username"])[0] || null,
      upn: claimValues(["preferred_username", "upn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn"])[0] || null,
      roles: [...new Set([
        ...(Array.isArray(principal.userRoles) ? principal.userRoles : []),
        ...claimValues(["roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"])
      ])]
    };
  } catch {
    return null;
  }
}

// Entra object id of the signed-in user. Owner matching uses this, because
// workspace owners are stored by their Graph object id.
export function readObjectId(request) {
  const encoded = headerValue(request, PRINCIPAL_HEADER);
  if (!encoded) return null;
  try {
    const principal = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const claim = (Array.isArray(principal.claims) ? principal.claims : []).find((item) =>
      ["http://schemas.microsoft.com/identity/claims/objectidentifier", "oid"].includes(item.typ));
    return claim?.val || null;
  } catch {
    return null;
  }
}

export function authorize(request, allowedRoles, { allowLocal = false } = {}) {
  const principal = readClientPrincipal(request);
  if (!principal) {
    if (allowLocal) {
      return { ok: true, principal: { id: "local-development", name: "Local development", upn: null, roles: ["Governance.Reader"] } };
    }
    return { ok: false, status: 401, error: "Authentication required." };
  }

  const roles = Array.isArray(allowedRoles) ? allowedRoles : [];
  if (roles.length && !roles.some((role) => principal.roles.includes(role))) {
    return { ok: false, status: 403, error: "You do not have permission to access this resource." };
  }

  return { ok: true, principal };
}