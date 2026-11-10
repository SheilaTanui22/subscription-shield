import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadOllamaConfig, createOllamaClient } from "../lib/ollama-client.mjs";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function chatResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return chatResponse(status, body);
    },
  };
}

describe("loadOllamaConfig", () => {
  test("defaults to loopback, qwen3:8b, and a 120s timeout", () => {
    const config = loadOllamaConfig({});
    assert.equal(config.baseUrl, "http://127.0.0.1:11434");
    assert.equal(config.model, "qwen3:8b");
    assert.equal(config.timeoutMs, 120_000);
    assert.equal(config.configured, true);
  });

  test("honors OLLAMA_MODEL and OLLAMA_TIMEOUT_MS", () => {
    const config = loadOllamaConfig({ OLLAMA_MODEL: "llama3.2", OLLAMA_TIMEOUT_MS: "5000" });
    assert.equal(config.model, "llama3.2");
    assert.equal(config.timeoutMs, 5000);
  });

  test("defaults keep_alive to 15m and num_ctx to 8192", () => {
    const config = loadOllamaConfig({});
    assert.equal(config.keepAlive, "15m");
    assert.equal(config.numCtx, 8192);
  });

  test("honors OLLAMA_KEEP_ALIVE and OLLAMA_NUM_CTX overrides", () => {
    const config = loadOllamaConfig({ OLLAMA_KEEP_ALIVE: "30m", OLLAMA_NUM_CTX: "16384" });
    assert.equal(config.keepAlive, "30m");
    assert.equal(config.numCtx, 16384);
  });

  test("ignores a non-numeric OLLAMA_NUM_CTX and falls back to the default", () => {
    const config = loadOllamaConfig({ OLLAMA_NUM_CTX: "not-a-number" });
    assert.equal(config.numCtx, 8192);
  });

  test("accepts localhost and ::1 as loopback", () => {
    assert.equal(loadOllamaConfig({ OLLAMA_BASE_URL: "http://localhost:11434" }).configured, true);
    assert.equal(loadOllamaConfig({ OLLAMA_BASE_URL: "http://[::1]:11434" }).configured, true);
  });

  test("refuses a non-loopback OLLAMA_BASE_URL (configured=false, never silently used)", () => {
    const config = loadOllamaConfig({ OLLAMA_BASE_URL: "http://example.com:11434" });
    assert.equal(config.loopback, false);
    assert.equal(config.configured, false);
  });
});

describe("createOllamaClient: loopback enforcement", () => {
  test("refuses to call fetch at all when not loopback-configured", async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    };

    const client = createOllamaClient(loadOllamaConfig({ OLLAMA_BASE_URL: "http://example.com:11434" }));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "OLLAMA_NOT_LOOPBACK");
        assert.equal(error.status, 503);
        return true;
      }
    );
    assert.equal(fetchCalled, false);
  });
});

describe("createOllamaClient: request shape and success", () => {
  test("POSTs /api/chat with stream:false, think:false, and the schema as format", async () => {
    let capturedUrl;
    let capturedBody;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return chatResponse(200, { message: { role: "assistant", content: '{"ok":true}' }, done: true });
    };

    const client = createOllamaClient(loadOllamaConfig({}));
    const result = await client.createStructuredMessage({
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      schema: { type: "object" },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(capturedUrl, "http://127.0.0.1:11434/api/chat");
    assert.equal(capturedBody.model, "qwen3:8b");
    assert.equal(capturedBody.stream, false);
    assert.equal(capturedBody.think, false);
    assert.deepEqual(capturedBody.format, { type: "object" });
    assert.deepEqual(capturedBody.messages[0], { role: "system", content: "system prompt" });
    assert.deepEqual(capturedBody.messages[1], { role: "user", content: "hello" });
    assert.equal(capturedBody.keep_alive, "15m");
    assert.deepEqual(capturedBody.options, { num_ctx: 8192 });
  });

  test("sends a configured OLLAMA_KEEP_ALIVE and OLLAMA_NUM_CTX", async () => {
    let capturedBody;
    global.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return chatResponse(200, { message: { content: "{}" } });
    };

    const client = createOllamaClient(loadOllamaConfig({ OLLAMA_KEEP_ALIVE: "30m", OLLAMA_NUM_CTX: "16384" }));
    await client.createStructuredMessage({ system: "s", messages: [], schema: {} });

    assert.equal(capturedBody.keep_alive, "30m");
    assert.deepEqual(capturedBody.options, { num_ctx: 16384 });
  });

  test("uses the configured OLLAMA_MODEL", async () => {
    let capturedBody;
    global.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return chatResponse(200, { message: { content: "{}" } });
    };
    const client = createOllamaClient(loadOllamaConfig({ OLLAMA_MODEL: "llama3.2" }));
    await client.createStructuredMessage({ system: "s", messages: [], schema: {} });
    assert.equal(capturedBody.model, "llama3.2");
  });
});

