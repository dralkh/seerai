import { CloudProvider } from "./base";
import {
  FileNode,
  CloudProviderId,
  getRedirectUri,
  DEFAULT_BOX_CLIENT_ID,
  OAUTH_PROXY_URL,
  OAUTH_PROXY_KEY,
} from "../types";
import { generateState } from "../pkce";
import { config } from "../../../../package.json";

function pref(key: string): string {
  return `${config.prefsPrefix}.cloud.box.${key}`;
}

const CLIENT_ID_PREF = pref("clientId");
const CLIENT_SECRET_PREF = pref("clientSecret");
const REFRESH_TOKEN_PREF = pref("refreshToken");
const ACCESS_TOKEN_PREF = pref("accessToken");
const TOKEN_EXPIRY_PREF = pref("tokenExpiry");

const BOX_AUTH_URL = "https://account.box.com/api/oauth2/authorize";
const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";
const BOX_API_URL = "https://api.box.com/2.0";

const TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "application/json",
  "application/rtf",
  "text/javascript",
  "text/typescript",
  "text/css",
  "image/svg+xml",
  "application/xml",
  "text/x-tex",
  "application/x-tex",
  "text/x-python",
  "text/x-java",
  "application/x-sh",
  "text/x-rust",
  "text/x-toml",
  "text/x-yaml",
  "text/x-latex",
];

export class BoxProvider implements CloudProvider {
  readonly id: CloudProviderId = "box";
  readonly name = "Box";
  readonly icon = "\uD83D\uDDC3\uFE0F";
  readonly brandColor = "#0061D5";

  private authInProgress = false;
  private authResolve: ((success: boolean) => void) | null = null;

  getRedirectUri(): string {
    return getRedirectUri(this.id);
  }

  private getClientId(): string {
    return (
      (Zotero.Prefs.get(CLIENT_ID_PREF) as string) || DEFAULT_BOX_CLIENT_ID
    );
  }

  private getClientSecret(): string {
    return (Zotero.Prefs.get(CLIENT_SECRET_PREF) as string) || "";
  }

  isLoggedIn(): boolean {
    return !!Zotero.Prefs.get(REFRESH_TOKEN_PREF);
  }

  logout(): void {
    Zotero.Prefs.set(REFRESH_TOKEN_PREF, "");
    Zotero.Prefs.set(ACCESS_TOKEN_PREF, "");
    Zotero.Prefs.set(TOKEN_EXPIRY_PREF, "0");
  }

  isConfigured(): boolean {
    return true;
  }

  async login(): Promise<boolean> {
    if (this.authInProgress) return false;
    const clientId = this.getClientId();
    if (!clientId) return false;

    this.authInProgress = true;

    const state = generateState();

    const authUrl = `${BOX_AUTH_URL}?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: this.getRedirectUri(),
      state,
    }).toString()}`;

    return new Promise<boolean>((resolve) => {
      this.authResolve = resolve;
      Zotero.launchURL(authUrl);
      setTimeout(() => {
        if (this.authInProgress) {
          this.cancelLogin();
          resolve(false);
        }
      }, 120_000);
    });
  }

  cancelLogin(): void {
    this.authInProgress = false;
    if (this.authResolve) {
      this.authResolve(false);
      this.authResolve = null;
    }
  }

  async handleCallback(code: string): Promise<void> {
    const clientSecret = this.getClientSecret();

    if (!clientSecret) {
      await this.proxyTokenExchange({
        provider: this.id,
        grant_type: "authorization_code",
        code,
        redirect_uri: this.getRedirectUri(),
      });
    } else {
      const clientId = this.getClientId();
      if (!clientId) throw new Error("Box client ID not configured");

      const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.getRedirectUri(),
        grant_type: "authorization_code",
      });

