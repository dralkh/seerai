/**
 * Persistent message storage for AI Chat conversations
 */

import { config } from "../../../package.json";
import {
  ChatMessage,
  ChatStates,
  ChatOptions,
  ConversationMetadata,
} from "./types";

/**
 * Message store interface
 */
export abstract class MessageStore {
  // Session management
  abstract setConversationId(id: string): void;
  abstract getConversationId(): string;

  // Data operations
  abstract loadMessages(): Promise<ChatMessage[]>;
  abstract appendMessage(message: ChatMessage): Promise<void>;
  abstract modifyMessage(
    messageIndex: number,
    updatedMessage: ChatMessage,
    trim?: boolean,
  ): Promise<void>;
  abstract clearMessages(): Promise<void>;
  abstract getConversationState(): Promise<{
    states?: ChatStates;
    options?: ChatOptions;
  } | null>;
  abstract saveConversationState(
    states: ChatStates,
    options: ChatOptions,
  ): Promise<void>;

  // History management
  abstract getHistory(): Promise<ConversationMetadata[]>;
  abstract deleteConversation(id: string): Promise<void>;
  abstract updateConversationMetadata(
    metadata: Partial<ConversationMetadata>,
  ): Promise<void>;
}

/**
 * File-based message store using Zotero data directory
 */
export class FileMessageStore extends MessageStore {
  private dataDir: string;
  private conversationsDir: string;
  private historyFile: string;
  private currentConversationId: string = "default";

  constructor() {
    super();
    this.dataDir = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
    this.conversationsDir = PathUtils.join(this.dataDir, "conversations");
    this.historyFile = PathUtils.join(this.dataDir, "history_index.json");
  }

  private get messagesFile(): string {
    return PathUtils.join(
      this.conversationsDir,
      this.currentConversationId,
      "messages.jsonl",
    );
  }

  private get stateFile(): string {
    return PathUtils.join(
      this.conversationsDir,
      this.currentConversationId,
      "state.json",
    );
  }

  public setConversationId(id: string): void {
    this.currentConversationId = id;
  }

  public getConversationId(): string {
    return this.currentConversationId;
  }

  private async ensureDirectory(dir: string): Promise<void> {
    try {
      if (!(await IOUtils.exists(dir))) {
        await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error creating directory ${dir}: ${e}`);
    }
  }

  /**
   * Migration from legacy single-file storage
   */
  private async migrateLegacyStorage(): Promise<void> {
    try {
      const legacyMessages = PathUtils.join(this.dataDir, "messages.jsonl");
      const legacyState = PathUtils.join(
        this.dataDir,
        "conversation_state.json",
      );

      if (await IOUtils.exists(legacyMessages)) {
        Zotero.debug(`[seerai] Legacy messages found, migrating...`);
        await this.ensureDirectory(this.conversationsDir);
        const defaultDir = PathUtils.join(this.conversationsDir, "default");
        await this.ensureDirectory(defaultDir);

        await IOUtils.move(
          legacyMessages,
          PathUtils.join(defaultDir, "messages.jsonl"),
        );
        if (await IOUtils.exists(legacyState)) {
          await IOUtils.move(
            legacyState,
            PathUtils.join(defaultDir, "state.json"),
          );
        }

        // Create initial history index
        const history: ConversationMetadata[] = [
          {
            id: "default",
            title: "Previous Chat",
            createdAt: new Date(),
            updatedAt: new Date(),
            messageCount: 0,
            preview: "Migrated from legacy storage",
          },
        ];
        await this.saveHistory(history);
        Zotero.debug(`[seerai] Migration completed`);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error during migration: ${e}`);
    }
  }