describe("createOllamaClient: think:false retry fallback", () => {
  test("retries once without 'think' if the server rejects it with a 400 mentioning think", async () => {
    let callCount = 0;
    const seenBodies = [];
    global.fetch = async (url, options) => {
      callCount += 1;
      const body = JSON.parse(options.body);
      seenBodies.push(body);
      if (callCount === 1) {
        return chatResponse(400, { error: "invalid field: think is not supported by this model" });
      }
      return chatResponse(200, { message: { content: '{"ok":true}' } });
    };

    const client = createOllamaClient(loadOllamaConfig({}));
    const result = await client.createStructuredMessage({ system: "s", messages: [], schema: {} });

    assert.deepEqual(result, { ok: true });
    assert.equal(callCount, 2);
    assert.ok("think" in seenBodies[0]);
    assert.ok(!("think" in seenBodies[1]));
  });

  test("does not retry a 400 unrelated to think", async () => {
    let callCount = 0;
    global.fetch = async () => {
      callCount += 1;
      return chatResponse(400, { error: "invalid schema" });
    };

    const client = createOllamaClient(loadOllamaConfig({}));
    await assert.rejects(client.createStructuredMessage({ system: "s", messages: [], schema: {} }));
    assert.equal(callCount, 1);
  });
});

describe("createOllamaClient: error mapping", () => {
  test("maps a connection failure to OLLAMA_UNAVAILABLE", async () => {
    global.fetch = async () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:11434");
      throw error;
    };
    const client = createOllamaClient(loadOllamaConfig({}));
    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "OLLAMA_UNAVAILABLE");
        assert.equal(error.status, 503);
        assert.match(error.message, /ollama serve/);
        return true;
      }
    );
  });

  test("maps a timeout to AI_TIMEOUT with the configured duration in the message", async () => {
    global.fetch = async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    };
    const client = createOllamaClient(loadOllamaConfig({ OLLAMA_TIMEOUT_MS: "5000" }));
    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_TIMEOUT");
        assert.equal(error.status, 504);
        assert.match(error.message, /5s/);
        return true;
      }
    );
  });

  test("maps a model-not-found response to OLLAMA_MODEL_MISSING with a pull hint", async () => {
    global.fetch = async () =>
      chatResponse(404, { error: 'model "qwen3:8b" not found, try pulling it first' });
    const client = createOllamaClient(loadOllamaConfig({ OLLAMA_MODEL: "qwen3:8b" }));
    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "OLLAMA_MODEL_MISSING");
        assert.equal(error.status, 503);
        assert.match(error.message, /ollama pull qwen3:8b/);
        return true;
      }
    );
  });

  test("maps an empty message.content to AI_INVALID_RESPONSE", async () => {
    global.fetch = async () => chatResponse(200, { message: { content: "" } });
    const client = createOllamaClient(loadOllamaConfig({}));
    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_INVALID_RESPONSE");
        return true;
      }
    );
  });

  test("maps a non-JSON message.content (truncated output) to AI_INVALID_JSON", async () => {
    global.fetch = async () => chatResponse(200, { message: { content: '{"serviceName": "Str' } });
    const client = createOllamaClient(loadOllamaConfig({}));
    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "AI_INVALID_JSON");
        return true;
      }
    );
  });

  test("maps a generic 500 to OLLAMA_PROVIDER_ERROR", async () => {
    global.fetch = async () => chatResponse(500, { error: "internal error" });
    const client = createOllamaClient(loadOllamaConfig({}));
    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "OLLAMA_PROVIDER_ERROR");
        assert.equal(error.status, 502);
        return true;
      }
    );
  });
});

describe("createOllamaClient: single-flight concurrency limit", () => {
  test("a second call while one is in flight is rejected with OLLAMA_BUSY, not queued", async () => {
    let resolveFirst;
    const firstGate = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        await firstGate;
      }
      return chatResponse(200, { message: { content: '{"ok":true}' } });
    };

    const client = createOllamaClient(loadOllamaConfig({}));

    const firstCall = client.createStructuredMessage({ system: "s", messages: [], schema: {} });
    // Give the first call a tick to actually mark itself busy before firing the second.
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
      client.createStructuredMessage({ system: "s", messages: [], schema: {} }),
      (error) => {
        assert.equal(error.code, "OLLAMA_BUSY");
        assert.equal(error.status, 409);
        return true;
      }
    );

    resolveFirst();
    const firstResult = await firstCall;
    assert.deepEqual(firstResult, { ok: true });
    assert.equal(calls, 1);
  });

  test("a third call succeeds once the first has finished", async () => {
    global.fetch = async () => chatResponse(200, { message: { content: '{"ok":true}' } });
    const client = createOllamaClient(loadOllamaConfig({}));

    const first = await client.createStructuredMessage({ system: "s", messages: [], schema: {} });
    const second = await client.createStructuredMessage({ system: "s", messages: [], schema: {} });
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
  });
});
