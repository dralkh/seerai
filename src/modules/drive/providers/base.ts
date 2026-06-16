import { FileNode, CloudProviderId } from "../types";
import type { IconName } from "../../chat/ui/icons";

export interface CloudProvider {
  readonly id: CloudProviderId;
  readonly name: string;
  readonly icon: IconName;
  readonly brandColor: string;

  isLoggedIn(): boolean;
  login(): Promise<boolean>;
  cancelLogin?(): void;
  logout(): void;

  isConfigured(): boolean;

  handleCallback(code: string): Promise<void>;
  getRedirectUri(): string;

  listFolder(
    folderId: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }>;
  searchFiles(
    query: string,
  ): Promise<{ nodes: FileNode[]; nextPageToken?: string }>;
  downloadFile(fileId: string): Promise<ArrayBuffer>;
  getFileMetadata(fileId: string): Promise<FileNode>;

  getFileTextContent(
    file: FileNode,
  ): Promise<{ content: string; mimeType: string } | null>;
  isTextExportable(mimeType: string): boolean;
  uploadFile(fileId: string, content: string, mimeType: string): Promise<void>;
}
