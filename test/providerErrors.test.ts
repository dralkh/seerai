import { assert } from "chai";
import {
  extractProviderErrorMessage,
  formatProviderError,
} from "../src/modules/openai";

describe("provider error formatting", function () {
  it("parses OpenAI's error shape", function () {
    assert.equal(
      extractProviderErrorMessage(
        JSON.stringify({ error: { message: "rate limited", code: 429 } }),
      ),
      "rate limited",
    );
  });

  it("parses Google's array-wrapped REST error shape", function () {
    assert.equal(
      extractProviderErrorMessage(
        JSON.stringify([
          {
            error: {
              code: 503,
              message: "This model is currently experiencing high demand.",
              status: "UNAVAILABLE",
            },
          },
        ]),
      ),
      "This model is currently experiencing high demand.",
    );
  });

  it("falls back to raw text for non-JSON bodies", function () {
    assert.equal(extractProviderErrorMessage("upstream boom"), "upstream boom");
    assert.isUndefined(extractProviderErrorMessage(""));
  });

  it("labels the provider, includes model/status, and hints on overload", function () {
    const message = formatProviderError(
      {
        provider: { name: "Google Gemini" },
        model: { modelId: "gemini-3.8-flash" },
      } as any,
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      503,
      "Service Unavailable",
      JSON.stringify([
        {
          error: {
            code: 503,
            message: "This model is currently experiencing high demand.",
            status: "UNAVAILABLE",
          },
        },
      ]),
    );
    assert.include(message, "Google Gemini error");
    assert.include(message, "model gemini-3.8-flash");
    assert.include(message, "HTTP 503");
    assert.include(
      message,
      "This model is currently experiencing high demand.",
    );
    assert.include(message, "overloaded");
    assert.notInclude(message, "OpenAI API Error");
  });

  it("infers the provider from the URL when no config is resolved", function () {
    const message = formatProviderError(
      undefined,
      "https://api.openai.com/v1/chat/completions",
      429,
      "Too Many Requests",
      JSON.stringify({ error: { message: "slow down" } }),
    );
    assert.include(message, "OpenAI error");
    assert.include(message, "Rate limit reached");
  });
});
