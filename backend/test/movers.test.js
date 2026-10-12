import test from "node:test";
import assert from "node:assert/strict";
import { buildMoverTask, latestWorkspaceTasks, moverTaskId, submitMoverDecisions } from "../src/lib/movers.js";
import { syncMoverTasks } from "../src/lib/mover-sync.js";
import { deliverNotifications, planNotifications } from "../src/lib/notifications.js";

const NOW = new Date("2025-06-01T00:00:00Z");
const roleChange = {
  caseId: "rc-1", userId: "u-1", userDisplayName: "Pat Mover", oldRole: "Sales", newRole: "Finance",
  allowedResourceIds: ["t-fin"], after: { managerId: "mgr-1" }
};
const memberships = [
  { workspaceId: "t-fin", workspaceName: "Finance", access: "member" },
  { workspaceId: "t-sales", workspaceName: "Sales", access: "member" },
  { workspaceId: "t-own", workspaceName: "Owned", access: "owner" }
];
const workspaceTask = (workspaceId, cycle = 1) => ({ taskId: `ws-${workspaceId}-c${cycle}`, workspaceId, cycle, status: "open" });
const actor = { id: "mgr-1", name: "Manager" };

test("mover task lists items outside the new role first and goes to the manager", () => {
  const task = buildMoverTask({ roleChange, memberships, itemsSource: "graph", now: NOW });
  assert.equal(task.taskId, moverTaskId("rc-1"));
  assert.deepEqual(task.assigneeIds, ["mgr-1"]);
  assert.equal(task.items[0].expected, false);
  assert.equal(task.items.at(-1).workspaceId, "t-fin");
});

test("without a manager the review goes to the governance queue", () => {
  const task = buildMoverTask({ roleChange: { ...roleChange, after: {} }, memberships, itemsSource: "hr-feed", now: NOW });
  assert.equal(task.assigneeKind, "governance-queue");
});

test("every item needs a decision and keep needs a reason", () => {
  const task = buildMoverTask({ roleChange, memberships, itemsSource: "graph", now: NOW });
  const all = (choice, reason) => task.items.map((item) => ({ workspaceId: item.workspaceId, choice, reason }));
  assert.throws(() => submitMoverDecisions({ task, decisions: all("remove").slice(1), actor, workspaceTasks: new Map() }), /every item/);
  assert.throws(() => submitMoverDecisions({ task, decisions: all("keep", ""), actor, workspaceTasks: new Map() }), /Say why/);
});

test("removals become pending requests on the workspace review; owners and unknown workspaces are not routed", () => {
  const task = buildMoverTask({ roleChange, memberships, itemsSource: "graph", now: NOW });
  const workspaceTasks = latestWorkspaceTasks([workspaceTask("t-sales", 1), workspaceTask("t-sales", 2), task]);
  const result = submitMoverDecisions({
    task,
    decisions: task.items.map((item) => ({ workspaceId: item.workspaceId, choice: item.workspaceId === "t-fin" ? "keep" : "remove", reason: "Still on the finance close" })),
    actor,
    workspaceTasks,
    now: NOW
  });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].caseId, "ws-t-sales-c2");
  assert.equal(result.requests[0].actionType, "remove-member");
  assert.equal(result.requests[0].status, "proposed");
  assert.equal(result.unrouted.length, 1);
  assert.equal(result.task.status, "decided");
  assert.equal(result.decision.evidence.kept, 1);
  assert.throws(() => submitMoverDecisions({ task: result.task, decisions: [], actor, workspaceTasks }), /already decided/);
});

test("sync reads Teams from Graph, falls back to the feed, and never recreates a review", async () => {
  const created = [];
  const repository = {
    readTasksWithEtag: async () => created.map((record) => ({ record })),
    createTaskIfAbsent: async (task) => { created.push(task); return true; }
  };
  const graph = {
    getAll: async () => [{ id: "t-sales", displayName: "Sales", resourceProvisioningOptions: ["Team"] }, { id: "g-other", displayName: "Other", resourceProvisioningOptions: [] }],
    get: async () => ({ id: "mgr-1", displayName: "Manager", mail: "mgr@example.com" })
  };
  const first = await syncMoverTasks({ roleChanges: [roleChange], workspaces: [], graph, repository, now: NOW });
  assert.equal(first.created, 1);
  assert.equal(created[0].items.length, 1);
  assert.equal(created[0].managerContact.mail, "mgr@example.com");
  assert.equal((await syncMoverTasks({ roleChanges: [roleChange], workspaces: [], graph, repository, now: NOW })).created, 0);

  const failing = { getAll: async () => { throw new Error("404"); }, get: async () => { throw new Error("404"); } };
  const feedChange = { ...roleChange, caseId: "rc-2", currentEntitlements: [{ resourceId: "t-x", resourceName: "X" }] };
  const second = await syncMoverTasks({ roleChanges: [feedChange], workspaces: [], graph: failing, repository, now: NOW });
  assert.equal(second.fromFeed, 1);
  assert.equal(created.at(-1).itemsSource, "hr-feed");
});

