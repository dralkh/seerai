import { assert } from "chai";
import { parseModelsResponse } from "../src/modules/chat/modelDiscovery";

describe("Model discovery", function () {
  it("parses OpenAI-compatible responses across all six model types", function () {
    const models = parseModelsResponse({
      data: [
        { id: "gpt-5-mini" },
        { id: "text-embedding-3-small" },
        { id: "gpt-image-1.5" },
        { id: "sora-2" },
        { id: "gpt-4o-mini-tts" },
        { id: "gpt-4o-mini-transcribe" },
      ],
    });
    assert.deepEqual(
      models.map((model) => model.capabilities?.[0]),
      ["chat", "embedding", "image", "video", "tts", "stt"],
    );
  });

  it("uses OpenRouter modality metadata instead of treating media as chat", function () {
    const models = parseModelsResponse({
      data: [
        {
          id: "vendor/render-model",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["image"],
          },
        },
        {
          id: "vendor/audio-reader",
          architecture: {
            input_modalities: ["audio"],
            output_modalities: ["text"],
          },
        },
      ],
    });
    assert.deepEqual(models[0].capabilities, ["image"]);
    assert.deepEqual(models[1].capabilities, ["stt"]);
  });

  it("parses array and vendor models response shapes", function () {
    assert.equal(
      parseModelsResponse([{ id: "array-model", type: "chat" }]).length,
      1,
    );
    assert.equal(
      parseModelsResponse({
        models: [{ name: "command", endpoints: ["chat"] }],
      })[0].id,
      "command",
    );
    assert.equal(
      parseModelsResponse(
        {
          data: {
            models: [
              {
                name: "models/gemini-test",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          },
        },
        { presetId: "google" },
      )[0].id,
      "gemini-test",
    );
  });

  it("uses native capability and context metadata", function () {
    const [model] = parseModelsResponse({
      data: [
        {
          id: "native-model",
          capabilities: { completion_chat: true },
          max_context_length: 32768,
        },
      ],
    });
    assert.include(model.capabilities, "chat");
    assert.equal(model.contextLength, 32768);
  });

  it("excludes OpenCode models that require non-chat-completions protocols", function () {
    const response = {
      data: [
        { id: "gpt-5.5" },
        { id: "claude-sonnet-4-6" },
        { id: "gemini-3.5-flash" },
        { id: "qwen3.7-plus" },
        { id: "deepseek-v4-flash" },
      ],
    };
    assert.deepEqual(
      parseModelsResponse(response, { presetId: "opencode-zen" }).map(
        (model) => model.id,
      ),
      ["deepseek-v4-flash"],
    );
    assert.deepEqual(
      parseModelsResponse(response, { presetId: "opencode-go" }).map(
        (model) => model.id,
      ),
      ["gpt-5.5", "claude-sonnet-4-6", "gemini-3.5-flash", "deepseek-v4-flash"],
    );
  });
});
