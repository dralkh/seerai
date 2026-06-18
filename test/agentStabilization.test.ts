import { assert } from "chai";
import { getAgentModelCapabilities, ToolCall } from "../src/modules/openai";
import {
  createToolDisplay,
  validateToolCallIntake,
} from "../src/modules/chat/agenticChat";

function toolCall(name: string, args: string, id = "call_1"): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: args,
    },
  };
}

describe("Agent stabilization", function () {
  it("rejects malformed tool-call JSON before execution", function () {
    const result = validateToolCallIntake(
      [toolCall("search_library", '{"query":"cancer"} trailing')],
      ["search_library"],
    );

    assert.isFalse(result.ok);
    assert.include(result.error || "", "invalid JSON");
    assert.deepEqual(result.validToolCalls, []);
  });

  it("normalizes empty argument strings for no-argument tools", function () {
    const result = validateToolCallIntake(
      [toolCall("check_environment", "")],
      ["check_environment"],
    );

    assert.isTrue(result.ok);
    assert.equal(result.validToolCalls[0].function.arguments, "{}");
  });

  it("rejects unknown tool names", function () {
    const result = validateToolCallIntake(
      [toolCall("made_up_tool", "{}")],
      ["search_library"],
    );

    assert.isFalse(result.ok);
    assert.include(result.error || "", "Unknown tool");
  });

  it("marks DeepSeek reasoning models as incompatible with tools", function () {
    const capabilities = getAgentModelCapabilities(
      "https://api.deepseek.com",
      "deepseek-reasoner",
    );

    assert.isFalse(capabilities.supportsTools);
    assert.include(
      capabilities.knownIncompatibleReason || "",
      "does not support function/tool calling",
    );
  });

  it("formats compact tool display metadata", function () {
    const display = createToolDisplay(
      toolCall("workspace_write_file", '{"path":"reports/brief.md"}'),
      {
        success: true,
        data: { path: "reports/brief.md" },
      },
    );

    assert.equal(display.title, "Wrote file");
    assert.equal(display.target, "reports/brief.md");
    assert.equal(display.summary, "Saved reports/brief.md");
    assert.equal(display.status, "success");
  });

  it("formats failed tool display metadata", function () {
    const display = createToolDisplay(
      toolCall("search_library", '{"query":"AI screening"}'),
      {
        success: false,
        error: "Provider unavailable",
      },
    );

    assert.equal(display.title, "Searched Zotero library");
    assert.equal(display.target, "AI screening");
    assert.equal(display.summary, "Provider unavailable");
    assert.equal(display.status, "error");
  });
});
