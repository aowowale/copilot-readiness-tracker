import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { app } from "@azure/functions";

// Serves the dashboard page from the same origin as the API, so browser sign-in (App Service
// Authentication) protects both and the page's relative api/ calls need no CORS. The install
// script copies index.html into backend/public before publishing.

const PAGE = fileURLToPath(new URL("../../public/index.html", import.meta.url));

async function dashboard() {
  try {
    const body = await readFile(PAGE, "utf8");
    return {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer"
      },
      body
    };
  } catch {
    return { status: 404, headers: { "Content-Type": "text/plain" }, body: "The dashboard page has not been published with this deployment." };
  }
}

app.http("dashboard", { methods: ["GET"], authLevel: "anonymous", route: "/", handler: dashboard });
