import type { AuthMethod, DiscoveredModel } from "./providerTypes";
import { inferCapabilities, formatModelDisplayName } from "./providerTypes";

interface ProviderConfig {
  apiURL: string;
  modelsURL?: string;
  authMethod?: AuthMethod;
  apiKey?: string;
  authHeaderName?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
}

interface ModelsResponse {
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
  }>;
}

export function buildAuthHeaders(
  config: ProviderConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const authMethod = config.authMethod || "bearer";
  const apiKey = config.apiKey || "";

  switch (authMethod) {
    case "bearer":
      headers["Authorization"] = `${config.authPrefix ?? "Bearer "}${apiKey}`;
      break;
    case "x-api-key":
      headers[config.authHeaderName || "x-api-key"] = apiKey;
      break;
    case "api-key-header":
      headers[config.authHeaderName || "api-key"] = apiKey;
      break;
    case "none":
      break;
    case "aws-sigv4":
      // Not supported yet
      break;
  }

  // Always merge extraHeaders at the end
  if (config.extraHeaders) {
    for (const key of Object.keys(config.extraHeaders)) {
      headers[key] = config.extraHeaders[key];
    }
  }

  return headers;
}

export async function discoverModels(
  config: ProviderConfig,
): Promise<DiscoveredModel[]> {
  const modelsURL =
    config.modelsURL || config.apiURL.replace(/\/+$/, "") + "/models";
  const headers = buildAuthHeaders(config);

  const response = await Zotero.HTTP.request("GET", modelsURL, {
    headers,
  });

  const text = response.responseText || "{}";
  const parsed: ModelsResponse = JSON.parse(text);
  const models: DiscoveredModel[] = (parsed.data || []).map(
    (item): DiscoveredModel => ({
      id: item.id,
      object: item.object || "model",
      created: item.created,
      owned_by: item.owned_by,
      displayName: formatModelDisplayName(item.id),
      capabilities: inferCapabilities(item.id),
    }),
  );

  return models;
}

export async function testProviderConnection(
  config: ProviderConfig,
): Promise<{ success: boolean; modelCount?: number; error?: string }> {
  try {
    const models = await discoverModels(config);
    return { success: true, modelCount: models.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
