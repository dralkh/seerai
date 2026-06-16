import { CloudProvider } from "./base";
import type { IconName } from "../../chat/ui/icons";
import { FileNode, CloudProviderId } from "../types";
import { config } from "../../../../package.json";
import { stringToBase64 } from "../utils";

function pref(key: string): string {
  return `${config.prefsPrefix}.cloud.nextcloud.${key}`;
}

const SERVER_URL_PREF = pref("serverUrl");
const USERNAME_PREF = pref("username");
const APP_PASSWORD_PREF = pref("appPassword");

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

export class NextcloudProvider implements CloudProvider {
  readonly id: CloudProviderId = "nextcloud";
  readonly name = "Nextcloud";
  readonly icon: IconName = "server";
  readonly brandColor = "#0082C9";

  getRedirectUri(): string {
    return `${this.getServerUrl()}/seerai/nextcloud/callback`;
  }

  private getServerUrl(): string {
    return (Zotero.Prefs.get(SERVER_URL_PREF) as string) || "";
  }

  private getUsername(): string {
    return (Zotero.Prefs.get(USERNAME_PREF) as string) || "";
  }

  private getAppPassword(): string {
    return (Zotero.Prefs.get(APP_PASSWORD_PREF) as string) || "";
  }

  private getAuthHeader(): string {
    return (
      "Basic " +
      stringToBase64(`${this.getUsername()}:${this.getAppPassword()}`)
    );
  }

  isLoggedIn(): boolean {
    return !!(
      this.getServerUrl() &&
      this.getUsername() &&
      this.getAppPassword()
    );
  }

  async login(): Promise<boolean> {
    if (!this.isLoggedIn()) return false;
    try {
      const rootUrl =
        this.getServerUrl().replace(/\/+$/, "") +
        "/remote.php/dav/files/" +
        this.getUsername() +
        "/";
      const resp = await fetch(rootUrl, {
        method: "PROPFIND",
        headers: {
          Authorization: this.getAuthHeader(),
          Depth: "0",
        },
      });
      return resp.status >= 200 && resp.status < 300;
    } catch {
      return false;
    }
  }

  logout(): void {
    Zotero.Prefs.set(SERVER_URL_PREF, "");
    Zotero.Prefs.set(USERNAME_PREF, "");
    Zotero.Prefs.set(APP_PASSWORD_PREF, "");
  }

  isConfigured(): boolean {
    return this.isLoggedIn();
  }

  async handleCallback(_code: string): Promise<void> {
    // Nextcloud doesn't use OAuth; credentials are set in settings panel
  }

  async listFolder(
    folderId: string = "",
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    const base = this.getServerUrl().replace(/\/+$/, "");
    const user = this.getUsername();
    const rootPath = `${base}/remote.php/dav/files/${user}/`;
    const davPrefix = `/remote.php/dav/files/${user}/`;
    let cleanId = folderId;
    if (cleanId && cleanId !== "root" && cleanId.startsWith(davPrefix)) {
      cleanId = cleanId.slice(davPrefix.length);
    }
    const url =
      !cleanId || cleanId === "root"
        ? rootPath
        : cleanId.startsWith("http")
          ? cleanId
          : `${rootPath}${cleanId.replace(/^\//, "")}`;

    const resp = await fetch(url, {
      method: "PROPFIND",
      headers: {
        Authorization: this.getAuthHeader(),
        Depth: "1",
      },
    });

    if (!resp.ok) {
      throw new Error(`Nextcloud PROPFIND error ${resp.status}`);
    }

    const xmlText = await resp.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    const responses = xmlDoc.getElementsByTagNameNS("DAV:", "response");
    const nodes: FileNode[] = [];

    const requestHref = new URL(url).pathname;

    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const hrefEl = response.getElementsByTagNameNS("DAV:", "href")[0];
      if (!hrefEl) continue;

      const href = decodeURIComponent(hrefEl.textContent || "").replace(
        /\/+$/,
        "",
      );

      // Skip the directory we're listing (self-reference)
      if (href === requestHref || href === requestHref.replace(/\/$/, ""))
        continue;

      const propstat = response.getElementsByTagNameNS("DAV:", "propstat")[0];
      if (!propstat) continue;

      const prop = propstat.getElementsByTagNameNS("DAV:", "prop")[0];
      if (!prop) continue;

      const displayNameEl = prop.getElementsByTagNameNS(
        "DAV:",
        "displayname",
      )[0];
      const name =
        displayNameEl?.textContent ||
        href.split("/").filter(Boolean).pop() ||
        "";

      const getLastModifiedEl = prop.getElementsByTagNameNS(
        "DAV:",
        "getlastmodified",
      )[0];
      const modifiedTime = getLastModifiedEl?.textContent || "";

      const contentTypeEl = prop.getElementsByTagNameNS(
        "DAV:",
        "getcontenttype",
      )[0];
      const mimeType = contentTypeEl?.textContent || "";

      const resourceType = prop.getElementsByTagNameNS(
        "DAV:",
        "resourcetype",
      )[0];
      const isFolder = !!resourceType?.getElementsByTagNameNS(
        "DAV:",
        "collection",
      ).length;

      nodes.push({
        id: href,
        name,
        mimeType: isFolder ? "folder" : mimeType || "application/octet-stream",
        modifiedTime,
        isFolder,
      });
    }

