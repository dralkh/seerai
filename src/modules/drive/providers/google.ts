import { CloudProvider } from "./base";
import {
  FileNode,
  CloudProviderId,
  getRedirectUri,
  OAUTH_PROXY_URL,
  OAUTH_PROXY_KEY,
} from "../types";
import {
  AUTH_URL,
  TOKEN_URL,
  PREFS_CLIENT_ID,
  PREFS_CLIENT_SECRET,
  PREFS_REFRESH_TOKEN,
  PREFS_ACCESS_TOKEN,
  PREFS_TOKEN_EXPIRY,
  GDRIVE_SCOPES,
  DEFAULT_CLIENT_ID,
  DRIVE_API_BASE,
} from "../types";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDE_MIME = "application/vnd.google-apps.presentation";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

export class GoogleDriveProvider implements CloudProvider {
  readonly id: CloudProviderId = "google";
  readonly name = "Google Drive";
  readonly icon = "\u2601\uFE0F";
  readonly brandColor = "#4285F4";

  private authInProgress = false;
  private authResolve: ((success: boolean) => void) | null = null;

  getRedirectUri(): string {
    return getRedirectUri(this.id);
  }

  private getClientId(): string {
    return (Zotero.Prefs.get(PREFS_CLIENT_ID) as string) || DEFAULT_CLIENT_ID;
  }

  private getClientSecret(): string {
    return (Zotero.Prefs.get(PREFS_CLIENT_SECRET) as string) || "";
  }

  isLoggedIn(): boolean {
    return !!Zotero.Prefs.get(PREFS_REFRESH_TOKEN);
  }

  logout(): void {
    Zotero.Prefs.set(PREFS_REFRESH_TOKEN, "");
    Zotero.Prefs.set(PREFS_ACCESS_TOKEN, "");
    Zotero.Prefs.set(PREFS_TOKEN_EXPIRY, "0");
  }

  isConfigured(): boolean {
    return true;
  }

