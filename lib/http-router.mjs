import { setTimeout as delay } from "node:timers/promises";

import { loadDemoStates, fetchSubscriptionSummary, fetchSubscriptionSummaries } from "./subscription-service.mjs";
import { isTrustedOrigin } from "./http-security.mjs";
import { readStaticFile } from "./static-files.mjs";
import { interpretAndResolve } from "./budget-conversation.mjs";
import {
  unsupportedAnswer,
  rejectedAnswer,
  hypotheticalResumptionRejectedAnswer,
  hypotheticalBudgetChangeRejectedAnswer,
} from "../public/budget-templates.mjs";

function sendJson(response, status, payload, extraHeaders) {
  response.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  response.end(JSON.stringify(payload));
}

function methodNotAllowed(response, allow) {
  sendJson(response, 405, { error: "Method not allowed" }, { Allow: allow });
}

function errorStatus(error) {
  return Number.isInteger(error.status) ? error.status : 502;
}

async function readJsonBody(request, { limit = 10_000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

// Builds the HTTP request handler used by the real server, parameterized so
// it can be exercised in tests without live PayPal credentials or a bound
// production socket.
export function createRequestHandler({
  host,
  port,
  client,
  stateFileUrl,
  stateFileUrls = [stateFileUrl],
  pauseSubscription,
  resumeSubscription,
  trialService,
  extractionService,
  aiProviderMeta,
  publicDir,
  budgetService,
  conversationClient,
}) {
  async function selectSubscription(subscriptionId) {
    const states = await loadDemoStates(stateFileUrls);
    const state = subscriptionId
      ? states.find((item) => item.subscriptionId === subscriptionId)
      : states.length === 1 ? states[0] : null;
    if (!state) {
      const error = new Error(subscriptionId
        ? "That PayPal subscription is not registered in this demo."
        : "Select a specific PayPal subscription from its dashboard card.");
      error.status = subscriptionId ? 404 : 409;
      throw error;
    }
    return state;
  }

  async function handleGetSubscription(response) {
    const state = await selectSubscription();
    const summary = await fetchSubscriptionSummary(client, state);
    sendJson(response, 200, summary);
  }

  async function handleMutation(request, response, action, subscriptionId) {
    if (!isTrustedOrigin(request, { host, port })) {
      sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
      return;
    }

    const state = await selectSubscription(subscriptionId);
    const result = await action(client, state, { delay });
    const summary = await fetchSubscriptionSummary(client, state);

    sendJson(response, 200, { ...result, subscription: summary });
  }

  return async function handleRequest(request, response) {
    response.setHeader("Cache-Control", "no-store");

    try {
      const url = new URL(request.url, `http://${host}:${port}`);

      if (url.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { app: "Subscription Shield", status: "running" });
        return;
      }

      if (url.pathname === "/api/subscriptions") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }
        const states = await loadDemoStates(stateFileUrls);
        const subscriptions = await fetchSubscriptionSummaries(client, states);
        sendJson(response, 200, { subscriptions });
        return;
      }

      const subscriptionAction = url.pathname.match(/^\/api\/subscriptions\/([^/]+)\/(pause|resume)$/);
      if (subscriptionAction) {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        let subscriptionId;
        try { subscriptionId = decodeURIComponent(subscriptionAction[1]); }
        catch { sendJson(response, 400, { error: "Invalid subscription ID." }); return; }
        await handleMutation(request, response,
          subscriptionAction[2] === "pause" ? pauseSubscription : resumeSubscription,
          subscriptionId);
        return;
      }

      if (url.pathname === "/api/subscription") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }
        await handleGetSubscription(response);
        return;
      }

      if (url.pathname === "/api/subscription/pause") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        await handleMutation(request, response, pauseSubscription);
        return;
      }

      if (url.pathname === "/api/subscription/resume") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        await handleMutation(request, response, resumeSubscription);
        return;
      }

      if (url.pathname === "/api/trials") {
        if (request.method === "GET") {
          const trials = await trialService.list();
          sendJson(response, 200, { trials });
          return;
        }

        if (request.method === "POST") {
          if (!isTrustedOrigin(request, { host, port })) {
            sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
            return;
          }
          const body = await readJsonBody(request);
          const trial = await trialService.create(body);
          sendJson(response, 201, trial);
          return;
        }

        methodNotAllowed(response, "GET, POST");
        return;
      }

      if (url.pathname === "/api/trials/import") {
        if (request.method === "GET") {
          // Safe, non-secret metadata only (which provider is active, and
          // whether it's usable) so the frontend can tailor its privacy
          // notice — never a key, base URL, or other internal detail.
          sendJson(response, 200, aiProviderMeta);
          return;
        }

        if (request.method !== "POST") {
          methodNotAllowed(response, "GET, POST");
          return;
        }
        if (!isTrustedOrigin(request, { host, port })) {
          sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
          return;
        }
        // Pasted confirmation text can be long; cap transport size well
        // above the 10,000-character business rule (enforced separately by
        // extractionService) to account for JSON escaping overhead.
        const body = await readJsonBody(request, { limit: 25_000 });
        const extraction = await extractionService.extract(body.text);
        sendJson(response, 200, extraction);
        return;
      }

      if (url.pathname === "/api/budget") {
        if (request.method === "GET") {
          const budget = await budgetService.getBudget();
          sendJson(response, 200, { amountCents: budget.amountCents, currency: budget.currency });
          return;
        }

        if (request.method === "PUT") {
          if (!isTrustedOrigin(request, { host, port })) {
            sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
            return;
          }
          const body = await readJsonBody(request);
          const budget = await budgetService.setBudget(body);
          sendJson(response, 200, { amountCents: budget.amountCents, currency: budget.currency });
          return;
        }

        methodNotAllowed(response, "GET, PUT");
        return;
      }

      if (url.pathname === "/api/budget/summary") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }
        // No AI involved — this works even when Ollama isn't running.
        const summary = await budgetService.buildSummary();
        sendJson(response, 200, summary);
        return;
      }

      if (url.pathname === "/api/budget/query") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (!isTrustedOrigin(request, { host, port })) {
          sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
          return;
        }
        // The deterministic path: a known intent and already-resolved trial
        // ids, no AI call. Used by the suggested-question buttons.
        const body = await readJsonBody(request);
        const excludeTrialIds = Array.isArray(body.excludeTrialIds)
          ? body.excludeTrialIds.filter((id) => typeof id === "string")
          : [];
        const result = await budgetService.answerQuery({
          intent: body.intent,
          excludeTrialIds,
          negated: body.negated === true,
          amountCents: Number.isInteger(body.amountCents) ? body.amountCents : undefined,
          relative: body.relative === true,
          targetSubscriptionId: body.targetSubscriptionId,
        });
        sendJson(response, 200, { type: "answer", ...result });
        return;
      }

      if (url.pathname === "/api/budget/ask") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (!isTrustedOrigin(request, { host, port })) {
          sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
          return;
        }
        // Free-text questions go through the AI model only to classify
        // intent and pick out record names — see budget-conversation.mjs.
        // Capped well above the 500-character business rule it enforces,
        // to account for JSON escaping overhead.
        const body = await readJsonBody(request, { limit: 5_000 });
        const baseExcludeTrialIds = Array.isArray(body.excludeTrialIds)
          ? body.excludeTrialIds.filter((id) => typeof id === "string")
          : [];

        const baseSummary = await budgetService.buildSummary();
        const resolution = await interpretAndResolve({
          client: conversationClient,
          text: body.text,
          trials: baseSummary.potentialRenewals.items,
          paypalSandbox: baseSummary.paypalSandbox,
          paypalSandboxes: baseSummary.paypalSandboxes,
          baseExcludeTrialIds,
        });

        if (resolution.type === "unsupported") {
          sendJson(response, 200, {
            type: "answer",
            intent: resolution.intent,
            answer: unsupportedAnswer(),
            summary: baseSummary,
          });
          return;
        }

        if (resolution.type === "rejected") {
          const answer =
            resolution.intent === "hypothetical_resumption"
              ? hypotheticalResumptionRejectedAnswer(resolution.reason, { name: resolution.name })
              : resolution.intent === "hypothetical_budget_change"
                ? hypotheticalBudgetChangeRejectedAnswer(resolution.reason, { amount: resolution.amount })
                : rejectedAnswer(resolution.notFound);
          sendJson(response, 200, {
            type: "rejected",
            intent: resolution.intent,
            answer,
          });
          return;
        }

        if (resolution.type === "clarification") {
          sendJson(response, 200, {
            type: "clarification",
            intent: resolution.intent,
            ambiguous: resolution.ambiguous,
          });
          return;
        }

        const result = await budgetService.answerQuery({
          intent: resolution.intent,
          excludeTrialIds: resolution.excludeTrialIds,
          paused: resolution.paused,
          activeSandbox: resolution.activeSandbox,
          negated: resolution.negated,
          amountCents: resolution.amountCents,
          relative: resolution.relative,
          targetSubscriptionId: resolution.targetSubscriptionId,
        });
        sendJson(response, 200, { type: "answer", ...result });
        return;
      }

      if (url.pathname.startsWith("/api/trials/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/trials/".length));

        if (!id) {
          sendJson(response, 404, { error: "Not found" });
          return;
        }

        if (request.method === "PUT") {
          if (!isTrustedOrigin(request, { host, port })) {
            sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
            return;
          }
          const body = await readJsonBody(request);
          const trial = await trialService.update(id, body);
          sendJson(response, 200, trial);
          return;
        }

        if (request.method === "DELETE") {
          if (!isTrustedOrigin(request, { host, port })) {
            sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
            return;
          }
          const result = await trialService.remove(id);
          sendJson(response, 200, result);
          return;
        }

        methodNotAllowed(response, "PUT, DELETE");
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "Route not found" });
        return;
      }

      if (request.method === "GET") {
        const file = await readStaticFile(publicDir, url.pathname);
        if (file) {
          response.writeHead(200, { "Content-Type": file.contentType });
          response.end(file.body);
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      console.error(error.message);
      if (response.headersSent) {
        response.end();
        return;
      }
      const payload = { error: error.message };
      if (error.fieldErrors) payload.fieldErrors = error.fieldErrors;
      if (error.code) payload.code = error.code;
      sendJson(response, errorStatus(error), payload);
    }
  };
}
