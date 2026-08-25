import { DefaultAzureCredential } from "@azure/identity";

// Read-only Microsoft Graph client. Authenticates with a managed identity via
// DefaultAzureCredential. AZURE_AUTHORITY_HOST selects the national-cloud login
// endpoint (login.microsoftonline.us for GCC High).

export function createGraphClient(config) {
  const credential = new DefaultAzureCredential(
    config.collectorClientId ? { managedIdentityClientId: config.collectorClientId } : {}
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

  async function get(path) {
    const url = path.startsWith("http") ? path : `${config.graphBaseUrl}${path}`;
    const token = await getToken();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
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
  async function getAll(path) {
    const items = [];
    let next = path;
    while (next) {
      const page = await get(next);
      if (Array.isArray(page.value)) items.push(...page.value);
      next = page["@odata.nextLink"] || null;
    }
    return items;
  }

  return { get, getAll };
}
