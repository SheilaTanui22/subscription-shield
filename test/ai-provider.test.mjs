import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveProviderName, createAIClient } from "../lib/ai-provider.mjs";

describe("resolveProviderName", () => {
  test("defaults to ollama when AI_PROVIDER is unset", () => {
    assert.equal(resolveProviderName({}), "ollama");
  });

  test("selects anthropic only on an exact match", () => {
    assert.equal(resolveProviderName({ AI_PROVIDER: "anthropic" }), "anthropic");
  });

  test("is case-insensitive for the anthropic selection", () => {
    assert.equal(resolveProviderName({ AI_PROVIDER: "Anthropic" }), "anthropic");
    assert.equal(resolveProviderName({ AI_PROVIDER: "ANTHROPIC" }), "anthropic");
  });

  test("an explicit 'ollama' selects ollama", () => {
    assert.equal(resolveProviderName({ AI_PROVIDER: "ollama" }), "ollama");
  });

  test("empty string is treated the same as unset (defaults to ollama)", () => {
    assert.equal(resolveProviderName({ AI_PROVIDER: "" }), "ollama");
  });

  test("an unrecognized value is a configuration error (null), never a silent fallback to either provider", () => {
    assert.equal(resolveProviderName({ AI_PROVIDER: "openai" }), null);
    assert.equal(resolveProviderName({ AI_PROVIDER: "anthroppic" }), null);
    assert.equal(resolveProviderName({ AI_PROVIDER: "gpt-4" }), null);
  });
});

describe("createAIClient: selects exactly one provider, never both", () => {
  test("defaults to an Ollama client", () => {
    const ai = createAIClient({});
    assert.equal(ai.provider, "ollama");
    assert.equal(typeof ai.client.createStructuredMessage, "function");
    assert.deepEqual(ai.meta, { provider: "ollama", configured: true });
  });

  test("builds an Anthropic client only when AI_PROVIDER=anthropic", () => {
    const ai = createAIClient({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" });
    assert.equal(ai.provider, "anthropic");
    assert.equal(ai.configured, true);
    assert.deepEqual(ai.meta, { provider: "anthropic", configured: true });
  });

  test("an unconfigured Anthropic selection never silently uses Ollama instead", () => {
    // Explicitly selecting anthropic with no key must surface as "anthropic,
    // not configured" — never quietly swap to the local provider, and never
    // report configured:true.
    const ai = createAIClient({ AI_PROVIDER: "anthropic" });
    assert.equal(ai.provider, "anthropic");
    assert.equal(ai.configured, false);
  });

  test("a non-loopback OLLAMA_BASE_URL never causes a fall-through to Anthropic", async () => {
    const ai = createAIClient({ OLLAMA_BASE_URL: "http://example.com:11434" });
    assert.equal(ai.provider, "ollama");
    assert.equal(ai.configured, false);
    await assert.rejects(
      ai.client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "OLLAMA_NOT_LOOPBACK");
        return true;
      }
    );
  });

  test("an unrecognized AI_PROVIDER produces a clear configuration error, not a silent fallback", async () => {
    const ai = createAIClient({ AI_PROVIDER: "openai" });
    assert.equal(ai.provider, "unknown");
    assert.equal(ai.configured, false);
    assert.deepEqual(ai.meta, { provider: "unknown", configured: false });

    await assert.rejects(
      ai.client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_UNKNOWN_PROVIDER");
        assert.equal(error.status, 503);
        assert.match(error.message, /openai/);
        return true;
      }
    );
  });

  test("meta never includes a key, base URL, or model (only provider + configured)", () => {
    const ollamaAi = createAIClient({ OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "qwen3:8b" });
    assert.deepEqual(Object.keys(ollamaAi.meta).sort(), ["configured", "provider"]);

    const anthropicAi = createAIClient({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-super-secret" });
    assert.deepEqual(Object.keys(anthropicAi.meta).sort(), ["configured", "provider"]);
    assert.ok(!JSON.stringify(anthropicAi.meta).includes("sk-super-secret"));
  });
});
