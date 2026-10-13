import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultAzureCredential } from "@azure/identity";
import { TableClient, TableServiceClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const clients = ({ connectionString, tableEndpoint, blobEndpoint }) => {
  if (connectionString) {
    const options = { allowInsecureConnection: true };
    return {
      tableService: TableServiceClient.fromConnectionString(connectionString, options),
      blobService: BlobServiceClient.fromConnectionString(connectionString, options),
      getTableClient: (name) => TableClient.fromConnectionString(connectionString, name, options)
    };
  }
  const credential = new DefaultAzureCredential();
  return {
    tableService: new TableServiceClient(tableEndpoint, credential),
    blobService: new BlobServiceClient(blobEndpoint, credential),
    getTableClient: (name) => new TableClient(tableEndpoint, name, credential)
  };
};

export async function backupStorage(options) {
  const { directory } = options;
  const { tableService, blobService, getTableClient } = clients(options);
  await mkdir(join(directory, "tables"), { recursive: true });
  await mkdir(join(directory, "blobs"), { recursive: true });
  const manifest = { schemaVersion: 1, createdUtc: new Date().toISOString(), tables: {}, blobs: {} };
  for await (const table of tableService.listTables()) {
    const entities = [];
    for await (const entity of getTableClient(table.name).listEntities()) entities.push(entity);
    const content = `${JSON.stringify(entities, null, 2)}\n`;
    await writeFile(join(directory, "tables", `${table.name}.json`), content);
    manifest.tables[table.name] = { count: entities.length, sha256: sha256(content) };
  }
  for await (const container of blobService.listContainers()) {
    const containerClient = blobService.getContainerClient(container.name);
    for await (const blob of containerClient.listBlobsFlat()) {
      const buffer = await containerClient.getBlobClient(blob.name).downloadToBuffer();
      const fileName = `${container.name}__${Buffer.from(blob.name).toString("base64url")}`;
      await writeFile(join(directory, "blobs", fileName), buffer);
      manifest.blobs[`${container.name}/${blob.name}`] = { fileName, bytes: buffer.length, sha256: sha256(buffer) };
    }
  }
  await writeFile(join(directory, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function restoreStorage(options) {
  const { directory } = options;
  const { tableService, blobService, getTableClient } = clients(options);
  const manifest = JSON.parse(await readFile(join(directory, "backup-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported backup manifest schema version: ${manifest.schemaVersion}`);
  for (const [tableName, expected] of Object.entries(manifest.tables)) {
    const content = await readFile(join(directory, "tables", `${tableName}.json`), "utf8");
    if (sha256(content) !== expected.sha256) throw new Error(`Checksum mismatch for table ${tableName}`);
    try { await tableService.createTable(tableName); } catch (error) { if (error.statusCode !== 409) throw error; }
    const client = getTableClient(tableName);
    for (const entity of JSON.parse(content)) {
      delete entity.etag;
      delete entity.timestamp;
      await client.upsertEntity(entity, "Replace");
    }
  }
  for (const [blobPath, expected] of Object.entries(manifest.blobs)) {
    const buffer = await readFile(join(directory, "blobs", expected.fileName));
    if (sha256(buffer) !== expected.sha256) throw new Error(`Checksum mismatch for blob ${blobPath}`);
    const slash = blobPath.indexOf("/");
    const container = blobService.getContainerClient(blobPath.slice(0, slash));
    await container.createIfNotExists();
    await container.getBlockBlobClient(blobPath.slice(slash + 1)).uploadData(buffer);
  }
  return manifest;
}

async function main() {
  const [mode, tableEndpoint, blobEndpoint, directory] = process.argv.slice(2);
  if (!["backup", "restore"].includes(mode) || !tableEndpoint || !blobEndpoint || !directory) {
    throw new Error("Usage: node backup-restore.js <backup|restore> <tableEndpoint> <blobEndpoint> <directory>");
  }
  const options = { tableEndpoint, blobEndpoint, directory, connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING };
  if (mode === "backup") await backupStorage(options); else await restoreStorage(options);
  console.log(`${mode} completed: ${directory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
