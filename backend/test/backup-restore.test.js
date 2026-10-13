import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TableClient, TableServiceClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { backupStorage, restoreStorage } from "../src/tools/backup-restore.js";

const account = "devstoreaccount1";
const key = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const canConnect = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

test("backup and restore round-trip tables and blobs with checksums", async (context) => {
  const ports = new Set();
  while (ports.size < 2) ports.add(await freePort());
  const [blobPort, tablePort] = ports;
  const workingDirectory = await mkdtemp(join(tmpdir(), "sam-backup-azurite-"));
  const blobDirectory = await mkdtemp(join(tmpdir(), "sam-backup-blob-"));
  const tableDirectory = await mkdtemp(join(tmpdir(), "sam-backup-table-"));
  const backupDirectory = await mkdtemp(join(tmpdir(), "sam-backup-data-"));
  const blobExecutable = fileURLToPath(new URL("../node_modules/azurite/dist/src/blob/main.js", import.meta.url));
  const tableExecutable = fileURLToPath(new URL("../node_modules/azurite/dist/src/table/main.js", import.meta.url));
  const children = [
    spawn(process.execPath, [blobExecutable, "--blobHost", "127.0.0.1", "--blobPort", String(blobPort), "--silent", "--skipApiVersionCheck", "--inMemoryPersistence", "--disableTelemetry"], { cwd: blobDirectory, stdio: ["ignore", "pipe", "pipe"] }),
    spawn(process.execPath, [tableExecutable, "--tableHost", "127.0.0.1", "--tablePort", String(tablePort), "--silent", "--skipApiVersionCheck", "--inMemoryPersistence", "--disableTelemetry"], { cwd: tableDirectory, stdio: ["ignore", "pipe", "pipe"] })
  ];
  let startupError = "";
  for (const child of children) {
    child.stdout.on("data", (chunk) => { startupError += chunk.toString(); });
    child.stderr.on("data", (chunk) => { startupError += chunk.toString(); });
  }
  context.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
    }
    await rm(workingDirectory, { recursive: true, force: true });
    await rm(blobDirectory, { recursive: true, force: true });
    await rm(tableDirectory, { recursive: true, force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && children.every((child) => child.exitCode === null) && (!(await canConnect(tablePort)) || !(await canConnect(blobPort)))) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await canConnect(tablePort), true, `Azurite table service did not start: ${startupError.trim()}`);
  assert.equal(await canConnect(blobPort), true, `Azurite blob service did not start: ${startupError.trim()}`);
  const connectionString = `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};BlobEndpoint=http://127.0.0.1:${blobPort}/${account};TableEndpoint=http://127.0.0.1:${tablePort}/${account};`;
  const sdkOptions = { allowInsecureConnection: true };
  const tables = TableServiceClient.fromConnectionString(connectionString, sdkOptions);
  await tables.createTable("workspaces");
  const table = TableClient.fromConnectionString(connectionString, "workspaces", sdkOptions);
  await table.createEntity({ partitionKey: "tenant", rowKey: "one", name: "Finance", risk: 42 });
  const blobs = BlobServiceClient.fromConnectionString(connectionString, sdkOptions);
  const container = blobs.getContainerClient("feeds");
  await container.create();
  await container.getBlockBlobClient("evidence.json").uploadData(Buffer.from("evidence-v1"));
  const options = { connectionString, tableEndpoint: "http://unused", blobEndpoint: "http://unused", directory: backupDirectory };
  const manifest = await backupStorage(options);
  assert.equal(manifest.tables.workspaces.count, 1);
  assert.equal(manifest.blobs["feeds/evidence.json"].bytes, 11);
  const manifestPath = join(backupDirectory, "backup-manifest.json");
  const serializedManifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, serializedManifest.replace('"schemaVersion": 1', '"schemaVersion": 2'));
  await assert.rejects(restoreStorage(options), /Unsupported backup manifest schema version: 2/);
  await writeFile(manifestPath, serializedManifest);
  await tables.deleteTable("workspaces");
  await container.delete();
  await restoreStorage(options);
  const restored = await table.getEntity("tenant", "one");
  assert.equal(restored.name, "Finance");
  assert.equal(restored.risk, 42);
  assert.equal((await container.getBlobClient("evidence.json").downloadToBuffer()).toString(), "evidence-v1");
});
