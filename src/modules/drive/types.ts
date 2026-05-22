export interface FileNode {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  isFolder: boolean;
}

export type CloudProviderId =
  | "google"
  | "onedrive"
  | "dropbox"
  | "box"
  | "nextcloud";

export interface DriveContextData {
  provider: CloudProviderId;
  icon: string;
  driveFileId: string;
  mimeType: string;
  name: string;
  lastKnownModifiedTime: string;
  extractedContent: string;
}

export const GDRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

export function getRedirectPort(): number {
  return 23119;
}

export function getRedirectUri(providerId: string): string {
  const port = getRedirectPort();
  return `http://localhost:${port}/seerai/${providerId}/callback`;
}

export const GDRIVE_REDIRECT_PORT = 23119;
export const GDRIVE_REDIRECT_PATH = "/seerai/google/callback";
export const GDRIVE_REDIRECT_URI = `http://localhost:${GDRIVE_REDIRECT_PORT}${GDRIVE_REDIRECT_PATH}`;

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

export const DEFAULT_CLIENT_ID =
  "22680022759-6e2lkrpjujrlhuqph1kon1b4q83noevt.apps.googleusercontent.com";

export const DEFAULT_DROPBOX_CLIENT_ID = "i91subs0zer8bi1";

export const DEFAULT_ONEDRIVE_CLIENT_ID =
  "c1cf27ad-234e-4c44-b233-973eb32846fa";
export const DEFAULT_BOX_CLIENT_ID = "ozyt20t94vkvr3eu3nag0se0zti4ftpb";

export const OAUTH_PROXY_URL = "https://seerai.amayx.com/api/oauth/token";
export const OAUTH_PROXY_KEY =
  "0f9e1a2905e36dbe27ce53aa257960b0d211e34dc493d65e6106aa53c301d0f0";

export const PREFS_CLIENT_ID = "extensions.zotero.seerai.driveClientId";
export const PREFS_CLIENT_SECRET = "extensions.zotero.seerai.driveClientSecret";
export const PREFS_REFRESH_TOKEN = "extensions.zotero.seerai.driveRefreshToken";
export const PREFS_ACCESS_TOKEN = "extensions.zotero.seerai.driveAccessToken";
export const PREFS_TOKEN_EXPIRY = "extensions.zotero.seerai.driveTokenExpiry";