  /**
   * Load all messages from JSONL file
   */
  public async loadMessages(): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];

    try {
      await this.migrateLegacyStorage(); // Migration check on first load
      const convDir = PathUtils.join(
        this.conversationsDir,
        this.currentConversationId,
      );
      await this.ensureDirectory(convDir);

      if (!(await IOUtils.exists(this.messagesFile))) {
        return messages;
      }

      const contentBytes = await IOUtils.read(this.messagesFile);
      const content = new TextDecoder().decode(contentBytes);
      if (!content) return messages;

      const lines = content.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line.trim());
            msg.timestamp = new Date(msg.timestamp);
            messages.push(msg);
          } catch (parseError) {
            Zotero.debug(`[seerai] Error parsing message line: ${parseError}`);
          }
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error loading messages: ${e}`);
    }

    return messages;
  }

  /**
   * Append a single message to the file
   */
  public async appendMessage(message: ChatMessage): Promise<void> {
    try {
      const convDir = PathUtils.join(
        this.conversationsDir,
        this.currentConversationId,
      );
      await this.ensureDirectory(convDir);

      const messageLine = JSON.stringify(message) + "\n";
      const encoder = new TextEncoder();

      if (await IOUtils.exists(this.messagesFile)) {
        const existingBytes = await IOUtils.read(this.messagesFile);
        const existingContent = new TextDecoder().decode(existingBytes);
        await IOUtils.write(
          this.messagesFile,
          encoder.encode(existingContent + messageLine),
        );
      } else {
        await IOUtils.write(this.messagesFile, encoder.encode(messageLine));
      }

      // Update history index preview and updatedAt
      await this.updateHistoryFromMessage(message);
    } catch (e) {
      Zotero.debug(`[seerai] Error appending message: ${e}`);
    }
  }

  /**
   * Modify an existing message
   */
  public async modifyMessage(
    messageIndex: number,
    updatedMessage: ChatMessage,
    trim: boolean = false,
  ): Promise<void> {
    try {
      const messages = await this.loadMessages();

      if (messageIndex >= 0 && messageIndex < messages.length) {
        messages[messageIndex] = updatedMessage;
      }

      const finalMessages = trim
        ? messages.slice(0, messageIndex + 1)
        : messages;
      const content =
        finalMessages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      const encoder = new TextEncoder();
      await IOUtils.write(this.messagesFile, encoder.encode(content));

      // If it's the last message, update preview
      if (messageIndex === finalMessages.length - 1) {
        await this.updateHistoryFromMessage(updatedMessage);
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error modifying message: ${e}`);
    }
  }

  /**
   * Clear all messages for the current conversation
   */
  public async clearMessages(): Promise<void> {
    try {
      const convDir = PathUtils.join(
        this.conversationsDir,
        this.currentConversationId,
      );
      await this.ensureDirectory(convDir);
      const encoder = new TextEncoder();
      await IOUtils.write(this.messagesFile, encoder.encode(""));
      await IOUtils.write(this.stateFile, encoder.encode(""));
    } catch (e) {
      Zotero.debug(`[seerai] Error clearing messages: ${e}`);
    }
  }

  /**
   * Get saved conversation state
   */
  public async getConversationState(): Promise<{
    states?: ChatStates;
    options?: ChatOptions;
  } | null> {
    try {
      if (!(await IOUtils.exists(this.stateFile))) {
        return null;
      }

      const contentBytes = await IOUtils.read(this.stateFile);
      const content = new TextDecoder().decode(contentBytes);
      if (!content) return null;

      return JSON.parse(content);
    } catch (e) {
      Zotero.debug(`[seerai] Error loading conversation state: ${e}`);
      return null;
    }
  }

  /**
   * Save conversation state
   */
  public async saveConversationState(
    states: ChatStates,
    options: ChatOptions,
  ): Promise<void> {
    try {
      const convDir = PathUtils.join(
        this.conversationsDir,
        this.currentConversationId,
      );
      await this.ensureDirectory(convDir);
      const stateData = { states, options, savedAt: new Date().toISOString() };
      const encoder = new TextEncoder();
      await IOUtils.write(
        this.stateFile,
        encoder.encode(JSON.stringify(stateData, null, 2)),
      );
    } catch (e) {
      Zotero.debug(`[seerai] Error saving conversation state: ${e}`);
    }
  }

  /**
   * History management
   */
  public async getHistory(): Promise<ConversationMetadata[]> {
    try {
      if (!(await IOUtils.exists(this.historyFile))) {
        return [];
      }
      const contentBytes = await IOUtils.read(this.historyFile);
      const content = new TextDecoder().decode(contentBytes);
      const history = JSON.parse(content);
      // Sort by updatedAt descending
      return history.sort(
        (a: any, b: any) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    } catch (e) {
      Zotero.debug(`[seerai] Error loading history index: ${e}`);
      return [];
    }
  }

  private async saveHistory(history: ConversationMetadata[]): Promise<void> {
    try {
      await this.ensureDirectory(this.dataDir);
      const encoder = new TextEncoder();
      await IOUtils.write(
        this.historyFile,
        encoder.encode(JSON.stringify(history, null, 2)),
      );
    } catch (e) {
      Zotero.debug(`[seerai] Error saving history index: ${e}`);
    }
  }

  public async deleteConversation(id: string): Promise<void> {
    try {
      const history = await this.getHistory();
      const updatedHistory = history.filter((h) => h.id !== id);
      await this.saveHistory(updatedHistory);

      const convDir = PathUtils.join(this.conversationsDir, id);
      if (await IOUtils.exists(convDir)) {
        // IOUtils.remove is recursive if no options passed in Zotero?
        // Let's assume we need to remove files first or check if remove works for dirs.
        // In Zotero 7/Firefox, IOUtils.remove(path, {recursive: true})
        await (IOUtils as any).remove(convDir, { recursive: true });
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error deleting conversation ${id}: ${e}`);
    }
  }

  public async updateConversationMetadata(
    metadata: Partial<ConversationMetadata>,
  ): Promise<void> {
    try {
      const history = await this.getHistory();
      const idx = history.findIndex(
        (h) => h.id === (metadata.id || this.currentConversationId),
      );

      if (idx !== -1) {
        history[idx] = { ...history[idx], ...metadata, updatedAt: new Date() };
      } else {
        // New entry
        history.push({
          id: this.currentConversationId,
          title: "New Chat",
          createdAt: new Date(),
          updatedAt: new Date(),
          messageCount: 1,
          preview: "",
          ...metadata,
        });
      }
      await this.saveHistory(history);
    } catch (e) {
      Zotero.debug(`[seerai] Error updating conversation metadata: ${e}`);
    }
  }

  private async updateHistoryFromMessage(message: ChatMessage): Promise<void> {
    if (message.role === "system") return;

    await this.updateConversationMetadata({
      preview:
        message.content.slice(0, 100).replace(/\n/g, " ") +
        (message.content.length > 100 ? "..." : ""),
    });
  }
}

// Singleton instance
let messageStoreInstance: FileMessageStore | null = null;

export function getMessageStore(): FileMessageStore {
  if (!messageStoreInstance) {
    messageStoreInstance = new FileMessageStore();
  }
  return messageStoreInstance;
}

export function resetMessageStore(): void {
  messageStoreInstance = null;
}
