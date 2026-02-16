/**
 * Tag Tool Implementation
 * Generates AI-powered tags for Zotero items
 */

import { GenerateItemTagsParams, ToolResult, AgentConfig } from "./toolTypes";
import { openAIService, OpenAIMessage, ToolDefinition } from "../../openai";
import { getActiveModelConfig } from "../modelConfig";

/**
 * Strip HTML tags from a string
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Execute generate_item_tags tool
 */
export async function executeGenerateItemTags(
  params: GenerateItemTagsParams,
  _config: AgentConfig,
): Promise<ToolResult> {
  try {
    const { item_id } = params;

    const item = Zotero.Items.get(item_id);
    if (!item) {
      return {
        success: false,
        error: `Item with ID ${item_id} not found`,
      };
    }

    Zotero.debug(`[seerai] Tool: generate_item_tags for item ${item_id}`);

    // Get source content (notes or PDF text)
    let sourceText = "";
    const noteIds = item.getNotes();

    if (noteIds.length > 0) {
      for (const noteId of noteIds) {
        const noteItem = Zotero.Items.get(noteId);
        if (noteItem) {
          const noteHTML = noteItem.getNote();
          sourceText += stripHtml(noteHTML) + "\n\n";
        }
      }
    } else {
      const attachments = item.getAttachments();
      for (const attId of attachments) {
        const att = Zotero.Items.get(attId);
        if (att && att.attachmentContentType === "application/pdf") {
          try {
            const path = await att.getFilePathAsync();
            if (!path) continue;
            const text = await Zotero.PDFWorker.getFullText(att.id, 10);
            const pdfText = text?.text || "";
            if (pdfText) {
              sourceText = pdfText.substring(0, 10000);
              break;
            }
          } catch (e) {
            Zotero.debug(`[seerai] Error extracting PDF text: ${e}`);
          }
        }
      }
    }

    const paperTitle = (item.getField("title") as string) || "Untitled";
    const abstract = (item.getField("abstractNote") as string) || "";
    const creators = item.getCreators();
    const authors = creators
      .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
      .join(", ");

    if (!sourceText.trim()) {
      sourceText = `Title: ${paperTitle}\nAuthors: ${authors}\nAbstract: ${abstract}`;
    }

    if (!sourceText.trim()) {
      return {
        success: false,
        error: "No content available to generate tags",
      };
    }

    // Define the tool for structured tag generation
    const tagGenerationTool: ToolDefinition = {
      type: "function",
      function: {
        name: "generate_tags",
        description: "Generate structured tags for an academic paper",
        parameters: {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  category: {
                    type: "string",
                    enum: [
                      "topic",
                      "methodology",
                      "domain",
                      "concept",
                      "application",
                    ],
                  },
                },
                required: ["name", "category"],
              },
            },
          },
          required: ["tags"],
        },
      },
    };

    const systemPrompt = `You are a research librarian tagging academic papers. Generate 3-7 precise tags.
RULES: Tags must be 1-3 words. Never include author names, locations, or partial sentences.
You MUST call the generate_tags function.`;

    const userPrompt = `Generate tags for: "${paperTitle}" by ${authors}\n\n${sourceText.substring(0, 6000)}`;

    const activeModel = getActiveModelConfig();
    if (!activeModel) {
      return { success: false, error: "No model configured" };
    }

    const messages: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let generatedTags: string[] = [];
    let functionCalled = false;

    await openAIService.chatCompletionStream(
      messages,
      {
        onToken: () => {},
        onComplete: () => {},
        onError: (err) => {
          throw err;
        },
        onToolCalls: (toolCalls) => {
          for (const tc of toolCalls) {
            if (tc.function.name === "generate_tags") {
              functionCalled = true;
              try {
                const args = JSON.parse(tc.function.arguments);
                if (args.tags && Array.isArray(args.tags)) {
                  generatedTags = args.tags
                    .map((t: { name: string }) => t.name?.trim())
                    .filter((t: string) => t && t.length > 0 && t.length < 40);
                }
              } catch (e) {
                Zotero.debug(`[seerai] Error parsing tags: ${e}`);
              }
            }
          }
        },
      },
      {
        apiURL: activeModel.apiURL,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
      },
      [tagGenerationTool],
    );

    if (!functionCalled || generatedTags.length === 0) {
      return { success: false, error: "No valid tags generated" };
    }

    // Apply tags to item
    for (const tag of generatedTags) {
      item.addTag(tag);
    }
    item.addTag("Seerai-Tagged");
    await item.saveTx();

    Zotero.debug(
      `[seerai] Generated tags for ${item_id}: ${generatedTags.join(", ")}`,
    );

    return {
      success: true,
      data: {
        item_id,
        tags: generatedTags,
        success: true,
      },
      summary: `Generated ${generatedTags.length} tags for "${paperTitle}": ${generatedTags.join(", ")}`,
    };
  } catch (error) {
    Zotero.debug(`[seerai] Tool: generate_item_tags error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
