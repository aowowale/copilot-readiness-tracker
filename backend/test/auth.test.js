import test from "node:test";
import assert from "node:assert/strict";
import { authorize, readClientPrincipal } from "../src/lib/auth.js";

function requestFor(principal) {
  const encoded = principal
    ? Buffer.from(JSON.stringify(principal), "utf8").toString("base64")
    : null;
  return { headers: new Headers(encoded ? { "x-ms-client-principal": encoded } : {}) };
}

test("rejects requests without an Easy Auth principal by default", () => {
  assert.deepEqual(authorize(requestFor(null), ["Governance.Reader"]), {
    ok: false,
    status: 401,
    error: "Authentication required."
  });
});

test("reads identity and app roles from an Easy Auth principal", () => {
  const principal = readClientPrincipal(requestFor({
    userId: "user-1",
    userDetails: "owner@example.us",
    userRoles: ["authenticated", "Workspace.Owner"],
    claims: [{ typ: "preferred_username", val: "owner@example.us" }]
  }));

  assert.deepEqual(principal, {
    id: "user-1",
    name: "owner@example.us",
    upn: "owner@example.us",
    roles: ["authenticated", "Workspace.Owner"]
  });
});

test("authorizes an allowed role and rejects other authenticated users", () => {
  const ownerRequest = requestFor({ userId: "user-1", userRoles: ["Workspace.Owner"] });
  assert.equal(authorize(ownerRequest, ["Workspace.Owner"]).ok, true);
  assert.equal(authorize(ownerRequest, ["Governance.Operator"]).status, 403);
});

test("allows an explicit local-development bypass", () => {
  const result = authorize(requestFor(null), ["Governance.Reader"], { allowLocal: true });
  assert.equal(result.ok, true);
  assert.equal(result.principal.id, "local-development");
});