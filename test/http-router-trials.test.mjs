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

// Spins up the real HTTP router (same code path as server.mjs) against an
// isolated temp-file trial store and an ephemeral port, with PayPal-related
// dependencies stubbed out since these tests never touch /api/subscription*.
async function startTestServer() {
  const dir = await mkdtemp(path.join(tmpdir(), "trial-http-test-"));
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
      throw new Error("not exercised by trial tests");
    },
    resumeSubscription: async () => {
      throw new Error("not exercised by trial tests");
    },
    trialService,
    publicDir: dir,
  });
  server.on("request", handler);

  const baseUrl = `http://127.0.0.1:${port}`;
  const sameOrigin = { Origin: baseUrl, "Content-Type": "application/json" };

  return {
    baseUrl,
    sameOrigin,
    trialsFile,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function validPayload(overrides = {}) {
  return {
    serviceName: "StreamBox",
    trialEndDate: "2026-12-01",
    renewalPrice: "12.99",
    currency: "USD",
    billingFrequency: "monthly",
    reminderLeadDays: 3,
    ...overrides,
  };
}

test("GET /api/trials starts empty", async () => {
  const ctx = await startTestServer();
  try {
    const response = await fetch(`${ctx.baseUrl}/api/trials`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { trials: [] });
  } finally {
    await ctx.close();
  }
});

describe("POST /api/trials", () => {
  test("creates a trial when the Origin header matches the server", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 201);
      const trial = await response.json();
      assert.equal(trial.serviceName, "StreamBox");
      assert.equal(trial.renewalPriceCents, 1299);
      assert.equal(trial.source, "manual");

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.equal(list.trials.length, 1);
    } finally {
      await ctx.close();
    }
  });

  test("rejects a request with no Origin header and creates nothing", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 403);

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.deepEqual(list.trials, []);
    } finally {
      await ctx.close();
    }
  });

  test("rejects a request from a different Origin", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: { Origin: "http://evil.example.com", "Content-Type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 403);
    } finally {
      await ctx.close();
    }
  });

  test("returns 400 with field errors for invalid input", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload({ serviceName: "" })),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.ok(body.fieldErrors.serviceName);
    } finally {
      await ctx.close();
    }
  });

  test("two concurrent same-origin creates both persist", async () => {
    const ctx = await startTestServer();
    try {
      const post = (name) =>
        fetch(`${ctx.baseUrl}/api/trials`, {
          method: "POST",
          headers: ctx.sameOrigin,
          body: JSON.stringify(validPayload({ serviceName: name })),
        });

      const [a, b] = await Promise.all([post("First"), post("Second")]);
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.equal(list.trials.length, 2);
      assert.deepEqual(
        list.trials.map((t) => t.serviceName).sort(),
        ["First", "Second"]
      );
    } finally {
      await ctx.close();
    }
  });
});

describe("PUT /api/trials/:id", () => {
  test("updates a trial when same-origin", async () => {
    const ctx = await startTestServer();
    try {
      const created = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload()),
      }).then((r) => r.json());

      const response = await fetch(`${ctx.baseUrl}/api/trials/${created.id}`, {
        method: "PUT",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload({ serviceName: "Renamed" })),
      });
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.equal(updated.serviceName, "Renamed");
      assert.equal(updated.id, created.id);
    } finally {
      await ctx.close();
    }
  });

  test("rejects a cross-origin update and leaves the trial unchanged", async () => {
    const ctx = await startTestServer();
    try {
      const created = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload()),
      }).then((r) => r.json());

      const response = await fetch(`${ctx.baseUrl}/api/trials/${created.id}`, {
        method: "PUT",
        headers: { Origin: "http://evil.example.com", "Content-Type": "application/json" },
        body: JSON.stringify(validPayload({ serviceName: "Hacked" })),
      });
      assert.equal(response.status, 403);

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.equal(list.trials[0].serviceName, "StreamBox");
    } finally {
      await ctx.close();
    }
  });

  test("returns 404 for an unknown id", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/does-not-exist`, {
        method: "PUT",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload()),
      });
      assert.equal(response.status, 404);
    } finally {
      await ctx.close();
    }
  });
});

describe("DELETE /api/trials/:id", () => {
  test("deletes a trial when same-origin, after confirmation on the client", async () => {
    const ctx = await startTestServer();
    try {
      const created = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload()),
      }).then((r) => r.json());

      const response = await fetch(`${ctx.baseUrl}/api/trials/${created.id}`, {
        method: "DELETE",
        headers: ctx.sameOrigin,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id: created.id });

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.deepEqual(list.trials, []);
    } finally {
      await ctx.close();
    }
  });

  test("rejects a cross-origin delete and keeps the trial", async () => {
    const ctx = await startTestServer();
    try {
      const created = await fetch(`${ctx.baseUrl}/api/trials`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(validPayload()),
      }).then((r) => r.json());

      const response = await fetch(`${ctx.baseUrl}/api/trials/${created.id}`, {
        method: "DELETE",
      });
      assert.equal(response.status, 403);

      const list = await fetch(`${ctx.baseUrl}/api/trials`).then((r) => r.json());
      assert.equal(list.trials.length, 1);
    } finally {
      await ctx.close();
    }
  });

  test("returns 404 for an unknown id", async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}/api/trials/does-not-exist`, {
        method: "DELETE",
        headers: ctx.sameOrigin,
      });
      assert.equal(response.status, 404);
    } finally {
      await ctx.close();
    }
  });
});

test("a trial created via HTTP survives a simulated restart", async () => {
  const ctx = await startTestServer();
  try {
    await fetch(`${ctx.baseUrl}/api/trials`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify(validPayload()),
    });

    // Simulate a restart: a brand new store/service reading the same file,
    // independent of whatever the running server's handler is holding.
    const freshService = createTrialService(createTrialStore(ctx.trialsFile));
    const trials = await freshService.list();
    assert.equal(trials.length, 1);
    assert.equal(trials[0].serviceName, "StreamBox");
  } finally {
    await ctx.close();
  }
});
