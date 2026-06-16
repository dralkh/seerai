import { CloudProvider } from "./base";
import type { IconName } from "../../chat/ui/icons";
import {
  FileNode,
  CloudProviderId,
  getRedirectUri,
  DEFAULT_DROPBOX_CLIENT_ID,
} from "../types";
import { generatePKCE, generateState } from "../pkce";
import { config } from "../../../../package.json";

function pref(key: string): string {
  return `${config.prefsPrefix}.cloud.dropbox.${key}`;
}

const CLIENT_ID_PREF = pref("clientId");
const REFRESH_TOKEN_PREF = pref("refreshToken");
const ACCESS_TOKEN_PREF = pref("accessToken");
const TOKEN_EXPIRY_PREF = pref("tokenExpiry");

const DROPBOX_AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_API_URL = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_URL = "https://content.dropboxapi.com/2";

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

export class DropboxProvider implements CloudProvider {
  readonly id: CloudProviderId = "dropbox";
  readonly name = "Dropbox";
  readonly icon: IconName = "folder";
  readonly brandColor = "#0061FF";

  private authInProgress = false;
  private authResolve: ((success: boolean) => void) | null = null;
  private pendingVerifier: string | null = null;

  getRedirectUri(): string {
    return getRedirectUri(this.id);
  }

  private getClientId(): string {
    return (
      (Zotero.Prefs.get(CLIENT_ID_PREF) as string) || DEFAULT_DROPBOX_CLIENT_ID
    );
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

    const pkce = await generatePKCE();
    this.pendingVerifier = pkce.verifier;
    const state = generateState();

    const authUrl = `${DROPBOX_AUTH_URL}?${new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: this.getRedirectUri(),
      token_access_type: "offline",
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
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
    const clientId = this.getClientId();
    if (!clientId) throw new Error("Dropbox client ID not configured");
    if (!this.pendingVerifier) throw new Error("No PKCE verifier found");

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: this.getRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: this.pendingVerifier,
    });

    const resp = await fetch(DROPBOX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Dropbox token exchange failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as any;
    Zotero.Prefs.set(REFRESH_TOKEN_PREF, data.refresh_token || "");
    Zotero.Prefs.set(ACCESS_TOKEN_PREF, data.access_token || "");
    Zotero.Prefs.set(
      TOKEN_EXPIRY_PREF,
      String(Date.now() + (data.expires_in || 14400) * 1000),
    );

    this.pendingVerifier = null;
    if (this.authResolve) {
      this.authResolve(true);
      this.authResolve = null;
    }
    this.authInProgress = false;
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
      const clientId = this.getClientId();
      if (!clientId) return null;

      const body = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        grant_type: "refresh_token",
      });

      const resp = await fetch(DROPBOX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!resp.ok) {
        this.logout();
        return null;
      }

      const data = (await resp.json()) as any;
      const newToken = data.access_token || "";
      Zotero.Prefs.set(ACCESS_TOKEN_PREF, newToken);
      Zotero.Prefs.set(
        TOKEN_EXPIRY_PREF,
        String(Date.now() + (data.expires_in || 14400) * 1000),
      );
      return newToken;
    } catch {
      return null;
    }
  }

  private async apiPost<T>(url: string, body: any): Promise<T> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Dropbox");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Dropbox API error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  async listFolder(
    folderPath: string = "",
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    const data = await this.apiPost<any>(
      `${DROPBOX_API_URL}/files/list_folder`,
      {
        path: folderPath || "",
        recursive: false,
        include_media_info: false,
      },
    );

    const nodes: FileNode[] = data.entries.map((entry: any) => ({
      id: entry.id || entry.path_lower,
      name: entry.name,
      mimeType:
        entry[".tag"] === "folder" ? "folder" : this.guessMimeType(entry.name),
      modifiedTime: entry.server_modified || "",
      isFolder: entry[".tag"] === "folder",
    }));

    return { nodes, nextPageToken: data.cursor };
  }

  async searchFiles(
    query: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    const data = await this.apiPost<any>(`${DROPBOX_API_URL}/files/search_v2`, {
      query,
      options: {
        max_results: 50,
        file_status: "active",
      },
    });

    const nodes: FileNode[] = (data.matches || []).map((match: any) => {
      const meta = match.metadata.metadata;
      return {
        id: meta.id || meta.path_lower,
        name: meta.name,
        mimeType:
          meta[".tag"] === "folder" ? "folder" : this.guessMimeType(meta.name),
        modifiedTime: meta.server_modified || "",
        isFolder: meta[".tag"] === "folder",
      };
    });

    return { nodes, nextPageToken: undefined };
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Dropbox");

    const resp = await fetch(`${DROPBOX_CONTENT_URL}/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: fileId }),
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Dropbox download error ${resp.status}: ${text.slice(0, 500)}`,
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
    if (!token) throw new Error("Not authenticated to Dropbox");

    const resp = await fetch(`${DROPBOX_CONTENT_URL}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path: fileId,
          mode: { ".tag": "overwrite" },
        }),
      },
      body: content,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Dropbox upload error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async getFileMetadata(fileId: string): Promise<FileNode> {
    const data = await this.apiPost<any>(
      `${DROPBOX_API_URL}/files/get_metadata`,
      { path: fileId },
    );

    return {
      id: data.id || data.path_lower,
      name: data.name,
      mimeType:
        data[".tag"] === "folder" ? "folder" : this.guessMimeType(data.name),
      modifiedTime: data.server_modified || "",
      isFolder: data[".tag"] === "folder",
    };
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