  async login(): Promise<boolean> {
    if (this.authInProgress) return false;
    const clientId = this.getClientId();
    if (!clientId) return false;

    this.authInProgress = true;

    const authUrl = `${AUTH_URL}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.getRedirectUri(),
      response_type: "code",
      scope: GDRIVE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
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
      if (!clientId) throw new Error("Google Drive client ID not configured");

      const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.getRedirectUri(),
        grant_type: "authorization_code",
      });

      const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Token exchange failed: ${resp.status} ${text}`);
      }

      const data = (await resp.json()) as any;
      Zotero.Prefs.set(PREFS_REFRESH_TOKEN, data.refresh_token || "");
      Zotero.Prefs.set(PREFS_ACCESS_TOKEN, data.access_token || "");
      Zotero.Prefs.set(
        PREFS_TOKEN_EXPIRY,
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
    Zotero.Prefs.set(PREFS_REFRESH_TOKEN, data.refresh_token || "");
    Zotero.Prefs.set(PREFS_ACCESS_TOKEN, data.access_token || "");
    Zotero.Prefs.set(
      PREFS_TOKEN_EXPIRY,
      String(Date.now() + (data.expires_in || 3600) * 1000),
    );
  }

  private async getValidAccessToken(): Promise<string | null> {
    const accessToken = Zotero.Prefs.get(PREFS_ACCESS_TOKEN) as string;
    const expiryStr = Zotero.Prefs.get(PREFS_TOKEN_EXPIRY) as string;
    const refreshToken = Zotero.Prefs.get(PREFS_REFRESH_TOKEN) as string;

    if (!refreshToken) return null;

    const expiry = parseInt(expiryStr || "0", 10);
    if (Date.now() < expiry - 30_000 && accessToken) {
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
        Zotero.Prefs.set(PREFS_ACCESS_TOKEN, data.access_token || "");
        Zotero.Prefs.set(
          PREFS_TOKEN_EXPIRY,
          String(Date.now() + (data.expires_in || 3600) * 1000),
        );
      }

      return (Zotero.Prefs.get(PREFS_ACCESS_TOKEN) as string) || null;
    } catch {
      return null;
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Google Drive");

    const url = path.startsWith("http") ? path : `${DRIVE_API_BASE}${path}`;
    const resp = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers || {}),
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Drive API error ${resp.status}: ${text.slice(0, 500)}`);
    }

    return resp.json() as Promise<T>;
  }

  private async requestBuffer(path: string): Promise<ArrayBuffer> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Google Drive");

    const url = path.startsWith("http") ? path : `${DRIVE_API_BASE}${path}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Drive download error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    return resp.arrayBuffer();
  }

  private async requestText(path: string): Promise<string> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Google Drive");

    const url = path.startsWith("http") ? path : `${DRIVE_API_BASE}${path}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Drive request error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    return resp.text();
  }

  private async resolveShortcut(f: any): Promise<FileNode> {
    if (f.mimeType !== GOOGLE_SHORTCUT_MIME || !f.shortcutDetails?.targetId) {
      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        isFolder: f.mimeType === GOOGLE_FOLDER_MIME,
      };
    }
    try {
      const target = await this.getFileMetadata(f.shortcutDetails.targetId);
      return target;
    } catch {
      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        isFolder: false,
      };
    }
  }

  async listFolder(
    folderId: string = "root",
    pageToken?: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    if (!folderId) folderId = "root";
    const q = `'${folderId}' in parents and trashed=false`;
    const fields =
      "files(id,name,mimeType,modifiedTime,parents,shortcutDetails),nextPageToken";
    const orderBy = "folder,name";

    let path = `/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&orderBy=${encodeURIComponent(orderBy)}&pageSize=100`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;

    const data = await this.request<{
      files: any[];
      nextPageToken?: string;
    }>(path);
    const nodes = await Promise.all(
      (data.files || []).map((f) => this.resolveShortcut(f)),
    );
    return { nodes, nextPageToken: data.nextPageToken };
  }

  async searchFiles(
    query: string,
    pageToken?: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    const q = `name contains '${query.replace(/'/g, "\\'")}' and trashed=false`;
    const fields =
      "files(id,name,mimeType,modifiedTime,parents,shortcutDetails),nextPageToken";

    let path = `/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=100`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;

    const data = await this.request<{
      files: any[];
      nextPageToken?: string;
    }>(path);
    const nodes = await Promise.all(
      (data.files || []).map((f) => this.resolveShortcut(f)),
    );
    return { nodes, nextPageToken: data.nextPageToken };
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    return this.requestBuffer(`/files/${fileId}?alt=media`);
  }

  async uploadFile(
    fileId: string,
    content: string,
    mimeType: string,
  ): Promise<void> {
    const token = await this.getValidAccessToken();
    if (!token) throw new Error("Not authenticated to Google Drive");

    const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: content,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Drive upload error ${resp.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async getFileMetadata(fileId: string): Promise<FileNode> {
    const path = `/files/${fileId}?fields=id,name,mimeType,modifiedTime,parents,shortcutDetails`;
    const data = await this.request<any>(path);
    return this.resolveShortcut(data);
  }

  async getFileTextContent(
    file: FileNode,
  ): Promise<{ content: string; mimeType: string } | null> {
    const exportMime = this.getExportMimeType(file.mimeType);
    if (exportMime) {
      const url = `${DRIVE_API_BASE}/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`;
      const content = await this.requestText(url);
      return { content, mimeType: exportMime };
    }

    if (TEXT_MIME_TYPES.includes(file.mimeType)) {
      const content = await this.requestText(`/files/${file.id}?alt=media`);
      return { content, mimeType: file.mimeType };
    }

    return null;
  }

  isTextExportable(mimeType: string): boolean {
    return (
      mimeType === GOOGLE_DOC_MIME ||
      mimeType === GOOGLE_SHEET_MIME ||
      mimeType === GOOGLE_SLIDE_MIME ||
      mimeType === DOCX_MIME ||
      TEXT_MIME_TYPES.includes(mimeType)
    );
  }

  private getExportMimeType(mimeType: string): string | null {
    if (mimeType === GOOGLE_DOC_MIME) return "text/markdown";
    if (mimeType === GOOGLE_SHEET_MIME) return "text/csv";
    if (mimeType === GOOGLE_SLIDE_MIME) return "text/plain";
    if (mimeType === DOCX_MIME) return "text/plain";
    return null;
  }
}
