import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadAnthropicConfig, createAnthropicClient } from "../lib/anthropic-client.mjs";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("loadAnthropicConfig", () => {
  test("is unconfigured when ANTHROPIC_API_KEY is missing, without throwing", () => {
    const config = loadAnthropicConfig({});
    assert.equal(config.configured, false);
    assert.equal(config.apiKey, null);
    assert.equal(config.model, "claude-haiku-5-5");
  });

  test("is configured when ANTHROPIC_API_KEY is present", () => {
    const config = loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test-123" });
    assert.equal(config.configured, true);
    assert.equal(config.apiKey, "sk-test-123");
  });

  test("honors a custom ANTHROPIC_MODEL", () => {
    const config = loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-opus-5-5" });
    assert.equal(config.model, "claude-opus-5-5");
  });
});

describe("createAnthropicClient", () => {
  test("refuses to call the provider when not configured, and never touches fetch", async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    };

    const client = createAnthropicClient(loadAnthropicConfig({}));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_NOT_CONFIGURED");
        assert.equal(error.status, 503);
        return true;
      }
    );
    assert.equal(fetchCalled, false);
  });

  test("sends the documented request shape and parses the structured JSON reply", async () => {
    let capturedUrl;
    let capturedOptions;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return jsonResponse(200, { content: [{ type: "text", text: '{"ok":true}' }] });
    };

    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));
    const result = await client.createStructuredMessage({
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      schema: { type: "object" },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(capturedOptions.headers["x-api-key"], "sk-test");
    assert.ok(capturedOptions.headers["anthropic-version"]);

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.system, "system prompt");
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
    assert.equal(body.output_config.format.type, "json_schema");
    assert.deepEqual(body.output_config.format.schema, { type: "object" });
  });

  test("maps a 401 to AI_AUTH_FAILED", async () => {
    global.fetch = async () => jsonResponse(401, { error: "unauthorized" });
    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_AUTH_FAILED");
        return true;
      }
    );
  });

  test("maps a 429 to AI_RATE_LIMITED", async () => {
    global.fetch = async () => jsonResponse(429, { error: "rate limited" });
    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_RATE_LIMITED");
        assert.equal(error.status, 429);
        return true;
      }
    );
  });

  test("maps a 500 to a generic provider error", async () => {
    global.fetch = async () => jsonResponse(500, { error: "boom" });
    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_PROVIDER_ERROR");
        assert.equal(error.status, 502);
        return true;
      }
    );
  });

  test("rejects a response with no text content block", async () => {
    global.fetch = async () => jsonResponse(200, { content: [{ type: "tool_use" }] });
    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_INVALID_RESPONSE");
        return true;
      }
    );
  });

  test("rejects a text block that isn't valid JSON", async () => {
    global.fetch = async () => jsonResponse(200, { content: [{ type: "text", text: "not json" }] });
    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_INVALID_JSON");
        return true;
      }
    );
  });

  test("maps a network failure to AI_PROVIDER_UNREACHABLE", async () => {
    global.fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_PROVIDER_UNREACHABLE");
        return true;
      }
    );
  });

  test("maps an abort/timeout to AI_TIMEOUT", async () => {
    global.fetch = async () => {
      const error = new Error("The operation was aborted");
      error.name = "TimeoutError";
      throw error;
    };
    const client = createAnthropicClient(loadAnthropicConfig({ ANTHROPIC_API_KEY: "sk-test" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_TIMEOUT");
        assert.equal(error.status, 504);
        return true;
      }
    );
  });
});