      const resp = await fetch(BOX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Box token exchange failed: ${resp.status} ${text}`);
      }

      const data = (await resp.json()) as any;
      Zotero.Prefs.set(REFRESH_TOKEN_PREF, data.refresh_token || "");
      Zotero.Prefs.set(ACCESS_TOKEN_PREF, data.access_token || "");
      Zotero.Prefs.set(
        TOKEN_EXPIRY_PREF,
        String(Date.now() + (data.expires_in || 3600) * 1000),
      );
    }

    if (this.authResolve) {
      this.authResolve(true);
      this.authResolve = null;
    }
    this.authInProgress = false;
  }

  private async proxyTokenExchange(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const resp = await fetch(OAUTH_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": OAUTH_PROXY_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `OAuth proxy error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await resp.json()) as any;
    Zotero.Prefs.set(REFRESH_TOKEN_PREF, data.refresh_token || "");
    Zotero.Prefs.set(ACCESS_TOKEN_PREF, data.access_token || "");
    Zotero.Prefs.set(
      TOKEN_EXPIRY_PREF,
      String(Date.now() + (data.expires_in || 3600) * 1000),
    );
  }

  private async getValidAccessToken(): Promise<string | null> {
    const accessToken = Zotero.Prefs.get(ACCESS_TOKEN_PREF) as string;
    const expiryStr = Zotero.Prefs.get(TOKEN_EXPIRY_PREF) as string;
    const refreshToken = Zotero.Prefs.get(REFRESH_TOKEN_PREF) as string;

    if (!refreshToken) return null;

    const expiry = parseInt(expiryStr || "0", 10);
    if (Date.now() < expiry - 60_000 && accessToken) {
      return accessToken;
    }

    try {
      const clientSecret = this.getClientSecret();

      if (!clientSecret) {
        await this.proxyTokenExchange({
          provider: this.id,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });
      } else {
        const clientId = this.getClientId();
        if (!clientId) return null;

        const body = new URLSearchParams({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
        });

        const resp = await fetch(BOX_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });

        if (!resp.ok) {
          this.logout();
          return null;
        }

        const data = (await resp.json()) as any;
        Zotero.Prefs.set(ACCESS_TOKEN_PREF, data.access_token || "");
        Zotero.Prefs.set(
          TOKEN_EXPIRY_PREF,
          String(Date.now() + (data.expires_in || 3600) * 1000),
        );
      }

      return (Zotero.Prefs.get(ACCESS_TOKEN_PREF) as string) || null;
    } catch {
      return null;
    }
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Box");

    const url = path.startsWith("http") ? path : `${BOX_API_URL}${path}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Box API error ${resp.status}: ${text.slice(0, 500)}`);
    }

    return resp.json() as Promise<T>;
  }

  private toFileNode(entry: any): FileNode {
    const isFolder = entry.type === "folder";
    return {
      id: entry.id,
      name: entry.name,
      mimeType: isFolder
        ? "folder"
        : entry.mime_type || this.guessMimeType(entry.name),
      modifiedTime: entry.modified_at || "",
      isFolder,
    };
  }

  async listFolder(
    folderId: string = "0",
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    if (!folderId) folderId = "0";
    const data = await this.request<any>(
      `/folders/${folderId}/items?limit=100&fields=id,name,type,mime_type,modified_at`,
    );

    const nodes: FileNode[] = (data.entries || []).map((e: any) =>
      this.toFileNode(e),
    );
    return { nodes, nextPageToken: data.offset?.toString() };
  }

  async searchFiles(
    query: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    const data = await this.request<any>(
      `/search?query=${encodeURIComponent(query)}&limit=50&fields=id,name,type,mime_type,modified_at`,
    );

    const nodes: FileNode[] = (data.entries || []).map((e: any) =>
      this.toFileNode(e),
    );
    return { nodes, nextPageToken: undefined };
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Box");

    const resp = await fetch(`${BOX_API_URL}/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Box download error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    return resp.arrayBuffer();
  }

  async uploadFile(
    fileId: string,
    content: string,
    mimeType: string,
  ): Promise<void> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Box");

    const resp = await fetch(`${BOX_API_URL}/files/${fileId}/content`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: content,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Box upload error ${resp.status}: ${text.slice(0, 500)}`);
    }
  }

  async getFileMetadata(fileId: string): Promise<FileNode> {
    const data = await this.request<any>(
      `/files/${fileId}?fields=id,name,type,mime_type,modified_at`,
    );
    return this.toFileNode(data);
  }

  async getFileTextContent(
    file: FileNode,
  ): Promise<{ content: string; mimeType: string } | null> {
    if (!this.isTextExportable(file.mimeType)) return null;
    const buffer = await this.downloadFile(file.id);
    const content = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    return { content, mimeType: file.mimeType };
  }

  isTextExportable(mimeType: string): boolean {
    return TEXT_MIME_TYPES.includes(mimeType);
  }

  private guessMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      md: "text/markdown",
      txt: "text/plain",
      csv: "text/csv",
      html: "text/html",
      htm: "text/html",
      xml: "text/xml",
      json: "application/json",
      rtf: "application/rtf",
      js: "text/javascript",
      ts: "text/typescript",
      css: "text/css",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
    };
    return map[ext] || "application/octet-stream";
  }
}
