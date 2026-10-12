import test from "node:test";
import assert from "node:assert/strict";
import { executeAction, ExecutionRuleError } from "../src/lib/execution.js";
import { proposePermissionRevocations, scanSharing } from "../src/lib/sharing.js";
import { provisionWorkspace, ProvisioningError } from "../src/lib/provisioning.js";

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const actor = { id: id(1), name: "Owner" };
const task = { taskId: "team-1-c1", workspaceId: "team-1", workspaceName: "Finance", status: "open" };

// A drive with one folder, files and a mix of permissions.
function fakeDrive({ writable = true } = {}) {
  const state = {
    members: [{ id: id(1) }, { id: id(2), displayName: "Member Max", userType: "Member" }],
    owners: [{ id: id(1) }],
    permissions: {
      "item-a": [
        { id: "p-link-anon", link: { scope: "anonymous", type: "view" }, roles: ["read"] },
        { id: "p-link-inh", link: { scope: "organization", type: "view" }, roles: ["read"], inheritedFrom: { id: "x" } },
        { id: "p-owner", roles: ["owner"], grantedToV2: { user: { id: id(1), displayName: "Owner" } } },
        { id: "p-shadow", roles: ["read"], grantedToV2: { user: { id: id(9), displayName: "Shadow Sam" } } },
        { id: "p-member", roles: ["read"], grantedToV2: { user: { id: id(2), displayName: "Member Max" } } },
        { id: "p-group", roles: ["read"], grantedToV2: { siteGroup: { id: "g", displayName: "Visitors" } } }
      ],
      "item-b": [{ id: "p-org", link: { scope: "organization", type: "edit" }, roles: ["write"] }]
    },
    removed: []
  };
  const graph = {
    state,
    get: async (path) => {
      if (path.startsWith("/groups/team-1/drive")) return { id: "drive-1" };
      const item = path.match(/\/items\/([^/?]+)\?/);
      return { id: item?.[1], name: `${item?.[1]}.docx` };
    },
    getAll: async (path) => {
      if (path.includes("/members?")) return state.members;
      if (path.includes("/owners?")) return state.owners;
      if (path.includes("/root/children")) return [{ id: "item-a", name: "Budget.xlsx", webUrl: "u" }, { id: "folder-1", name: "Docs", folder: {} }];
      if (path.includes("/items/folder-1/children")) return [{ id: "item-b", name: "Notes.docx" }];
      const match = path.match(/\/items\/([^/]+)\/permissions/);
      if (match) {
        if (!state.permissions[match[1]]) { const error = new Error("nf"); error.status = 404; throw error; }
        return state.permissions[match[1]];
      }
      return [];
    }
  };
  if (writable) {
    graph.remove = async (path) => {
      const match = path.match(/\/items\/([^/]+)\/permissions\/([^/]+)/);
      state.permissions[match[1]] = state.permissions[match[1]].filter((permission) => permission.id !== match[2]);
      state.removed.push(match[2]);
    };
  }
  return graph;
}

test("the sharing scan reports links and shadow grants only, never owner, inherited, member or group access", async () => {
  const scan = await scanSharing({ graph: fakeDrive(), workspaceId: "team-1" });
  assert.deepEqual(scan.findings.map((item) => item.permissionId).sort(), ["p-link-anon", "p-org", "p-shadow"]);
  assert.equal(scan.truncated, false);
  assert.equal(scan.findings.find((item) => item.permissionId === "p-shadow").kind, "direct-user");
});

test("the scan says when it stopped early", async () => {
  const scan = await scanSharing({ graph: fakeDrive(), workspaceId: "team-1", maxItems: 1 });
  assert.equal(scan.truncated, true);
});

const targets = (...permissionIds) => permissionIds.map((permissionId) => ({ itemId: permissionId === "p-org" ? "item-b" : "item-a", permissionId }));

test("only links and non-member direct grants become proposals, with a reason for every refusal", async () => {
  const result = await proposePermissionRevocations({ task, targets: targets("p-link-anon", "p-shadow", "p-link-inh", "p-owner", "p-member", "p-group", "p-missing"), actor, graph: fakeDrive() });
  assert.deepEqual(result.actions.map((action) => action.permissionId).sort(), ["p-link-anon", "p-shadow"]);
  assert.equal(result.actions[0].driveId, "drive-1");
  assert.equal(result.rejected.length, 5);
  assert.match(result.rejected.find((item) => item.permissionId === "p-member").reason, /Remove them from the team/);
  assert.match(result.rejected.find((item) => item.permissionId === "p-owner").reason, /never revoked/);
  assert.match(result.rejected.find((item) => item.permissionId === "p-link-inh").reason, /Inherited/);
});

