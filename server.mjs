import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPayPalConfig, createPayPalClient } from "./lib/paypal-client.mjs";
import { pauseSubscription, resumeSubscription, loadDemoState, fetchSubscriptionSummary } from "./lib/subscription-service.mjs";
import { createTrialStore } from "./lib/trial-store.mjs";
import { createTrialService } from "./lib/trial-service.mjs";
import { createAIClient } from "./lib/ai-provider.mjs";
import { createTrialExtractionService } from "./lib/trial-extraction.mjs";
import { createBudgetStore } from "./lib/budget-store.mjs";
import { createBudgetService } from "./lib/budget-service.mjs";
import { createRequestHandler } from "./lib/http-router.mjs";

const { PORT = "3001", HOST = "127.0.0.1" } = process.env;

const paypalConfig = loadPayPalConfig(process.env);
const client = createPayPalClient(paypalConfig);

const stateFileUrl = new URL("./demo-state.json", import.meta.url);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

// Runtime trial data lives next to the other local state files (not inside
// public/, which is served directly) and is git-ignored.
const trialsFilePath =
  process.env.TRIALS_FILE_PATH ?? fileURLToPath(new URL("./trials.json", import.meta.url));
const trialStore = createTrialStore(trialsFilePath);
const trialService = createTrialService(trialStore);

// The user's monthly budget, stored the same way as trials: outside
// public/, git-ignored, read/written through a single atomic-write queue.
const budgetFilePath =
  process.env.BUDGET_FILE_PATH ?? fileURLToPath(new URL("./budget.json", import.meta.url));
const budgetStore = createBudgetStore(budgetFilePath);
const budgetService = createBudgetService({
  budgetStore,
  trialService,
  fetchPaypalSummary: async () => {
    const state = await loadDemoState(stateFileUrl);
    return fetchSubscriptionSummary(client, state);
  },
});

// AI import is optional and never blocks startup: AI_PROVIDER picks exactly
// one provider (defaults to the free, local Ollama; Anthropic only when
// explicitly selected — see lib/ai-provider.mjs), and a misconfigured or
// unreachable provider just makes extractionService.extract(...) fail with
// a clear error the first time it's actually used.
const ai = createAIClient(process.env);
const extractionService = createTrialExtractionService(ai.client);

if (!ai.configured) {
  console.log(
    `AI import: the ${ai.provider} provider is not correctly configured, so 'Import from text' will show a clear error. See .env.example.`
  );
} else {
  console.log(`AI import: using ${ai.provider} (${ai.model}) for 'Import from text'.`);
}

const handleRequest = createRequestHandler({
  host: HOST,
  port: PORT,
  client,
  stateFileUrl,
  pauseSubscription,
  resumeSubscription,
  trialService,
  extractionService,
  aiProviderMeta: ai.meta,
  publicDir,
  budgetService,
  // The budget conversation reuses the exact same AI client as trial
  // import — no new provider, no model change, no cloud fallback. Only
  // free-text question interpretation touches this; budget summaries and
  // the suggested-question buttons never call it.
  conversationClient: ai.client,
});

const server = http.createServer(handleRequest);

server.listen(Number(PORT), HOST, () => {
  console.log(`Subscription Shield: http://${HOST}:${PORT}`);
});
