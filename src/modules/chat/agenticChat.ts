/**
 * Agentic Chat Handler
 * Manages the agentic chat loop with tool calling support
 * 
 * @see agentic.md Section 2.1 - ARTIST Framework (Reasoning-Action loops)
 * @see agentic.md Section 7.1 - Observability and Tracing
 */

import {
    OpenAIMessage,
    VisionMessage,
    VisionMessageContentPart,
    ToolCall,
    ToolCallMessage,
    ToolResultMessage,
    ToolDefinition,
    openAIService
} from "../openai";
import {
    getAgentTools,
    executeToolCall,
    formatToolResult,
    getAgentConfigFromPrefs,
    AgentConfig,
    ToolResult
} from "./tools";
import { ChatMessage } from "./types";
import { parseMarkdown } from "./markdown";
import { getActiveModelConfig } from "./modelConfig";
import { agentTracer } from "./tracer";

/**
 * Options for the agentic chat
 */
export interface AgenticChatOptions {
    /** Enable tool calling */
    enableTools: boolean;
    /** Include images in the request */
    includeImages: boolean;
    /** Pasted images to include */
    pastedImages?: { id: string; image: string; mimeType: string }[];
    /** Handler for inline permission requests */
    permissionHandler?: (toolCallId: string, toolName: string) => Promise<boolean>;
}

/**
 * Create a container for tool execution process
 */
