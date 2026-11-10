import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRequestHandler } from "../lib/http-router.mjs";
import { createTrialStore } from "../lib/trial-store.mjs";
import { createTrialService } from "../lib/trial-service.mjs";

// Regression coverage for a bug where every "wrong HTTP method" branch
// called response.writeHead() twice (once directly for the Allow header,
// once again inside sendJson), which throws ERR_HTTP_HEADERS_SENT and
// leaves the request hanging instead of ever completing with a 405.
async function startTestServer() {
  const dir = await mkdtemp(path.join(tmpdir(), "method-not-allowed-test-"));
  const trialService = createTrialService(createTrialStore(path.join(dir, "trials.json")));

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
      throw new Error("not exercised");
    },
    resumeSubscription: async () => {
      throw new Error("not exercised");
    },
    trialService,
    extractionService: { extract: async () => ({}) },
    publicDir: dir,
  });
  server.on("request", handler);

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const cases = [
  { method: "DELETE", path: "/api/subscription", expectedAllow: "GET" },
  { method: "GET", path: "/api/subscription/pause", expectedAllow: "POST" },
  { method: "GET", path: "/api/subscription/resume", expectedAllow: "POST" },
  { method: "DELETE", path: "/api/trials", expectedAllow: "GET, POST" },
  { method: "DELETE", path: "/api/trials/import", expectedAllow: "GET, POST" },
  { method: "GET", path: "/api/trials/some-id", expectedAllow: "PUT, DELETE" },
  { method: "POST", path: "/api/trials/some-id", expectedAllow: "PUT, DELETE" },
];

for (const { method, path: routePath, expectedAllow } of cases) {
  test(`${method} ${routePath} completes with 405 and an Allow header (does not hang)`, async () => {
    const ctx = await startTestServer();
    try {
      const response = await fetch(`${ctx.baseUrl}${routePath}`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), expectedAllow);
      const body = await response.json();
      assert.match(body.error, /not allowed/i);
    } finally {
      await ctx.close();
    }
  });
}
