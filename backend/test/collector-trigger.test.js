import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@azure/functions";

const handlers = new Map();
const originalHttp = app.http;
const originalTimer = app.timer;
app.http = (name, options) => handlers.set(name, options.handler);
app.timer = () => {};
await import("../src/functions/collector.js");
app.http = originalHttp;
app.timer = originalTimer;

const context = { log() {}, warn() {}, error() {} };

function requestFor(roles) {
  const headers = new Headers();
  if (roles) {
    const principal = { userId: "user-1", userDetails: "User", userRoles: roles, claims: [] };
    headers.set("x-ms-client-principal", Buffer.from(JSON.stringify(principal)).toString("base64"));
  }
  return { headers };
}

test("manual collector runs require a governance operator", async () => {
  const handler = handlers.get("collectorRun");
  assert.ok(handler, "collectorRun is registered");
  assert.equal((await handler(requestFor(null), context)).status, 401);
  assert.equal((await handler(requestFor(["Governance.Reader"]), context)).status, 403);
});