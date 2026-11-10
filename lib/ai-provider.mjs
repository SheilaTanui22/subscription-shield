import { loadAnthropicConfig, createAnthropicClient } from "./anthropic-client.mjs";
import { loadOllamaConfig, createOllamaClient } from "./ollama-client.mjs";

const KNOWN_PROVIDERS = new Set(["ollama", "anthropic"]);

// AI_PROVIDER picks exactly one provider to construct — never both, and
// never a silent fallback from one to the other:
//   - unset / empty  -> "ollama" (the free, local default)
//   - "ollama" / "anthropic" (case-insensitive) -> that provider
//   - anything else (a typo, "openai", ...) -> null, a configuration error.
//     An unrecognized value must never be quietly treated as either known
//     provider, in particular never as "ollama" standing in for "whatever
//     the user actually meant" and never as a path to "anthropic".
export function resolveProviderName(env = process.env) {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "") return "ollama";
  return KNOWN_PROVIDERS.has(raw) ? raw : null;
}

function unknownProviderClient(rawValue) {
  const message = `Unknown AI_PROVIDER "${rawValue}". Set it to "ollama" or "anthropic" (or leave it unset to default to ollama).`;
  return {
    configured: false,
    createStructuredMessage: async () => {
      const error = new Error(message);
      error.code = "AI_UNKNOWN_PROVIDER";
      error.status = 503;
      throw error;
    },
  };
}

// Builds the single active AI client for trial extraction. The returned
// `meta` is the only part of this ever sent to the browser (via the
// GET /api/trials/import route) — it never includes a key, a base URL, or
// any other secret/internal detail.
export function createAIClient(env = process.env) {
  const provider = resolveProviderName(env);

  if (provider === null) {
    const rawValue = (env.AI_PROVIDER ?? "").trim();
    return {
      provider: "unknown",
      configured: false,
      model: null,
      client: unknownProviderClient(rawValue),
      meta: { provider: "unknown", configured: false },
    };
  }

  if (provider === "anthropic") {
    const config = loadAnthropicConfig(env);
    return {
      provider: "anthropic",
      configured: config.configured,
      model: config.model,
      client: createAnthropicClient(config),
      meta: { provider: "anthropic", configured: config.configured },
    };
  }

  const config = loadOllamaConfig(env);
  return {
    provider: "ollama",
    configured: config.configured,
    model: config.model,
    client: createOllamaClient(config),
    meta: { provider: "ollama", configured: config.configured },
  };
}
