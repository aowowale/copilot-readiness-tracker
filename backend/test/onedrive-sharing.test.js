import test from "node:test";
import assert from "node:assert/strict";
import { scanOneDriveSharing, proposeOneDriveRevocations } from "../src/lib/onedrive-sharing.js";
import { ExecutionRuleError, executeAction } from "../src/lib/execution.js";

const ownerId = "00000000-0000-0000-0000-000000000001";
const guestId = "00000000-0000-0000-0000-000000000009";
const site = { siteKey: "https://contoso-my.sharepoint.com/personal/owner_contoso_com", ownerUpn: "owner@contoso.com", title: "Owner OneDrive" };

function fakeGraph({ writable = false } = {}) {
  const state = {
    removed: [],
    pages: {
      "/drives/drive-1/root/children?$top=100": { value: [{ id: "file-1", name: "Plan.docx" }, { id: "folder-1", name: "Shared", folder: {} }] },
      "/drives/drive-1/items/folder-1/children?$top=100": { value: [{ id: "file-2", name: "Budget.xlsx" }] }
    },
    permissions: {
      "file-1": [
        { id: "link-1", link: { scope: "anonymous", type: "view" }, roles: ["read"] },
        { id: "owner-access", roles: ["owner"], grantedToV2: { user: { id: ownerId, displayName: "Owner" } } },
        { id: "guest-grant", roles: ["read"], grantedToV2: { user: { id: guestId, displayName: "Guest User", email: "guest@example.net" } } }
      ],
      "file-2": [{ id: "group-grant", roles: ["read"], grantedToV2: { siteGroup: { id: "g1" } } }]
    }
  };
  const graph = {
    state,
    get: async path => {
      if (decodeURIComponent(path).startsWith("/users/owner@contoso.com?")) return { id: ownerId, displayName: "Owner", userType: "Member", accountEnabled: true };
      if (path === `/users/${ownerId}/drive?$select=id,driveType,webUrl`) return { id: "drive-1", driveType: "business", webUrl: site.siteKey };
      if (state.pages[path]) return state.pages[path];
      if (path.includes("/items/") && path.includes("/permissions")) { const m = path.match(/items\/([^/]+)\/permissions/); return { value: state.permissions[m[1]] || [] }; }
      return { value: [] };
    },
    getAll: async path => {
      const m = path.match(/items\/([^/]+)\/permissions/);
      return m ? (state.permissions[m[1]] || []) : [];
    }
  };
  if (writable) graph.remove = async path => {
    const m = path.match(/items\/([^/]+)\/permissions\/([^/]+)$/);
    state.permissions[m[1]] = state.permissions[m[1]].filter(permission => permission.id !== m[2]);
    state.removed.push(m[2]);
  };
  return graph;
}

test("OneDrive scan uses the provisioned personal drive, stays bounded, and excludes owner and group permissions", async () => {
  const result = await scanOneDriveSharing({ graph: fakeGraph(), site });
  assert.equal(result.ownerId, ownerId);
  assert.equal(result.driveId, "drive-1");
  assert.equal(result.scannedItems, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.findings.map(item => item.permissionId).sort(), ["guest-grant", "link-1"]);
});

test("OneDrive revocations are scoped to the scan, reject self-access, and respect the 10-target cap", async () => {
  const graph = fakeGraph();
  const scan = await scanOneDriveSharing({ graph, site });
  const actor = { id: ownerId, name: "Owner" };
  const result = await proposeOneDriveRevocations({ site, scan, targets: [{ itemId: "file-1", permissionId: "link-1" }, { itemId: "file-1", permissionId: "guest-grant" }], actor });
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions[0].driveId, "drive-1");
  assert.equal(result.actions[0].origin, "onedrive-review");
  const self = await proposeOneDriveRevocations({ site, scan, targets: [{ itemId: "file-1", permissionId: "guest-grant" }], actor: { id: guestId } });
  assert.equal(self.actions.length, 0);
  assert.match(self.rejected[0].reason, /own access/);
  await assert.rejects(() => proposeOneDriveRevocations({ site, scan, targets: Array.from({ length: 11 }, (_, i) => ({ itemId: "file-1", permissionId: `p${i}` })), actor }), ExecutionRuleError);
  const outside = await proposeOneDriveRevocations({ site, scan, targets: [{ itemId: "item-other", permissionId: "link-1" }], actor });
  assert.equal(outside.actions.length, 0);
});

test("OneDrive link removal runs only with a writable client and verifies by rereading", async () => {
  const graph = fakeGraph({ writable: true });
  const scan = await scanOneDriveSharing({ graph, site });
  const { actions } = await proposeOneDriveRevocations({ site, scan, targets: [{ itemId: "file-1", permissionId: "link-1" }], actor: { id: ownerId, name: "Owner" } });
  const dry = await executeAction({ action: actions[0], actor: { id: ownerId }, graph: fakeGraph(), mode: "dry-run" });
  assert.equal(dry.action.status, "simulated");
  assert.equal(graph.state.removed.length, 0);
  const result = await executeAction({ action: actions[0], actor: { id: ownerId }, graph, mode: "live" });
  assert.equal(result.action.status, "verified");
  assert.equal(result.verification.method, "item-permissions-read");
  assert.deepEqual(graph.state.removed, ["link-1"]);
});