export function createToolProcessUI(doc: Document): {
    container: HTMLElement;
    setThinking: () => void;
    setExecutingTool: (toolName: string) => void;
    setCompleted: (count: number) => void;
    setFailed: (error: string) => void;
} {
    const details = doc.createElement("details");
    details.className = "tool-process-container";

    // Initially hidden (collapsed)
    details.open = false;

    details.style.cssText = `
        margin: 8px 0;
        border: 1px solid var(--border-secondary, #e0e0e0);
        border-radius: 8px;
        background: var(--background-primary, #fff);
        overflow: hidden;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    `;

    const summary = doc.createElement("summary");
    summary.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary, #666);
        list-style: none;
        user-select: none;
        transition: background 0.2s;
    `;

    // Hover effect
    summary.onmouseover = () => { summary.style.background = "var(--fill-quinary, rgba(0,0,0,0.02))"; };
    summary.onmouseout = () => { summary.style.background = "transparent"; };

    // Icon
    const icon = doc.createElement("span");
    icon.textContent = "🧠"; // Brain icon for process
    icon.style.filter = "grayscale(100%) opacity(0.7)";
    summary.appendChild(icon);

    // Text Label
    const label = doc.createElement("span");
    label.textContent = "Thinking...";
    label.style.flex = "1";
    summary.appendChild(label);

    // Expand All Button
    const expandBtn = doc.createElement("span");
    expandBtn.textContent = "⤢"; // Open symbol
    expandBtn.title = "Expand All Steps";
    expandBtn.style.cssText = `
        padding: 2px 6px;
        margin-right: 8px;
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-tertiary, #999);
        cursor: pointer;
        opacity: 0.7;
    `;
    expandBtn.onmouseover = () => { expandBtn.style.backgroundColor = "var(--fill-quaternary, rgba(0,0,0,0.1))"; };
    expandBtn.onmouseout = () => { expandBtn.style.backgroundColor = "transparent"; };

    expandBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Open parent
        details.open = true;

        // Open all children
        const childDetails = details.querySelectorAll("details.tool-execution-card");
        childDetails.forEach((cd: Element) => {
            (cd as HTMLDetailsElement).open = true;
        });
    };
    summary.appendChild(expandBtn);

    // Chevron
    const chevron = doc.createElement("span");
    chevron.innerHTML = `<svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    chevron.style.color = "var(--text-tertiary, #999)";
    chevron.style.transition = "transform 0.2s ease";
    chevron.style.transform = "rotate(-90deg)"; // Initial closed state
    summary.appendChild(chevron);

    details.addEventListener("toggle", () => {
        chevron.style.transform = details.open ? "rotate(0deg)" : "rotate(-90deg)";
    });

    details.appendChild(summary);

    // Container for card list
    const listContainer = doc.createElement("div");
    listContainer.className = "tool-list-container";
    listContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px;
        background: var(--fill-quinary, rgba(0,0,0,0.02));
        border-top: 1px solid var(--border-secondary, #e0e0e0);
    `;
    details.appendChild(listContainer);

    // State helpers
    const setThinking = () => {
        label.textContent = "Processing task...";
        icon.textContent = "⚡";
        icon.style.animation = "pulse 1.5s infinite";
        // Only close if we haven't started any tools yet
        if (!listContainer.firstChild) {
            details.open = false;
        }
    };

    const setExecutingTool = (toolName: string) => {
        const displayName = toolName.replace(/_/g, " ");
        label.textContent = `Calling ${displayName}...`;
        icon.textContent = "🔧";
        icon.style.filter = "none";
        icon.style.animation = "pulse 1s infinite";
        details.open = true; // Auto-expand when a tool is being called for visibility
    };

    const setCompleted = (count: number) => {
        label.textContent = `Completed ${count} step${count !== 1 ? 's' : ''}`;
        icon.textContent = "✓";
        icon.style.filter = "none";
        icon.style.color = "var(--accent-green, #34C759)";
        icon.style.animation = "none";
        // Keep current open state
    };

    const setFailed = (error: string) => {
        label.textContent = `Failed: ${error}`;
        label.style.color = "var(--accent-red, #FF3B30)";
        icon.textContent = "✗";
        icon.style.filter = "none";
        icon.style.color = "var(--accent-red, #FF3B30)";
        icon.style.animation = "none";
        details.open = true; // Auto-expand on failure
    };

    return { container: details, setThinking, setExecutingTool, setCompleted, setFailed };
}

/**
 * Create a tool execution UI element
 */
export function createToolExecutionUI(
    doc: Document,
    toolCall: ToolCall,
    result?: ToolResult
): HTMLElement {
    const details = doc.createElement("details");
    details.className = "tool-execution-card";
    details.setAttribute("data-tool-id", toolCall.id);

    // Auto-expand if it failed
    if (result && !result.success) {
        details.open = true;
    }

    details.style.cssText = `
        border: 1px solid var(--border-secondary, #e0e0e0);
        border-radius: 6px;
        background: var(--background-primary, #fff);
        overflow: hidden;
    `;

    // Summary (Header)
    const summary = doc.createElement("summary");
    summary.style.cssText = `
        padding: 6px 10px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        font-weight: 500;
        font-weight: 500;
        color: var(--text-primary);
        list-style: none; /* Hide default triangle */
        user-select: none;
        background: var(--fill-quinary, rgba(0, 0, 0, 0.02));
        transition: background 0.15s;
    `;

    summary.onmouseover = () => { summary.style.background = "var(--fill-quaternary, rgba(0,0,0,0.05))"; };
    summary.onmouseout = () => { summary.style.background = "var(--fill-quinary, rgba(0,0,0,0.02))"; };

    // Status Icon
    const statusSpan = doc.createElement("span");
    statusSpan.style.display = "flex";
    statusSpan.style.alignItems = "center";
    statusSpan.style.justifyContent = "center";
    statusSpan.style.width = "14px";

    if (!result) {
        statusSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" class="spin" xmlns="http://www.w3.org/2000/svg"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="var(--accent-blue, #007AFF)" stroke-width="3" stroke-linecap="round" stroke-dasharray="60" stroke-dashoffset="20"></path></svg>`;
        // Add rotation animation style is expected to be global or inline
    } else if (result.success) {
        statusSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17L4 12" stroke="var(--accent-green, #34C759)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    } else {
        statusSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6L18 18" stroke="var(--accent-red, #FF3B30)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    summary.appendChild(statusSpan);

    // Tool Name
    const nameSpan = doc.createElement("span");
    nameSpan.textContent = toolCall.function.name.replace(/_/g, " ");
    nameSpan.style.textTransform = "capitalize";
    nameSpan.style.flex = "1";
    summary.appendChild(nameSpan);

    // Chevron (Visual indicator for open/closed)
    const chevron = doc.createElement("span");
    chevron.innerHTML = `<svg width="8" height="5" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    chevron.style.opacity = "0.4";
    chevron.style.transform = details.open ? "rotate(0deg)" : "rotate(-90deg)"; // Initial state
    chevron.style.transition = "transform 0.2s";
    summary.appendChild(chevron);

    // Update chevron on toggle
    details.addEventListener("toggle", () => {
        chevron.style.transform = details.open ? "rotate(0deg)" : "rotate(-90deg)";
    });

    details.appendChild(summary);

    // Content (Arguments & Results)
    const content = doc.createElement("div");
    content.className = "tool-details-content";
    content.style.cssText = `
        padding: 10px;
        border-top: 1px solid var(--border-secondary, #e0e0e0);
        font-size: 11px;
        font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
        line-height: 1.4;
        background: var(--background-primary, #fff);
        color: var(--text-primary, #333);
        overflow-x: auto;
    `;

    // Arguments
    try {
        const argsLabel = doc.createElement("div");
        argsLabel.textContent = "INPUT";
        argsLabel.style.cssText = "font-size: 10px; font-weight: 700; color: var(--text-tertiary, #8e8e93); margin-bottom: 4px; letter-spacing: 0.5px;";
        content.appendChild(argsLabel);

        const args = JSON.parse(toolCall.function.arguments);
        const argsPre = doc.createElement("div");
        argsPre.textContent = JSON.stringify(args, null, 2);
        argsPre.style.whiteSpace = "pre-wrap";
        argsPre.style.color = "var(--text-primary)";
        content.appendChild(argsPre);
    } catch (e) {
        content.textContent = "Error parsing arguments";
    }

    // Result
    if (result) {
        const resLabel = doc.createElement("div");
        resLabel.textContent = "OUTPUT";
        resLabel.style.cssText = "font-size: 10px; font-weight: 700; color: var(--text-tertiary, #8e8e93); margin: 12px 0 4px 0; letter-spacing: 0.5px;";
        content.appendChild(resLabel);

        const resDiv = doc.createElement("div");
        resDiv.style.whiteSpace = "pre-wrap";

        if (result.success) {
            // Check if data is complex object or simple text
            if (result.data) {
                resDiv.textContent = JSON.stringify(result.data, null, 2);
                resDiv.style.color = "var(--text-primary)";
                // Truncate if extremely long
                if (resDiv.textContent.length > 2000) {
                    resDiv.textContent = resDiv.textContent.slice(0, 2000) + "... (truncated)";
                }
            } else {
                resDiv.textContent = result.summary || "Success";
                resDiv.style.color = "var(--text-secondary, #666)";
            }
        } else {
            resDiv.textContent = result.error || "Unknown Error";
            resDiv.style.color = "var(--accent-red, #FF3B30)";
            resDiv.style.background = "var(--bg-error-light, rgba(255, 59, 48, 0.1))";
            resDiv.style.padding = "4px";
            resDiv.style.borderRadius = "4px";
        }
        content.appendChild(resDiv);
    }

    details.appendChild(content);

    return details;
}

/**
 * Observer for agent UI updates
 */
export interface AgentUIObserver {
    onToken: (token: string, fullResponse: string) => void;
    onToolCallStarted: (toolCall: ToolCall) => void;
    onToolCallCompleted: (toolCall: ToolCall, result: ToolResult) => void;
    onMessageUpdate: (content: string) => void;
    onComplete: (content: string) => void;
    onError: (error: Error) => void;
    onIterationStarted?: (iteration: number) => void;
}

/**
 * Agentic chat handler with tool calling loop
 */
export async function handleAgenticChat(
    text: string,
    systemPrompt: string,
    conversationHistory: ChatMessage[],
    options: AgenticChatOptions,
    observer: AgentUIObserver
): Promise<void> {
    const agentConfig = {
        ...getAgentConfigFromPrefs(),
        permissionHandler: options.permissionHandler
    };

    // Get tools if enabled
    const tools: ToolDefinition[] | undefined = options.enableTools
        ? getAgentTools()
        : undefined;

    // Build initial messages
    let messages: (OpenAIMessage | VisionMessage | ToolCallMessage | ToolResultMessage)[] = [
        { role: "system", content: systemPrompt },
        ...conversationHistory
            .filter(m => m.role !== "system" && m.role !== "error")
            .map(m => ({
                role: m.role as "user" | "assistant",
                content: m.content,
            })),
    ];

    // Add current user message with images if applicable
    if (options.pastedImages && options.pastedImages.length > 0) {
        const imageParts: VisionMessageContentPart[] = options.pastedImages.map(img => ({
            type: "image_url",
            image_url: {
                url: img.image,
                detail: "auto" as const,
            },
        }));

        messages.push({
            role: "user",
            content: [
                { type: "text", text },
                ...imageParts,
            ],
        });
    } else {
        messages.push({ role: "user", content: text });
    }

    // Get model config
    const activeModel = getActiveModelConfig();
    const configOverride = activeModel ? {
        apiURL: activeModel.apiURL,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
    } : undefined;

    let fullResponse = "";
    let iteration = 0;
    let isFirstToken = true;

    // Start tracing session (agentic.md Section 7.1)
    const sessionId = `agent_${Date.now()}`;
    agentTracer.startSession(sessionId);

    // Agent loop
    while (iteration < agentConfig.maxAgentIterations) {
        // Check for abortion at the start of iteration
        if (openAIService.isAbortedState()) {
            Zotero.debug("[seerai] Agent loop aborted at start of iteration");
            throw new Error("Request was cancelled");
        }

        iteration++;
        Zotero.debug(`[seerai] Agent iteration ${iteration}`);
        agentTracer.startIteration(sessionId, iteration);

        // Notify observer that a new iteration (reasoning turn) has started
        // This allows resetting the UI status from "Calling Tool" back to "Thinking"
        observer.onIterationStarted?.(iteration);

        let toolCallsReceived: ToolCall[] = [];
        let iterationContent = "";

        try {
            await openAIService.chatCompletionStream(
                messages,
                {
                    onToken: (token) => {
                        iterationContent += token;
                        fullResponse += token;

                        observer.onToken(token, fullResponse);
                    },
                    onToolCalls: (toolCalls) => {
                        Zotero.debug(`[seerai] Received ${toolCalls.length} tool call(s)`);
                        toolCallsReceived = toolCalls;
                    },
                    onComplete: (content) => {
                        Zotero.debug(`[seerai] Iteration ${iteration} complete, content length: ${content.length}`);
                    },
                    onError: (error) => {
                        throw error;
                    },
                },
                configOverride,
                tools
            );

            // If no tool calls, we're done
            if (toolCallsReceived.length === 0) {
                Zotero.debug(`[seerai] No tool calls, agent loop complete`);
                break;
            }

            // Add assistant message with tool calls to history
            const assistantToolMessage: ToolCallMessage = {
                role: "assistant",
                content: iterationContent || null,
                tool_calls: toolCallsReceived,
            };
            messages.push(assistantToolMessage);

            // Execute each tool call
            // Sequential execution to ensure permission dialogs work correctly and don't overlap
            const toolResults: { toolCall: ToolCall; result: ToolResult }[] = [];

            for (const toolCall of toolCallsReceived) {
                // Inform observer tool call started
                observer.onToolCallStarted(toolCall);

                // Start tool span for tracing
                const parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
                agentTracer.startToolSpan(
                    sessionId,
                    toolCall.id,
                    toolCall.function.name,
                    parsedArgs
                );

                // Execute the tool
                // This awaits the result, including any permission dialog interaction
                const result = await executeToolCall(toolCall, agentConfig);

                // End tool span with result
                agentTracer.endToolSpan(sessionId, toolCall.id, {
                    success: result.success,
                    error: result.error,
                    dataSummary: result.summary,
                });

                // Inform observer tool call completed
                observer.onToolCallCompleted(toolCall, result);

                toolResults.push({ toolCall, result });

                // Check for abortion after each tool execution
                if (openAIService.isAbortedState()) {
                    Zotero.debug("[seerai] Agent loop aborted after tool execution");
                    throw new Error("Request was cancelled");
                }
            }

            // Add results to history with enhanced error feedback (Reflexion pattern - agentic.md Section 2.1)
            for (const { toolCall, result } of toolResults) {
                let resultContent: string;

                if (!result.success && result.error) {
                    // Enhanced error feedback for self-correction
                    resultContent = JSON.stringify({
                        success: false,
                        error: result.error,
                        guidance: `The tool "${toolCall.function.name}" failed. ` +
                            `Please analyze the error message above and either: ` +
                            `(1) retry with corrected arguments, ` +
                            `(2) try a different approach, or ` +
                            `(3) inform the user if the operation is not possible.`,
                    });
                    Zotero.debug(`[seerai] Tool ${toolCall.function.name} failed, providing self-correction guidance`);
                } else {
                    resultContent = formatToolResult(toolCall.id, result);
                }

                const toolResultMessage: ToolResultMessage = {
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: resultContent,
                };
                messages.push(toolResultMessage);
            }

            // End iteration for tracing
            agentTracer.endIteration(sessionId);

        } catch (error) {
            agentTracer.endSession(sessionId, false);
            observer.onError(error as Error);
            throw error; // Re-throw to allow caller (Assistant) to handle it
        }
    }

    // If we reached the max iterations, inform the user
    if (iteration >= agentConfig.maxAgentIterations) {
        Zotero.debug(`[seerai] Agent reached max iterations (${agentConfig.maxAgentIterations})`);
        const stopMessage = `\n\n*[Agent stopped - reached maximum tool call iterations (${agentConfig.maxAgentIterations})]*`;
        fullResponse += stopMessage;
        observer.onMessageUpdate(fullResponse);
    }

    // End tracing session
    const trace = agentTracer.endSession(sessionId, true);
    if (trace) {
        Zotero.debug(`[seerai][trace] Summary: ${agentTracer.getExecutionSummary(trace)}`);
    }

    observer.onComplete(fullResponse);
}

/**
 * Check if agentic mode should be enabled based on preferences
 */
export function isAgenticModeEnabled(): boolean {
    try {
        const enabled = Zotero.Prefs.get("extensions.seerai.agenticMode");
        return enabled !== false; // Default to true if not set
    } catch (e) {
        return true;
    }
}
