import { CloudProvider } from "./base";
import type { IconName } from "../../chat/ui/icons";
import {
  FileNode,
  CloudProviderId,
  getRedirectUri,
  DEFAULT_ONEDRIVE_CLIENT_ID,
} from "../types";
import { generatePKCE, generateState } from "../pkce";
import { config } from "../../../../package.json";

function pref(key: string): string {
  return `${config.prefsPrefix}.cloud.onedrive.${key}`;
}

const CLIENT_ID_PREF = pref("clientId");
const SITE_ID_PREF = pref("siteId");
const REFRESH_TOKEN_PREF = pref("refreshToken");
const ACCESS_TOKEN_PREF = pref("accessToken");
const TOKEN_EXPIRY_PREF = pref("tokenExpiry");

const AUTH_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_URL = "https://graph.microsoft.com/v1.0";

const SCOPES = ["Files.Read.All", "offline_access"];

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

export class OneDriveProvider implements CloudProvider {
  readonly id: CloudProviderId = "onedrive";
  readonly name = "OneDrive";
  readonly icon: IconName = "globe";
  readonly brandColor = "#0078D4";

  private authInProgress = false;
  private authResolve: ((success: boolean) => void) | null = null;
  private pendingVerifier: string | null = null;

  getRedirectUri(): string {
    return getRedirectUri(this.id);
  }

  private getClientId(): string {
    return (
      (Zotero.Prefs.get(CLIENT_ID_PREF) as string) || DEFAULT_ONEDRIVE_CLIENT_ID
    );
  }

  private getSiteId(): string {
    return (Zotero.Prefs.get(SITE_ID_PREF) as string) || "";
  }

  private getDrivePath(): string {
    const siteId = this.getSiteId();
    return siteId ? `/sites/${siteId}/drive` : "/me/drive";
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

    const authUrl = `${AUTH_URL}?${new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: this.getRedirectUri(),
      response_mode: "query",
      scope: SCOPES.join(" "),
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
    if (!clientId) throw new Error("OneDrive client ID not configured");
    if (!this.pendingVerifier) throw new Error("No PKCE verifier found");

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: this.getRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: this.pendingVerifier,
    });

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OneDrive token exchange failed: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as any;
    Zotero.Prefs.set(REFRESH_TOKEN_PREF, data.refresh_token || "");
    Zotero.Prefs.set(ACCESS_TOKEN_PREF, data.access_token || "");
    Zotero.Prefs.set(
      TOKEN_EXPIRY_PREF,
      String(Date.now() + (data.expires_in || 3600) * 1000),
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
        redirect_uri: this.getRedirectUri(),
        grant_type: "refresh_token",
      });

      const resp = await fetch(TOKEN_URL, {
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
      return data.access_token || "";
    } catch {
      return null;
    }
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to OneDrive");

    const url = path.startsWith("http") ? path : `${GRAPH_URL}${path}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `OneDrive API error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  private toFileNode(entry: any): FileNode {
    const isFolder = !!entry.folder;
    return {
      id: entry.id,
      name: entry.name,
      mimeType: isFolder
        ? "folder"
        : entry.file?.mimeType || this.guessMimeType(entry.name),
      modifiedTime: entry.lastModifiedDateTime || "",
      isFolder,
    };
  }

  async listFolder(
    folderId: string = "root",
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    if (!folderId) folderId = "root";
    const drivePath = this.getDrivePath();
    const path =
      folderId === "root"
        ? `${drivePath}/root/children`
        : `${drivePath}/items/${folderId}/children`;

    const data = await this.request<any>(`${path}?$top=100`);

    const nodes: FileNode[] = (data.value || []).map((e: any) =>
      this.toFileNode(e),
    );
    return { nodes, nextPageToken: data["@odata.nextLink"] || undefined };
  }

  async searchFiles(
    query: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    const drivePath = this.getDrivePath();
    const searchUrl = `${drivePath}/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')`;

    const data = await this.request<any>(searchUrl);

    const nodes: FileNode[] = (data.value || []).map((e: any) =>
      this.toFileNode(e),
    );
    return { nodes, nextPageToken: data["@odata.nextLink"] || undefined };
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to OneDrive");

    const drivePath = this.getDrivePath();
    const url = `${GRAPH_URL}${drivePath}/items/${fileId}/content`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `OneDrive download error ${resp.status}: ${text.slice(0, 500)}`,
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
    if (!token) throw new Error("Not authenticated to OneDrive");

    const drivePath = this.getDrivePath();
    const url = `${GRAPH_URL}${drivePath}/items/${fileId}/content`;

    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: content,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `OneDrive upload error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async getFileMetadata(fileId: string): Promise<FileNode> {
    const drivePath = this.getDrivePath();
    const data = await this.request<any>(`${drivePath}/items/${fileId}`);
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
