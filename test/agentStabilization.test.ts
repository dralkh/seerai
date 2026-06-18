import { assert } from "chai";
import { getAgentModelCapabilities, ToolCall } from "../src/modules/openai";
import { validateToolCallIntake } from "../src/modules/chat/agenticChat";

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
});