test("the actor's own access and invalid or oversized requests are refused", async () => {
  const own = fakeDrive();
  own.state.permissions["item-a"].push({ id: "p-self", roles: ["read"], grantedToV2: { user: { id: id(1) } } });
  const mine = await proposePermissionRevocations({ task, targets: targets("p-self"), actor, graph: own });
  assert.equal(mine.actions.length, 0);

  const graph = fakeDrive();
  await assert.rejects(() => proposePermissionRevocations({ task, targets: [], actor, graph }), ExecutionRuleError);
  await assert.rejects(() => proposePermissionRevocations({ task, targets: [{ itemId: "../x", permissionId: "p" }], actor, graph }), /not valid/);
  await assert.rejects(() => proposePermissionRevocations({ task, targets: Array.from({ length: 11 }, (_, i) => ({ itemId: "item-a", permissionId: `p${i}` })), actor, graph }), /at most/);
});

test("a revocation is verified by reading the item again, and dry run changes nothing", async () => {
  const graph = fakeDrive();
  const { actions } = await proposePermissionRevocations({ task, targets: targets("p-link-anon"), actor, graph });

  const dry = await executeAction({ action: actions[0], actor, graph: fakeDrive({ writable: false }), mode: "dry-run" });
  assert.equal(dry.action.status, "simulated");

  const live = await executeAction({ action: actions[0], actor, graph, mode: "live" });
  assert.equal(live.action.status, "verified");
  assert.equal(live.verification.method, "item-permissions-read");
  assert.deepEqual(graph.state.removed, ["p-link-anon"]);
});

test("a permission that became owner access since the proposal is not revoked", async () => {
  const graph = fakeDrive();
  const { actions } = await proposePermissionRevocations({ task, targets: targets("p-link-anon"), actor, graph });
  graph.state.permissions["item-a"].find((permission) => permission.id === "p-link-anon").roles = ["owner"];
  const result = await executeAction({ action: actions[0], actor, graph, mode: "live" });
  assert.equal(result.action.status, "failed");
  assert.match(result.action.resultDetail, /no longer a sharing link/);
  assert.deepEqual(graph.state.removed, []);
});

test("a direct-grant permission reassigned to another person after preview is not revoked", async () => {
  const graph = fakeDrive();
  const { actions } = await proposePermissionRevocations({ task, targets: targets("p-shadow"), actor, graph });
  graph.state.permissions["item-a"].find(permission => permission.id === "p-shadow").grantedToV2.user.id = id(10);
  const result = await executeAction({ action: actions[0], actor, graph, mode: "live" });
  assert.equal(result.action.status, "failed");
  assert.match(result.action.resultDetail, /different person/);
  assert.deepEqual(graph.state.removed, []);
});

// ---- provisioning ----
const approved = {
  requestId: "req-1", name: "Apollo Launch", purpose: "Coordinate the Apollo launch.", visibility: "Private",
  owners: ["a@contoso.com", "b@contoso.com"], sensitivityLabel: "Internal", status: "approved", provisioning: "not-executed", decidedBy: "op1", version: 1
};
const executor = { id: "ex1", name: "Executor" };

function fakeProvisionGraph({ users, existingGroup = false, writable = true, ownersConfirmed = 2, labelReadback = true } = {}) {
  const state = { created: [], teams: [], labels: [] };
  const read = {
    state,
    get: async (path) => {
      if (path.startsWith("/groups/new-group?")) return { id: "new-group", assignedLabels: labelReadback ? state.labels : [] };
      const key = decodeURIComponent(path.split("/users/")[1].split("?")[0]);
      const user = users[key];
      if (!user) { const error = new Error("nf"); error.status = 404; throw error; }
      return user;
    },
    getAll: async (path) => {
      if (path.startsWith("/groups?$filter=displayName")) return existingGroup ? [{ id: "dup" }] : [];
      if (path.includes("/owners")) return Array.from({ length: ownersConfirmed }, (_, index) => ({ id: `o${index}` }));
      return [];
    }
  };
  const write = writable ? {
    post: async (path, body) => { state.created.push(body); state.labels = body.assignedLabels || []; return { id: "new-group" }; },
    put: async (path, body) => {
      if (path.endsWith("/team")) state.teams.push(path);
      else if (path === "/groups/new-group") state.labels = body.assignedLabels || [];
      return null;
    }
  } : null;
  return { read, write, state };
}

const goodUsers = { "a@contoso.com": { id: "ua", userType: "Member", accountEnabled: true }, "b@contoso.com": { id: "ub", userType: "Member", accountEnabled: true } };
const labelIds = { Internal: "00000000-0000-0000-0000-000000000099" };

test("provisioning needs an approved request, a different person, and the executor identity when live", async () => {
  const { read, write } = fakeProvisionGraph({ users: goodUsers });
  await assert.rejects(() => provisionWorkspace({ request: { ...approved, status: "pending" }, actor: executor, readGraph: read, writeGraph: write, mode: "live" }), /approved/);
  await assert.rejects(() => provisionWorkspace({ request: approved, actor: { id: "op1" }, readGraph: read, writeGraph: write, mode: "live" }), /cannot also provision/);
  await assert.rejects(() => provisionWorkspace({ request: approved, actor: executor, readGraph: read, writeGraph: null, mode: "live" }), /executor identity/);
  await assert.rejects(() => provisionWorkspace({ request: { ...approved, provisioning: "provisioned" }, actor: executor, readGraph: read, writeGraph: write, mode: "live" }), ProvisioningError);
});

