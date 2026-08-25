import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";

// Snapshot storage. One entity per workspace, plus a single run-metadata entity.
// Uses managed identity against the table endpoint; no connection string or key.

const PARTITION = "workspace";
const META_PARTITION = "meta";
const META_ROW = "lastRun";

function createClient(config) {
  const credential = new DefaultAzureCredential(
    config.collectorClientId ? { managedIdentityClientId: config.collectorClientId } : {}
  );
  return new TableClient(config.storageTableEndpoint, config.storageTableName, credential);
}

export async function writeSnapshot(config, workspaces, runInfo) {
  const client = createClient(config);
  await client.createTable().catch((error) => {
    if (error?.statusCode !== 409) throw error;
  });

  for (const workspace of workspaces) {
    await client.upsertEntity(
      {
        partitionKey: PARTITION,
        rowKey: workspace.id,
        data: JSON.stringify(workspace),
        collectedAt: runInfo.collectedAt
      },
      "Replace"
    );
  }

  await client.upsertEntity(
    {
      partitionKey: META_PARTITION,
      rowKey: META_ROW,
      collectedAt: runInfo.collectedAt,
      status: runInfo.status,
      warnings: JSON.stringify(runInfo.warnings || []),
      workspaceCount: workspaces.length
    },
    "Replace"
  );
}

export async function readSnapshot(config) {
  const client = createClient(config);
  const workspaces = [];
  let meta = null;

  const entities = client.listEntities();
  for await (const entity of entities) {
    if (entity.partitionKey === PARTITION && entity.data) {
      workspaces.push(JSON.parse(entity.data));
    } else if (entity.partitionKey === META_PARTITION && entity.rowKey === META_ROW) {
      meta = {
        collectedAt: entity.collectedAt || null,
        status: entity.status || "unknown",
        warnings: entity.warnings ? JSON.parse(entity.warnings) : [],
        workspaceCount: entity.workspaceCount || 0
      };
    }
  }

  return { workspaces, meta };
}