const ownerTask = (overrides = {}) => ({
  taskId: "ws-1-c1", workspaceId: "t-1", workspaceName: "Project", status: "open", assigneeKind: "owners",
  assigneeIds: ["o-1"], createdAt: "2025-05-30T00:00:00Z", dueAt: "2025-06-13T00:00:00Z", escalationLevel: 0, ...overrides
});
const workspaces = [{ id: "t-1", ownerDetails: [{ id: "o-1", displayName: "Owner", mail: "owner@example.com", managerId: "m-1", managerMail: "boss@example.com" }] }];

function memoryRepository() {
  const rows = new Map();
  return { rows, readNotification: async (key) => rows.get(key) || null, writeNotification: async (row) => { rows.set(row.dedupeKey, row); } };
}

test("notifications are planned once per recipient and event, and old tasks do not announce themselves", () => {
  const planned = planNotifications({ tasks: [ownerTask(), ownerTask({ taskId: "old", createdAt: "2025-01-01T00:00:00Z" })], workspaces, now: NOW });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].mail, "owner@example.com");
  const escalated = planNotifications({ tasks: [ownerTask({ escalationLevel: 2, createdAt: "2025-01-01T00:00:00Z" })], workspaces, now: NOW });
  assert.equal(escalated[0].mail, "boss@example.com");
  assert.equal(planNotifications({ tasks: [ownerTask({ status: "decided" })], workspaces, now: NOW }).length, 0);
});

test("dry run records but sends nothing, and reruns do not repeat", async () => {
  const repository = memoryRepository();
  const sent = [];
  const planned = planNotifications({ tasks: [ownerTask()], workspaces, now: NOW });
  const first = await deliverNotifications({ planned, repository, mailer: { send: async (m) => sent.push(m) }, mode: "dry-run", now: NOW });
  assert.equal(first.simulated, 1);
  assert.equal(sent.length, 0);
  assert.equal((await deliverNotifications({ planned, repository, mailer: null, mode: "dry-run", now: NOW })).alreadyDone, 1);
});

test("live mode sends once, retries failures up to the limit, and skips people without an address", async () => {
  const repository = memoryRepository();
  const sent = [];
  const planned = planNotifications({ tasks: [ownerTask()], workspaces, now: NOW });
  assert.equal((await deliverNotifications({ planned, repository, mailer: { send: async (m) => sent.push(m) }, mode: "live", now: NOW })).sent, 1);
  assert.equal(sent[0].to, "owner@example.com");
  assert.match(sent[0].body, /No workspace is archived or deleted/);

  const failingRepo = memoryRepository();
  const failing = { send: async () => { throw Object.assign(new Error("x"), { status: 403 }); } };
  for (let i = 0; i < 4; i += 1) await deliverNotifications({ planned, repository: failingRepo, mailer: failing, mode: "live", now: NOW });
  assert.equal(failingRepo.rows.get(planned[0].dedupeKey).attempts, 3);

  const noMail = planNotifications({ tasks: [ownerTask()], workspaces: [{ id: "t-1", ownerDetails: [{ id: "o-1" }] }], now: NOW });
  const skipped = await deliverNotifications({ planned: noMail, repository: memoryRepository(), mailer: { send: async () => {} }, mode: "live", now: NOW });
  assert.equal(skipped.skipped, 1);
});

test("mover reviews notify the manager and off mode does nothing", async () => {
  const task = buildMoverTask({ roleChange, memberships, itemsSource: "graph", managerContact: { id: "mgr-1", name: "Manager", mail: "mgr@example.com" }, now: NOW });
  const planned = planNotifications({ tasks: [task], workspaces: [], now: NOW });
  assert.equal(planned[0].mail, "mgr@example.com");
  assert.equal((await deliverNotifications({ planned, repository: memoryRepository(), mailer: null, mode: "off", now: NOW })).off, true);
});

test("new drift cycles notify only the governance queue and use the normal delivery dedupe", async () => {
  const alert = { alertId: "w1-guests", cycle: 2, status: "open", workspaceName: "Finance", label: "Guests", from: "1", to: "4", severity: "high" };
  const planned = planNotifications({ tasks: [], workspaces: [], driftAlerts: [alert], operatorEmail: "governance@example.com", now: NOW });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].mail, "governance@example.com");
  assert.equal(planned[0].dedupeKey, "drift|w1-guests|2|governance-queue");
  assert.match(planned[0].body, /no tenant change was made/i);
  const repository = memoryRepository();
  const outcome = await deliverNotifications({ planned, repository, mailer: null, mode: "dry-run", now: NOW });
  assert.equal(outcome.simulated, 1);
  assert.equal((await deliverNotifications({ planned, repository, mailer: null, mode: "dry-run", now: NOW })).alreadyDone, 1);
});
