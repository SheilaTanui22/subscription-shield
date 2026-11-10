import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRequestHandler } from "../lib/http-router.mjs";
import { createTrialStore } from "../lib/trial-store.mjs";
import { createTrialService } from "../lib/trial-service.mjs";

// A fake extraction service, scripted per test — no real Anthropic call.
function fakeExtractionService(behavior) {
  return {
    extract: async (text) => {
      if (behavior instanceof Error) throw behavior;
      if (typeof behavior === "function") return behavior(text);
      return behavior;
    },
  };
}

async function startTestServer({ extractionService, aiProviderMeta } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "import-http-test-"));
  const trialsFile = path.join(dir, "trials.json");
  const trialService = createTrialService(createTrialStore(trialsFile));

  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  const handler = createRequestHandler({
    host: "127.0.0.1",
    port,
    client: null,
    stateFileUrl: new URL("file:///unused-state.json"),
    pauseSubscription: async () => {
      throw new Error("not exercised by import tests");
    },
    resumeSubscription: async () => {
      throw new Error("not exercised by import tests");
    },
    trialService,
    extractionService: extractionService ?? fakeExtractionService({ ok: true }),
    aiProviderMeta: aiProviderMeta ?? { provider: "ollama", configured: true },
    publicDir: dir,
  });
  server.on("request", handler);

  const baseUrl = `http://127.0.0.1:${port}`;
  const sameOrigin = { Origin: baseUrl, "Content-Type": "application/json" };

  return {
    baseUrl,
    sameOrigin,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function extraction(overrides = {}) {
  return {
    multipleSubscriptions: false,
    serviceName: "StreamBox",
    serviceNameQuote: "StreamBox",
    trialEndDate: "2026-12-01",
    trialEndDateQuote: "ends 2026-12-01",
    renewalPrice: "9.99",
    renewalPriceQuote: "$9.99",
    currency: "USD",
    currencyQuote: "$9.99",
    billingFrequency: "monthly",
    billingFrequencyQuote: "$9.99 monthly",
    currencyRaw: "USD",
    billingFrequencyRaw: "monthly",
    warnings: [],
    ...overrides,
  };
}

describe("POST /api/trials/import", () => {
  test("returns the extraction on success", async () => {
    const ctx = await startTestServer({ extractionService: fakeExtractionService(extraction()) });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "Welcome to StreamBox! Your trial ends 2026-12-01." }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.serviceName, "StreamBox");
      assert.equal(data.multipleSubscriptions, false);
    } finally {
      await ctx.close();
    }
  });

  test("rejects a request with no Origin header", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(response.status, 403);
    } finally {
      await ctx.close();
    }
  });

  test("rejects a cross-origin request", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: { Origin: "http://evil.example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(response.status, 403);
    } finally {
      await ctx.close();
    }
  });

  test("surfaces a not-configured error with a clear message", async () => {
    const notConfigured = new Error(
      "AI import is not configured. Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_MODEL) in your .env file and restart the server."
    );
    notConfigured.status = 503;
    const ctx = await startTestServer({ extractionService: fakeExtractionService(notConfigured) });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(response.status, 503);
      const data = await response.json();
      assert.match(data.error, /not configured/i);
    } finally {
      await ctx.close();
    }
  });

  test("surfaces a multipleSubscriptions result without saving anything", async () => {
    const ctx = await startTestServer({
      extractionService: fakeExtractionService(
        extraction({
          multipleSubscriptions: true,
          serviceName: null,
          serviceNameQuote: null,
          warnings: ["Paste one confirmation message at a time."],
        })
      ),
    });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "Two subscriptions in one email..." }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.multipleSubscriptions, true);

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.deepEqual(list.trials, []);
    } finally {
      await ctx.close();
    }
  });

  test("surfaces a provider error (e.g. rate limit)", async () => {
    const rateLimited = new Error("The AI provider is rate-limiting requests right now. Try again shortly.");
    rateLimited.status = 429;
    const ctx = await startTestServer({ extractionService: fakeExtractionService(rateLimited) });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(response.status, 429);
    } finally {
      await ctx.close();
    }
  });

  test("surfaces a timeout error", async () => {
    const timeout = new Error("The request to the AI provider timed out.");
    timeout.status = 504;
    const ctx = await startTestServer({ extractionService: fakeExtractionService(timeout) });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(response.status, 504);
    } finally {
      await ctx.close();
    }
  });

  test("rejects a request body over the transport size limit", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "x".repeat(30_000) }),
      });
      assert.equal(response.status, 413);
    } finally {
      await ctx.close();
    }
  });

  test("405s a DELETE", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`, { method: "DELETE" });
      assert.equal(response.status, 405);
    } finally {
      await ctx.close();
    }
  });
});

describe("GET /api/trials/import (provider metadata)", () => {
  test("returns only safe, non-secret provider metadata", async () => {
    const ctx = await startTestServer({ aiProviderMeta: { provider: "ollama", configured: true } });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data, { provider: "ollama", configured: true });
    } finally {
      await ctx.close();
    }
  });

  test("reports the anthropic provider when that's what's active", async () => {
    const ctx = await startTestServer({ aiProviderMeta: { provider: "anthropic", configured: false } });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/import`);
      const data = await response.json();
      assert.deepEqual(data, { provider: "anthropic", configured: false });
    } finally {
      await ctx.close();
    }
  });
});

describe("extraction result saved only after explicit confirmation", () => {
  test("the extract call never writes to trial storage by itself", async () => {
    const ctx = await startTestServer({ extractionService: fakeExtractionService(extraction()) });
    try {
      await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "Welcome to StreamBox!" }),
      });

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.deepEqual(list.trials, []);
    } finally {
      await ctx.close();
    }
  });

  test("a client-confirmed save via POST /api/trials records source=ai_import", async () => {
    const ctx = await startTestServer({ extractionService: fakeExtractionService(extraction()) });
    try {
      const extracted = await fetch(`${ctx.baseUrl}/api/trials/import`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ text: "Welcome to StreamBox!" }),
      }).then((r) => r.json());

      const saved = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({
          serviceName: extracted.serviceName,
          trialEndDate: extracted.trialEndDate,
          renewalPrice: extracted.renewalPrice,
          currency: extracted.currency,
          billingFrequency: extracted.billingFrequency,
          reminderLeadDays: 3,
          source: "ai_import",
        }),
      }).then((r) => r.json());

      assert.equal(saved.source, "ai_import");

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.equal(list.trials.length, 1);
      assert.equal(list.trials[0].source, "ai_import");
    } finally {
      await ctx.close();
    }
  });
});
