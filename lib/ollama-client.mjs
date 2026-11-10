const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3:8b";
const DEFAULT_TIMEOUT_MS = 120_000; // cold starts (loading the model) can be slow
// How long Ollama keeps the model loaded in memory after a request, so a
// burst of extractions (or coming back a few minutes later) doesn't re-pay
// the load cost. Measured: load_duration was only ~6s of an ~83s cold run
// here (generation dominates, not loading), so this mainly helps avoid
// *extra* cold starts during a session rather than fixing the main cost.
const DEFAULT_KEEP_ALIVE = "15m";
// Ollama's own default context window (4096 tokens, confirmed via
// GET /api/ps) is NOT big enough to safely hold our worst case: a max-length
// 10,000-character pasted message plus the system prompt needs ~5,600
// tokens at a conservative 2.5 chars/token. Left at the default, a long
// paste could silently push the system prompt (sent first) out of context
// instead of erroring — exactly the silent-truncation failure mode this
// feature must never have. 8192 covers the worst case with ~45% headroom
// without being an oversized/arbitrary number.
const DEFAULT_NUM_CTX = 8192;

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function isLoopbackUrl(urlString) {
  try {
    return isLoopbackHost(new URL(urlString).hostname);
  } catch {
    return false;
  }
}

// Reads local Ollama configuration. Unlike the Anthropic config, there is
// no secret to be "missing" — Ollama needs no API key — so this is always
// `configured` UNLESS the base URL has been pointed somewhere non-loopback,
// which this local-only provider refuses outright rather than silently
// calling out over the network.
export function loadOllamaConfig(env = process.env) {
  const baseUrl = (env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL;
  const parsedTimeout = Number(env.OLLAMA_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const keepAlive = env.OLLAMA_KEEP_ALIVE?.trim() || DEFAULT_KEEP_ALIVE;
  const parsedNumCtx = Number(env.OLLAMA_NUM_CTX);
  const numCtx = Number.isFinite(parsedNumCtx) && parsedNumCtx > 0 ? parsedNumCtx : DEFAULT_NUM_CTX;
  const loopback = isLoopbackUrl(baseUrl);

  return { baseUrl, model, timeoutMs, keepAlive, numCtx, loopback, configured: loopback };
}

function notLoopbackError(baseUrl) {
  const error = new Error(
    `OLLAMA_BASE_URL must be a loopback address (127.0.0.1, localhost, or ::1) for local-only AI import. Got "${baseUrl}", which was refused rather than used.`
  );
  error.code = "OLLAMA_NOT_LOOPBACK";
  error.status = 503;
  return error;
}

function busyError() {
  const error = new Error(
    "An AI extraction is already running locally. Wait for it to finish, then try again."
  );
  error.code = "OLLAMA_BUSY";
  error.status = 409;
  return error;
}

function timeoutErrorFor(timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  const error = new Error(
    `The local Ollama request timed out after ${seconds}s. The first request after starting Ollama can be slow while it loads the model — try again, or raise OLLAMA_TIMEOUT_MS.`
  );
  error.code = "AI_TIMEOUT";
  error.status = 504;
  return error;
}

function unavailableError(baseUrl) {
  const error = new Error(
    `Could not reach Ollama at ${baseUrl}. Make sure Ollama is running (\`ollama serve\`).`
  );
  error.code = "OLLAMA_UNAVAILABLE";
  error.status = 503;
  return error;
}

function emptyResponseError() {
  const error = new Error(
    "Ollama returned an empty response. The model may still be loading — try again in a moment."
  );
  error.code = "AI_INVALID_RESPONSE";
  error.status = 502;
  return error;
}

function invalidJsonError() {
  const error = new Error(
    "Ollama's response was not valid JSON — the output may have been truncated. Try a shorter message, or raise OLLAMA_TIMEOUT_MS."
  );
  error.code = "AI_INVALID_JSON";
  error.status = 502;
  return error;
}

function modelMissingError(model) {
  const error = new Error(`Ollama model "${model}" is not available locally. Pull it first: \`ollama pull ${model}\`.`);
  error.code = "OLLAMA_MODEL_MISSING";
  error.status = 503;
  return error;
}

function genericProviderError(status, message) {
  const error = new Error(`The local Ollama request failed (HTTP ${status})${message ? `: ${message}` : "."}`);
  error.code = "OLLAMA_PROVIDER_ERROR";
  error.status = 502;
  return error;
}

async function postChat(baseUrl, body, timeoutMs) {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Sends the chat request with think:false. If the installed Ollama/model
// combination rejects the "think" field outright (an older server, or a
// model with no thinking support), retries once without it rather than
// failing the whole extraction over an optional parameter.
async function sendChat(baseUrl, body, timeoutMs) {
  let response = await postChat(baseUrl, body, timeoutMs);

  if (!response.ok && response.status === 400 && "think" in body) {
    const text = await response.clone().text().catch(() => "");
    if (/think/i.test(text)) {
      const { think, ...withoutThink } = body;
      response = await postChat(baseUrl, withoutThink, timeoutMs);
    }
  }

  return response;
}

async function toProviderError(response, model) {
  const data = await response.json().catch(() => null);
  const message = typeof data?.error === "string" ? data.error : "";

  if (response.status === 404 || /not found|no such model|try pulling/i.test(message)) {
    return modelMissingError(model);
  }

  return genericProviderError(response.status, message);
}

// A local, loopback-only Ollama client exposing the same
// createStructuredMessage({ system, messages, schema, timeoutMs }) shape as
// the Anthropic client, using POST /api/chat with stream:false and the JSON
// Schema passed as `format` (Ollama's structured-outputs support). See
// https://docs.ollama.com/api/chat
export function createOllamaClient(config) {
  let busy = false;

  async function createStructuredMessage({ system, messages, schema, timeoutMs }) {
    if (!config.configured) {
      throw notLoopbackError(config.baseUrl);
    }

    if (busy) {
      throw busyError();
    }

    busy = true;
    const effectiveTimeout = timeoutMs ?? config.timeoutMs;

    try {
      const body = {
        model: config.model,
        messages: [{ role: "system", content: system }, ...messages],
        format: schema,
        stream: false,
        think: false,
        keep_alive: config.keepAlive,
        options: { num_ctx: config.numCtx },
      };

      let response;
      try {
        response = await sendChat(config.baseUrl, body, effectiveTimeout);
      } catch (cause) {
        if (cause.name === "TimeoutError" || cause.name === "AbortError") {
          throw timeoutErrorFor(effectiveTimeout);
        }
        throw unavailableError(config.baseUrl);
      }

      if (!response.ok) {
        throw await toProviderError(response, config.model);
      }

      const data = await response.json().catch(() => null);
      const content = data?.message?.content;

      if (typeof content !== "string" || !content.trim()) {
        throw emptyResponseError();
      }

      try {
        return JSON.parse(content);
      } catch {
        throw invalidJsonError();
      }
    } finally {
      busy = false;
    }
  }

  return { createStructuredMessage, configured: config.configured };
}
