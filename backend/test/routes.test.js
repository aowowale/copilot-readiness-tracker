import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The host runs with an empty route prefix, so every API route must carry its own api/ prefix.
test("every HTTP route is under api/ except the dashboard page", () => {
  const dir = fileURLToPath(new URL("../src/functions/", import.meta.url));
  const routes = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
    const text = readFileSync(`${dir}${file}`, "utf8");
    for (const match of text.matchAll(/route:\s*"([^"]*)"/g)) routes.push({ file, route: match[1] });
  }
  assert.ok(routes.length >= 15);
  for (const { file, route } of routes) {
    if (file === "site.js") {
      assert.equal(route, "/", "the dashboard must use only the root route, never a wildcard that can shadow API routes");
      continue;
    }
    assert.match(route, /^api\//, `${file} route '${route}' needs the api/ prefix`);
  }
});

test("the host has no implicit route prefix", () => {
  const host = JSON.parse(readFileSync(fileURLToPath(new URL("../host.json", import.meta.url)), "utf8"));
  assert.equal(host.extensions.http.routePrefix, "");
});
