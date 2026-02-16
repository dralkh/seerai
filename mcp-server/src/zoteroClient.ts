/**
 * Zotero HTTP Client
 *
 * Makes HTTP requests to the Zotero plugin's API endpoints.
 */

const DEFAULT_ZOTERO_URL = "http://127.0.0.1:23119";

export interface ZoteroClientConfig {
  baseUrl: string;
  timeout?: number;
}

export interface ZoteroResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  summary?: string;
}

export class ZoteroClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config?: Partial<ZoteroClientConfig>) {
    this.baseUrl =
      config?.baseUrl || process.env.ZOTERO_API_URL || DEFAULT_ZOTERO_URL;
    this.timeout = config?.timeout || 30000;
  }

  /**
   * Check if Zotero is running and the API is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.request("GET", "/seerai/health", undefined);
      return response.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Call a Zotero tool
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ZoteroResponse> {
    const endpoint = `/seerai/${toolName}`;
    return this.request("POST", endpoint, args);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const options: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      };

      if (body && method === "POST") {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Singleton instance
let clientInstance: ZoteroClient | null = null;

export function getZoteroClient(): ZoteroClient {
  if (!clientInstance) {
    clientInstance = new ZoteroClient();
  }
  return clientInstance;
}