test("dry run checks owners and name, then creates nothing", async () => {
  const { read, state } = fakeProvisionGraph({ users: goodUsers });
  const result = await provisionWorkspace({ request: approved, actor: executor, readGraph: read, writeGraph: null, mode: "dry-run" });
  assert.equal(result.request.provisioning, "simulated");
  assert.equal(result.verification.result, "dry-run");
  assert.deepEqual(state.created, []);
  assert.equal(result.request.labelApplied, false);
  assert.equal(result.request.labelStatus, "not-applied-dry-run");
});

test("live provisioning creates the group and team, then confirms owners", async () => {
  const { read, write, state } = fakeProvisionGraph({ users: goodUsers });
  const result = await provisionWorkspace({ request: approved, actor: executor, readGraph: read, writeGraph: write, mode: "live", sensitivityLabelIds: { Internal: "00000000-0000-0000-0000-000000000099" }, retryDelayMs: 0, graphBaseUrl: "https://graph.example/v1.0" });
  assert.equal(result.request.provisioning, "provisioned");
  assert.equal(result.request.provisionedWorkspaceId, "new-group");
  assert.equal(result.request.labelApplied, true);
  assert.equal(result.request.labelStatus, "verified");
  assert.deepEqual(state.teams, ["/groups/new-group/team"]);
  const body = state.created[0];
  assert.deepEqual(body.assignedLabels, [{ labelId: "00000000-0000-0000-0000-000000000099" }]);
  assert.deepEqual(body.groupTypes, ["Unified"]);
  assert.deepEqual(body["owners@odata.bind"], ["https://graph.example/v1.0/users/ua", "https://graph.example/v1.0/users/ub"]);
  assert.match(body.mailNickname, /^apollo-launch-[0-9a-f]{4}$/);
  assert.equal(result.audit.outcome, "provisioned");
});

test("live provisioning fails safely before creating a group when the requested label has no tenant mapping", async () => {
  const { read, write, state } = fakeProvisionGraph({ users: goodUsers });
  const result = await provisionWorkspace({ request: approved, actor: executor, readGraph: read, writeGraph: write, mode: "live", sensitivityLabelIds: {}, retryDelayMs: 0 });
  assert.equal(result.request.provisioning, "failed");
  assert.equal(result.request.labelStatus, "unmapped");
  assert.equal(result.request.labelApplied, false);
  assert.equal(result.verification.result, "label-unmapped");
  assert.deepEqual(state.created, []);
});

test("label readback failure retains the partially created group id for manual reconciliation", async () => {
  const { read, write } = fakeProvisionGraph({ users: goodUsers, labelReadback: false });
  const result = await provisionWorkspace({ request: approved, actor: executor, readGraph: read, writeGraph: write, mode: "live", sensitivityLabelIds: labelIds, retryDelayMs: 0 });
  assert.equal(result.request.provisioning, "failed");
  assert.equal(result.request.provisionedWorkspaceId, "new-group");
  assert.equal(result.request.labelApplied, false);
  assert.equal(result.request.labelStatus, "unverified");
  assert.match(result.request.provisioningDetail, /sensitivity label/);
});

test("guests, disabled or unknown owners and a taken name stop provisioning before anything is created", async () => {
  const users = { ...goodUsers, "b@contoso.com": { id: "ub", userType: "Guest", accountEnabled: true } };
  const guest = fakeProvisionGraph({ users });
  const failed = await provisionWorkspace({ request: approved, actor: executor, readGraph: guest.read, writeGraph: guest.write, mode: "live", sensitivityLabelIds: labelIds, retryDelayMs: 0 });
  assert.equal(failed.request.provisioning, "failed");
  assert.match(failed.request.provisioningDetail, /guest/);
  assert.deepEqual(guest.state.created, []);

  const unknown = fakeProvisionGraph({ users: { "a@contoso.com": goodUsers["a@contoso.com"] } });
  assert.match((await provisionWorkspace({ request: approved, actor: executor, readGraph: unknown.read, writeGraph: unknown.write, mode: "live", sensitivityLabelIds: labelIds, retryDelayMs: 0 })).request.provisioningDetail, /not found/);

  const taken = fakeProvisionGraph({ users: goodUsers, existingGroup: true });
  const duplicate = await provisionWorkspace({ request: approved, actor: executor, readGraph: taken.read, writeGraph: taken.write, mode: "live", sensitivityLabelIds: labelIds, retryDelayMs: 0 });
  assert.equal(duplicate.verification.result, "name-taken");
  assert.deepEqual(taken.state.created, []);
});

test("a group whose owners cannot be confirmed is reported failed with its id, never provisioned", async () => {
  const { read, write } = fakeProvisionGraph({ users: goodUsers, ownersConfirmed: 0 });
  const result = await provisionWorkspace({ request: approved, actor: executor, readGraph: read, writeGraph: write, mode: "live", sensitivityLabelIds: labelIds, retryDelayMs: 0 });
  assert.equal(result.request.provisioning, "failed");
  assert.equal(result.request.provisionedWorkspaceId, "new-group");
  assert.match(result.request.provisioningDetail, /new-group/);
});
