import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/lib/config.js";

const original = { ...process.env };
function reset() {
  for (const key of ["GRAPH_TENANT_ID", "STORAGE_TABLE_ENDPOINT", "SENSITIVITY_LABEL_IDS", "ENABLE_LIFECYCLE_EXECUTION", "EXECUTION_MODE"]) delete process.env[key];
  Object.assign(process.env, { GRAPH_TENANT_ID: "tenant", STORAGE_TABLE_ENDPOINT: "https://example.table.core.windows.net" });
}
test.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); });

test("sensitivity-label mapping is parsed and validated", () => {
  reset();
  process.env.SENSITIVITY_LABEL_IDS = JSON.stringify({ Internal: "00000000-0000-0000-0000-000000000001" });
  process.env.ENABLE_LIFECYCLE_EXECUTION = "true";
  process.env.EXECUTION_MODE = "live";
  const config = getConfig();
  assert.equal(config.sensitivityLabelIds.Internal, "00000000-0000-0000-0000-000000000001");
  assert.equal(config.lifecycleExecutionEnabled, true);
  assert.equal(config.executionMode, "live");
  process.env.SENSITIVITY_LABEL_IDS = "not-json";
  assert.throws(() => getConfig(), /SENSITIVITY_LABEL_IDS/);
  process.env.SENSITIVITY_LABEL_IDS = JSON.stringify({ Internal: "not-a-guid" });
  assert.throws(() => getConfig(), /label name to a GUID/);
});
