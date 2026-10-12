import { DefaultAzureCredential } from "@azure/identity";

// Microsoft Graph client. Authenticates with a managed identity via DefaultAzureCredential.
// AZURE_AUTHORITY_HOST selects the national-cloud login endpoint (login.microsoftonline.us for
// GCC High). The default client is read-only: only a client created with { writable: true }
// (the separate executor identity) can send DELETE, POST or PUT.

export function createGraphClient(config, { clientId = config.collectorClientId, writable = false } = {}) {
  const credential = new DefaultAzureCredential(
    clientId ? { managedIdentityClientId: clientId } : {}
  );

  let cachedToken = null;

  async function getToken() {
    if (cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 60_000) {
      return cachedToken.token;
    }
    const result = await credential.getToken(config.graphScope);
    if (!result) throw new Error("Failed to acquire a Microsoft Graph token.");
    cachedToken = result;
    return result.token;
  }

  async function get(path, extraHeaders = {}) {
    const url = path.startsWith("http") ? path : `${config.graphBaseUrl}${path}`;
    const token = await getToken();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extraHeaders }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(`Graph GET ${url} failed: ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return response.json();
  }

  // Follows @odata.nextLink and returns the concatenated value arrays.
  async function getAll(path, extraHeaders = {}) {
    const items = [];
    let next = path;
    while (next) {
      const page = await get(next, extraHeaders);
      if (Array.isArray(page.value)) items.push(...page.value);
      next = page["@odata.nextLink"] || null;
    }
    return items;
  }

  // Usage reports come back as CSV, not JSON. The fetch follows the report's redirect.
  async function getText(path) {
    const url = path.startsWith("http") ? path : `${config.graphBaseUrl}${path}`;
    const token = await getToken();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const error = new Error(`Graph GET ${url} failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.text();
  }

  // Only exposed on a writable client. A missing target counts as already removed.
  async function remove(path) {
    const url = `${config.graphBaseUrl}${path}`;
    const token = await getToken();
    const response = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok && response.status !== 404) {
      const error = new Error(`Graph DELETE ${url} failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
  }

  // Writable client only. Returns the parsed body, or null when the response has none.
  async function send(method, path, body) {
    const url = `${config.graphBaseUrl}${path}`;
    const token = await getToken();
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const error = new Error(`Graph ${method} ${url} failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = await response.text().catch(() => "");
    return text ? JSON.parse(text) : null;
  }

  async function sendWithResponse(method, path, body) {
    const url = `${config.graphBaseUrl}${path}`;
    const token = await getToken();
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const error = new Error(`Graph ${method} ${url} failed: ${response.status}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: text ? JSON.parse(text) : null };
  }

  const post = (path, body) => send("POST", path, body);
  const put = (path, body) => send("PUT", path, body);
  const postWithResponse = (path, body) => sendWithResponse("POST", path, body);

  return writable ? { get, getAll, getText, remove, post, put, postWithResponse } : { get, getAll, getText };
}
