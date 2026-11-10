const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
const DEFAULT_MODEL = "claude-haiku-5-5";

// Reads AI provider configuration from the environment. Deliberately does
// NOT throw when the key is missing — unlike the PayPal config, AI import is
// an optional feature. `configured` tells callers whether to even attempt a
// request; the client itself also refuses a call without a key, so callers
// can't accidentally skip the check.
export function loadAnthropicConfig(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  const model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  return { apiKey, model, configured: Boolean(apiKey) };
}

function notConfiguredError() {
  const error = new Error(
    "AI import is not configured. Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_MODEL) in your .env file and restart the server."
  );
  error.code = "AI_NOT_CONFIGURED";
  error.status = 503;
  return error;
}

// A thin wrapper around the Anthropic Messages API's structured-outputs
// feature (output_config.format: json_schema), which returns a response
// whose text content is guaranteed to match the given JSON Schema. See
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs
export function createAnthropicClient(config) {
  async function createStructuredMessage({ system, messages, schema, maxTokens = 1024, timeoutMs = 20000 }) {
    if (!config.configured) {
      throw notConfiguredError();
    }

    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          system,
          messages,
          output_config: { format: { type: "json_schema", schema } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      if (cause.name === "TimeoutError" || cause.name === "AbortError") {
        const error = new Error("The request to the AI provider timed out.");
        error.code = "AI_TIMEOUT";
        error.status = 504;
        throw error;
      }
      const error = new Error("Could not reach the AI provider.");
      error.code = "AI_PROVIDER_UNREACHABLE";
      error.status = 502;
      throw error;
    }

    if (response.status === 401 || response.status === 403) {
      const error = new Error("The AI provider rejected our credentials.");
      error.code = "AI_AUTH_FAILED";
      error.status = 502;
      throw error;
    }

    if (response.status === 429) {
      const error = new Error("The AI provider is rate-limiting requests right now. Try again shortly.");
      error.code = "AI_RATE_LIMITED";
      error.status = 429;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`The AI provider request failed (HTTP ${response.status}).`);
      error.code = "AI_PROVIDER_ERROR";
      error.status = 502;
      throw error;
    }

    const data = await response.json().catch(() => null);
    const textBlock = data?.content?.find((block) => block.type === "text");

    if (!textBlock?.text) {
      const error = new Error("The AI provider returned an unexpected response.");
      error.code = "AI_INVALID_RESPONSE";
      error.status = 502;
      throw error;
    }

    try {
      return JSON.parse(textBlock.text);
    } catch {
      const error = new Error("The AI provider returned a response that was not valid JSON.");
      error.code = "AI_INVALID_JSON";
      error.status = 502;
      throw error;
    }
  }

  return { createStructuredMessage, configured: config.configured };
}
