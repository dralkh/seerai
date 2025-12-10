/**
 * Persistent message storage for AI Chat conversations
 */

import { config } from "../../../package.json";
import { ChatMessage, ChatStates, ChatOptions } from "./types";

/**
 * Message store interface
 */
export abstract class MessageStore {
    abstract loadMessages(): Promise<ChatMessage[]>;
    abstract appendMessage(message: ChatMessage): Promise<void>;
    abstract modifyMessage(messageIndex: number, updatedMessage: ChatMessage, trim?: boolean): Promise<void>;
    abstract clearMessages(): Promise<void>;
    abstract getConversationState(): Promise<{ states?: ChatStates; options?: ChatOptions } | null>;
    abstract saveConversationState(states: ChatStates, options: ChatOptions): Promise<void>;
}

/**
 * File-based message store using Zotero data directory
 */
export class FileMessageStore extends MessageStore {
    private messagesFile: string;
    private stateFile: string;
    private dataDir: string;

    constructor() {
        super();
        this.dataDir = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
        this.messagesFile = PathUtils.join(this.dataDir, "messages.jsonl");
        this.stateFile = PathUtils.join(this.dataDir, "conversation_state.json");
    }

    private async ensureDirectory(): Promise<void> {
        try {
            // Check if directory exists using IOUtils
            if (!(await IOUtils.exists(this.dataDir))) {
                await IOUtils.makeDirectory(this.dataDir, { ignoreExisting: true });
            }
        } catch (e) {
            Zotero.debug(`[Seer AI] Error creating directory: ${e}`);
        }
    }

    /**
     * Load all messages from JSONL file
     */
    public async loadMessages(): Promise<ChatMessage[]> {
        const messages: ChatMessage[] = [];

        try {
            await this.ensureDirectory();

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
                        // Convert timestamp string back to Date
                        msg.timestamp = new Date(msg.timestamp);
                        messages.push(msg);
                    } catch (parseError) {
                        Zotero.debug(`[Seer AI] Error parsing message line: ${parseError}`);
                    }
                }
            }
        } catch (e) {
            Zotero.debug(`[Seer AI] Error loading messages: ${e}`);
        }

        return messages;
    }

    /**
     * Append a single message to the file
     */
    public async appendMessage(message: ChatMessage): Promise<void> {
        try {
            await this.ensureDirectory();
            const messageLine = JSON.stringify(message) + "\n";
            const encoder = new TextEncoder();

            // Append to file
            if (await IOUtils.exists(this.messagesFile)) {
                const existingBytes = await IOUtils.read(this.messagesFile);
                const existingContent = new TextDecoder().decode(existingBytes);
                await IOUtils.write(this.messagesFile, encoder.encode(existingContent + messageLine));
            } else {
                await IOUtils.write(this.messagesFile, encoder.encode(messageLine));
            }
        } catch (e) {
            Zotero.debug(`[Seer AI] Error appending message: ${e}`);
        }
    }

    /**
     * Modify an existing message (used for streaming updates)
     */
    public async modifyMessage(messageIndex: number, updatedMessage: ChatMessage, trim: boolean = false): Promise<void> {
        try {
            const messages = await this.loadMessages();

            if (messageIndex >= 0 && messageIndex < messages.length) {
                messages[messageIndex] = updatedMessage;
            }

            // If trimming, remove all messages after this index
            const finalMessages = trim ? messages.slice(0, messageIndex + 1) : messages;

            // Rewrite the entire file
            const content = finalMessages.map(m => JSON.stringify(m)).join("\n") + "\n";
            const encoder = new TextEncoder();
            await IOUtils.write(this.messagesFile, encoder.encode(content));
        } catch (e) {
            Zotero.debug(`[Seer AI] Error modifying message: ${e}`);
        }
    }

    /**
     * Clear all messages
     */
    public async clearMessages(): Promise<void> {
        try {
            await this.ensureDirectory();
            const encoder = new TextEncoder();
            await IOUtils.write(this.messagesFile, encoder.encode(""));
            await IOUtils.write(this.stateFile, encoder.encode(""));
        } catch (e) {
            Zotero.debug(`[Seer AI] Error clearing messages: ${e}`);
        }
    }

    /**
     * Get saved conversation state (selections + options)
     */
    public async getConversationState(): Promise<{ states?: ChatStates; options?: ChatOptions } | null> {
        try {
            await this.ensureDirectory();

            if (!(await IOUtils.exists(this.stateFile))) {
                return null;
            }

            const contentBytes = await IOUtils.read(this.stateFile);
            const content = new TextDecoder().decode(contentBytes);
            if (!content) return null;

            return JSON.parse(content);
        } catch (e) {
            Zotero.debug(`[Seer AI] Error loading conversation state: ${e}`);
            return null;
        }
    }

    /**
     * Save conversation state
     */
    public async saveConversationState(states: ChatStates, options: ChatOptions): Promise<void> {
        try {
            await this.ensureDirectory();
            const stateData = { states, options, savedAt: new Date().toISOString() };
            const encoder = new TextEncoder();
            await IOUtils.write(this.stateFile, encoder.encode(JSON.stringify(stateData, null, 2)));
        } catch (e) {
            Zotero.debug(`[Seer AI] Error saving conversation state: ${e}`);
        }
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
