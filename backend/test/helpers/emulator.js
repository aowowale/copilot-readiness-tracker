import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";

// Starts the Azurite table emulator on a free port. Returns null when it cannot start, so the
// tests that need it are skipped rather than failed on a machine without the dev dependency.

const BIN = fileURLToPath(new URL("../../node_modules/azurite/dist/src/table/main.js", import.meta.url));
const ACCOUNT = "devstoreaccount1";
const KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  server.on("error", reject);
});

const canConnect = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(500);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

export async function startEmulator() {
  let child;
  try {
    const port = await freePort();
    child = spawn(process.execPath, [BIN, "--tableHost", "127.0.0.1", "--tablePort", String(port), "--silent", "--skipApiVersionCheck", "--inMemoryPersistence"], { stdio: "ignore" });
    let exited = false;
    let ready = false;
    child.on("exit", () => { exited = true; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !exited) {
      if (await canConnect(port)) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (exited || !ready) throw new Error("emulator did not start");
    const connectionString = `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};TableEndpoint=http://127.0.0.1:${port}/${ACCOUNT};`;
    return {
      connectionString,
      stop: () => child.kill()
    };
  } catch {
    child?.kill();
    return null;
  }
}