    return { nodes };
  }

  async searchFiles(
    query: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }> {
    const base = this.getServerUrl().replace(/\/+$/, "");
    const url = `${base}/ocs/v2.php/search/providers/files/search?term=${encodeURIComponent(query)}`;

    const resp = await fetch(url, {
      headers: {
        Authorization: this.getAuthHeader(),
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      throw new Error(`Nextcloud search error ${resp.status}`);
    }

    const data = (await resp.json()) as any;
    const results: any[] = data?.ocs?.data || [];

    const nodes: FileNode[] = results.map((r: any) => ({
      id: r.path
        ? `${base}/remote.php/dav/files/${this.getUsername()}${r.path}`
        : r.id || "",
      name: r.name || r.title || "",
      mimeType: r.mimeType || this.guessMimeType(r.name || r.title || ""),
      modifiedTime: r.timestamp
        ? new Date(r.timestamp * 1000).toUTCString()
        : "",
      isFolder: r.type === "dir" || r.type === "folder",
    }));

    return { nodes };
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const url = fileId.startsWith("http")
      ? fileId
      : `${this.getServerUrl().replace(/\/+$/, "")}${fileId.startsWith("/") ? "" : "/"}${fileId}`;

    const resp = await fetch(url, {
      headers: { Authorization: this.getAuthHeader() },
    });

    if (!resp.ok) {
      throw new Error(`Nextcloud download error ${resp.status}`);
    }

    return resp.arrayBuffer();
  }

  async uploadFile(
    fileId: string,
    content: string,
    mimeType: string,
  ): Promise<void> {
    const url = fileId.startsWith("http")
      ? fileId
      : `${this.getServerUrl().replace(/\/+$/, "")}${fileId.startsWith("/") ? "" : "/"}${fileId}`;

    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": mimeType,
      },
      body: content,
    });

    if (!resp.ok) {
      throw new Error(`Nextcloud upload error ${resp.status}`);
    }
  }

  async getFileMetadata(fileId: string): Promise<FileNode> {
    const url = fileId.startsWith("http")
      ? fileId
      : `${this.getServerUrl().replace(/\/+$/, "")}${fileId.startsWith("/") ? "" : "/"}${fileId}`;

    const resp = await fetch(url, {
      method: "PROPFIND",
      headers: {
        Authorization: this.getAuthHeader(),
        Depth: "0",
      },
    });

    if (!resp.ok) {
      throw new Error(`Nextcloud PROPFIND error ${resp.status}`);
    }

    const xmlText = await resp.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    const responseEl = xmlDoc.getElementsByTagNameNS("DAV:", "response")[0];
    if (!responseEl) throw new Error("No response in PROPFIND result");

    const hrefEl = responseEl.getElementsByTagNameNS("DAV:", "href")[0];
    const href = decodeURIComponent(hrefEl?.textContent || fileId);

    const propstat = responseEl.getElementsByTagNameNS("DAV:", "propstat")[0];
    const prop = propstat?.getElementsByTagNameNS("DAV:", "prop")[0];
    if (!prop) throw new Error("No props in PROPFIND result");

    const displayNameEl = prop.getElementsByTagNameNS("DAV:", "displayname")[0];
    const name =
      displayNameEl?.textContent || href.split("/").filter(Boolean).pop() || "";

    const getLastModifiedEl = prop.getElementsByTagNameNS(
      "DAV:",
      "getlastmodified",
    )[0];
    const modifiedTime = getLastModifiedEl?.textContent || "";

    const contentTypeEl = prop.getElementsByTagNameNS(
      "DAV:",
      "getcontenttype",
    )[0];
    const mimeType = contentTypeEl?.textContent || "";

    const resourceType = prop.getElementsByTagNameNS("DAV:", "resourcetype")[0];
    const isFolder = !!resourceType?.getElementsByTagNameNS(
      "DAV:",
      "collection",
    ).length;

    return {
      id: href,
      name,
      mimeType: isFolder ? "folder" : mimeType || "application/octet-stream",
      modifiedTime,
      isFolder,
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
