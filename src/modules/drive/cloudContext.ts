import { DriveContextData, FileNode } from "./types";
import { ChatContextManager } from "../chat/context/contextManager";
import { ContextItemType, ContextItem } from "../chat/context/contextTypes";
import { stripBase64Data } from "../chat/imageUtils";
import { config } from "../../../package.json";
import { CloudProviderManager } from "./providerManager";

function driveContextFilePath(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "drive_context.json",
  );
}

async function readDriveContext(): Promise<Record<string, DriveContextData[]>> {
  try {
    const raw = await IOUtils.readUTF8(driveContextFilePath());
    const data: Record<string, any[]> = JSON.parse(raw);
    const normalized: Record<string, DriveContextData[]> = {};
    for (const [chatId, items] of Object.entries(data)) {
      normalized[chatId] = items.map((item: any) => ({
        provider: item.provider || "google",
        icon: item.icon || "",
        driveFileId: item.driveFileId,
        mimeType: item.mimeType,
        name: item.name,
        lastKnownModifiedTime: item.lastKnownModifiedTime,
        extractedContent: item.extractedContent,
      }));
    }
    return normalized;
  } catch {
    return {};
  }
}

async function writeDriveContext(
  all: Record<string, DriveContextData[]>,
): Promise<void> {
  await IOUtils.writeUTF8(driveContextFilePath(), JSON.stringify(all));
}

export function driveFileMetadata(
  data: DriveContextData,
): ContextItem["metadata"] {
  return {
    provider: data.provider,
    providerIcon: data.icon,
    driveFileId: data.driveFileId,
    mimeType: data.mimeType,
    filename: data.name,
    filePath: `drive://${data.driveFileId}`,
    fileCategory: "drive",
    fileSize: data.extractedContent.length,
    extractedContent: data.extractedContent,
    charCount: data.extractedContent.length,
    estimatedTokens: Math.ceil(data.extractedContent.length / 4),
    lastKnownModifiedTime: data.lastKnownModifiedTime,
  };
}

export function persistDriveContext(
  chatId: string,
  data: DriveContextData,
): void {
  readDriveContext()
    .then((all) => {
      if (!all[chatId]) all[chatId] = [];
      const existing = all[chatId].findIndex(
        (c: DriveContextData) =>
          c.driveFileId === data.driveFileId && c.provider === data.provider,
      );
      if (existing >= 0) {
        all[chatId][existing] = data;
      } else {
        all[chatId].push(data);
      }
      return writeDriveContext(all);
    })
    .catch((e) => Zotero.debug(`[seerai] Drive: persist error: ${e}`));
}

export async function loadDriveContextForChat(chatId: string): Promise<void> {
  try {
    const all = await readDriveContext();
    const items: DriveContextData[] = all[chatId] || [];
    const contextManager = ChatContextManager.getInstance();
    for (const item of items) {
      contextManager.addItem(
        item.driveFileId,
        "file" as ContextItemType,
        item.name,
        "toolbar",
        driveFileMetadata(item),
      );
    }
  } catch (e) {
    Zotero.debug(`[seerai] Drive: load context error: ${e}`);
  }
}

export async function inheritDriveContext(
  fromChatId: string,
  toChatId: string,
): Promise<void> {
  try {
    const all = await readDriveContext();
    if (all[fromChatId]) {
      all[toChatId] = JSON.parse(JSON.stringify(all[fromChatId]));
      await writeDriveContext(all);
    }
  } catch (e) {
    Zotero.debug(`[seerai] Drive: inherit context error: ${e}`);
  }
}

export async function clearDriveContextForChat(chatId: string): Promise<void> {
  try {
    const all = await readDriveContext();
    delete all[chatId];
    await writeDriveContext(all);
  } catch (e) {
    Zotero.debug(`[seerai] Drive: clear context error: ${e}`);
  }
}

export async function removeDriveContextFileItem(
  chatId: string,
  driveFileId: string,
  provider: string = "google",
): Promise<void> {
  try {
    const all = await readDriveContext();
    const items = all[chatId];
    if (items) {
      all[chatId] = items.filter(
        (c) => !(c.driveFileId === driveFileId && c.provider === provider),
      );
      await writeDriveContext(all);
    }
  } catch (e) {
    Zotero.debug(`[seerai] Drive: remove context file item error: ${e}`);
  }
}

export async function inheritAndLoadDriveContext(
  fromChatId: string,
  toChatId: string,
): Promise<void> {
  await inheritDriveContext(fromChatId, toChatId);
  await loadDriveContextForChat(toChatId);
}

export async function refreshDriveContextForChat(
  chatId: string,
): Promise<void> {
  try {
    const all = await readDriveContext();
    const items = all[chatId];
    if (!items || items.length === 0) return;

    let changed = false;
    const manager = CloudProviderManager.getInstance();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const provider = manager.get(item.provider || "google");
        if (!provider) continue;

        const meta = await provider.getFileMetadata(item.driveFileId);
        const driveTime = new Date(meta.modifiedTime).getTime();
        const cachedTime = new Date(item.lastKnownModifiedTime).getTime();

        if (driveTime > cachedTime) {
          Zotero.debug(
            `[seerai] Drive: refreshing "${item.name}" (${item.driveFileId})`,
          );
          const result = await provider.getFileTextContent({
            id: item.driveFileId,
            mimeType: item.mimeType,
            name: item.name,
            modifiedTime: meta.modifiedTime,
            isFolder: false,
          });
          if (result) {
            items[i].extractedContent = stripBase64Data(result.content);
            items[i].lastKnownModifiedTime = meta.modifiedTime;
            changed = true;
          }
        }
      } catch (e) {
        Zotero.debug(`[seerai] Drive: refresh error for "${item.name}": ${e}`);
      }
    }

    if (changed) {
      all[chatId] = items;
      await writeDriveContext(all);

      const contextManager = ChatContextManager.getInstance();
      const currentItems = contextManager.getItems();
      for (const item of items) {
        const idx = currentItems.findIndex(
          (ci) =>
            ci.type === "file" &&
            ci.metadata?.driveFileId === item.driveFileId &&
            ci.metadata?.provider === item.provider,
        );
        if (idx >= 0) {
          contextManager.removeItem(
            item.driveFileId,
            "file" as ContextItemType,
          );
          contextManager.addItem(
            item.driveFileId,
            "file" as ContextItemType,
            item.name,
            "toolbar",
            driveFileMetadata(item),
          );
        }
      }
    }
  } catch (e) {
    Zotero.debug(`[seerai] Drive: refresh context error: ${e}`);
  }
}
