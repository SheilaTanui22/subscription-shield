import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "../lib/http-router.mjs";
import { createBudgetService } from "../lib/budget-service.mjs";
import { createBudgetStore } from "../lib/budget-store.mjs";
import { createTrialService } from "../lib/trial-service.mjs";
import { createTrialStore } from "../lib/trial-store.mjs";
import {
  loadDemoStates, fetchSubscriptionSummaries, pauseSubscription, resumeSubscription,
} from "../lib/subscription-service.mjs";
import { resolveResumptionName } from "../lib/budget-conversation.mjs";

async function fixture(t, { musicStatus = "ACTIVE", secondary = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "shield-two-paypal-"));
  const primaryFile = path.join(dir, "demo-state.json");
  const secondaryFile = path.join(dir, "musicbox-demo-state.json");
  const primary = { subscriptionId: "I-STREAM", planId: "P-STREAM" };
  const music = { subscriptionId: "I-MUSIC", planId: "P-MUSIC", serviceName: "MusicBox" };
  await writeFile(primaryFile, JSON.stringify(primary));
  if (secondary) await writeFile(secondaryFile, JSON.stringify(music));
  const stateFileUrls = [primaryFile, secondaryFile];
  const statuses = new Map([["I-STREAM", "SUSPENDED"], ["I-MUSIC", musicStatus]]);
  const calls = [];
  let failMusic = false;
  const client = { async request(url, options = {}) {
    calls.push({ url, method: options.method ?? "GET" });
    const subscription = url.match(/^\/v1\/billing\/subscriptions\/(I-STREAM|I-MUSIC)(?:\/(activate|suspend))?$/);
    if (subscription) {
      const [, id, action] = subscription;
      if (failMusic && id === "I-MUSIC") throw new Error("MusicBox sandbox temporarily unavailable");
      if (action) {
        assert.equal(options.method, "POST");
        statuses.set(id, action === "activate" ? "ACTIVE" : "SUSPENDED");
        return;
      }
      return { id, status: statuses.get(id), billing_info: {} };
    }
    const plan = url.match(/^\/v1\/billing\/plans\/(P-STREAM|P-MUSIC)$/);
    if (plan) {
      const isMusic = plan[1] === "P-MUSIC";
      return { id: plan[1], name: isMusic ? "MusicBox: USD 8 monthly" : "StreamBox: USD 12 monthly",
        billing_cycles: [{ tenure_type: "REGULAR", frequency: { interval_unit: "MONTH", interval_count: 1 },
          pricing_scheme: { fixed_price: { value: isMusic ? "8.00" : "12.00", currency_code: "USD" } } }] };
    }
    throw new Error(`Unexpected PayPal request ${url}`);
  } };
  const trialService = createTrialService(createTrialStore(path.join(dir, "trials.json")));
  await trialService.create({ serviceName: "DesignNest Demo", trialEndDate: "2099-01-01",
    renewalPrice: "14.99", currency: "USD", billingFrequency: "monthly" });
  const budgetService = createBudgetService({
    budgetStore: createBudgetStore(path.join(dir, "budget.json")), trialService,
    fetchPaypalSummary: async () => fetchSubscriptionSummaries(client, await loadDemoStates(stateFileUrls)),
  });
  let interpretation = { intent: "hypothetical_resumption", serviceNames: ["MusicBox"], negated: false };
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  server.on("request", createRequestHandler({ host: "127.0.0.1", port, client,
    stateFileUrl: primaryFile, stateFileUrls, pauseSubscription, resumeSubscription,
    trialService, budgetService, publicDir: dir,
    conversationClient: { createStructuredMessage: async () => interpretation },
  }));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { statuses, calls, primaryFile, secondaryFile, stateFileUrls,
    failMusic() { failMusic = true; },
    interpret(value) { interpretation = value; },
    async request(url, { method = "GET", body, origin = base } = {}) {
      const response = await fetch(base + url, { method,
        headers: { Origin: origin, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("both subscriptions retain their own ID, price and status", async (t) => {
  const ctx = await fixture(t);
  const result = await ctx.request("/api/subscriptions");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.subscriptions.map(({ summary }) =>
    [summary.subscriptionId, summary.status, summary.recurringPrice.value]),
  [["I-STREAM", "SUSPENDED", "12.00"], ["I-MUSIC", "ACTIVE", "8.00"]]);
  const overview = await ctx.request("/api/budget/query", { method: "POST", body: { intent: "budget_overview" } });
  assert.equal(overview.body.summary.potentialRenewals.totalMonthlyEquivalentCents, 1499);
  assert.equal(overview.body.summary.paypalSandboxes.length, 2);
  assert.match(overview.body.answer.body.join(" "), /MusicBox.*\$8\.00/);
  assert.match(overview.body.answer.body.join(" "), /StreamBox.*paused/);
});

test("pause and resume only mutate the subscription named in the route", async (t) => {
  const ctx = await fixture(t);
  for (const action of ["pause", "resume"]) {
    const result = await ctx.request(`/api/subscriptions/I-MUSIC/${action}`, { method: "POST" });
    assert.equal(result.status, 200);
    assert.equal(result.body.verified, true);
    assert.equal(result.body.subscription.subscriptionId, "I-MUSIC");
    assert.equal(ctx.statuses.get("I-STREAM"), "SUSPENDED");
  }
  const stream = await ctx.request("/api/subscriptions/I-STREAM/resume", { method: "POST" });
  assert.equal(stream.body.subscription.subscriptionId, "I-STREAM");
  assert.equal(ctx.statuses.get("I-MUSIC"), "ACTIVE");
  assert.deepEqual(ctx.calls.filter((c) => c.method === "POST").map((c) => c.url), [
    "/v1/billing/subscriptions/I-MUSIC/suspend", "/v1/billing/subscriptions/I-MUSIC/activate",
    "/v1/billing/subscriptions/I-STREAM/activate",
  ]);
  const refreshed = await ctx.request("/api/subscriptions");
  assert.ok(refreshed.body.subscriptions.every((entry) => entry.summary.status === "ACTIVE"));
});

test("unknown IDs, ambiguous legacy actions and cross-origin requests never mutate PayPal", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await ctx.request("/api/subscriptions/I-UNREGISTERED/pause", { method: "POST" })).status, 404);
  assert.equal((await ctx.request("/api/subscription/pause", { method: "POST" })).status, 409);
  assert.equal((await ctx.request("/api/subscriptions/I-MUSIC/pause", { method: "POST", origin: "https://example.invalid" })).status, 403);
  assert.equal((await ctx.request("/api/subscriptions/I-MUSIC/pause")).status, 405);
  assert.equal((await ctx.request("/api/subscriptions", { method: "POST" })).status, 405);
  assert.equal((await ctx.request("/api/subscriptions/%ZZ/pause", { method: "POST" })).status, 400);
  assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 0);
});

test("adding an optional demo does not require migrating legacy StreamBox state", async (t) => {
  const ctx = await fixture(t, { secondary: false });
  const before = await readFile(ctx.primaryFile, "utf8");
  assert.equal((await loadDemoStates(ctx.stateFileUrls)).length, 1);
  assert.equal((await ctx.request("/api/subscription")).body.subscriptionId, "I-STREAM");
  const result = await ctx.request("/api/subscription/resume", { method: "POST" });
  assert.equal(result.body.verified, true);
  assert.equal(await readFile(ctx.primaryFile, "utf8"), before);
});

test("duplicate saved subscription IDs fail clearly before any action", async (t) => {
  const ctx = await fixture(t);
  await copyFile(ctx.primaryFile, ctx.secondaryFile);
  await assert.rejects(loadDemoStates(ctx.stateFileUrls), /Duplicate/);
  assert.equal((await ctx.request("/api/subscriptions/I-STREAM/resume", { method: "POST" })).status, 409);
  assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 0);
});

test("failure of MusicBox keeps StreamBox visible and never substitutes its terms", async (t) => {
  const ctx = await fixture(t);
  ctx.failMusic();
  const result = await ctx.request("/api/subscriptions");
  assert.equal(result.status, 200);
  assert.equal(result.body.subscriptions[0].summary.subscriptionId, "I-STREAM");
  assert.equal(result.body.subscriptions[1].serviceName, "MusicBox");
  assert.match(result.body.subscriptions[1].error, /unavailable/);
  const answer = await ctx.request("/api/budget/ask", { method: "POST", body: { text: "What if I resume MusicBox?" } });
  assert.match(answer.body.answer.headline, /MusicBox/);
  assert.match(answer.body.answer.body.join(" "), /unavailable/);
  assert.doesNotMatch(answer.body.answer.body.join(" "), /\$12\.00/);
});

for (const name of ["MusicBox", "StreamBox"]) {
  for (const negated of [false, true]) {
    test(`AI hypothetical selects ${name}, negated=${negated}, with no mutation`, async (t) => {
      const ctx = await fixture(t, { musicStatus: "SUSPENDED" });
      ctx.interpret({ intent: "hypothetical_resumption", serviceNames: [name], negated });
      const result = await ctx.request("/api/budget/ask", { method: "POST",
        body: { text: `What if I ${negated ? "don't " : ""}resume ${name}?` } });
      assert.equal(result.status, 200);
      assert.equal(result.body.type, "answer");
      assert.match(result.body.answer.headline, new RegExp(name));
      const body = result.body.answer.body.join(" ");
      assert.ok(body.includes(name === "MusicBox" ? "$8.00/month" : "$12.00/month"));
      assert.ok(!body.includes(name === "MusicBox" ? "$12.00" : "$8.00"));
      assert.match(body, negated ? /stays paused/ : /Resuming it would restore/);
      assert.match(body, /No subscription was changed/);
      assert.equal(result.body.summary.potentialRenewals.totalMonthlyEquivalentCents, 1499);
      assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 0);
      assert.deepEqual([...ctx.statuses.values()], ["SUSPENDED", "SUSPENDED"]);
    });
  }
}

test("hypothetical exclusion resolves MusicBox separately from StreamBox", async (t) => {
  const ctx = await fixture(t);
  ctx.interpret({ intent: "hypothetical_exclusion", serviceNames: ["MusicBox"], negated: false });
  const result = await ctx.request("/api/budget/ask", { method: "POST", body: { text: "What if I don't renew MusicBox?" } });
  assert.match(result.body.answer.body.join(" "), /MusicBox/);
  assert.equal(result.body.summary.potentialRenewals.totalMonthlyEquivalentCents, 1499);
  assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 0);
});

test("resumption does not default to the first subscription when target is missing or invalid", async (t) => {
  const ctx = await fixture(t);
  for (const targetSubscriptionId of [undefined, "I-UNKNOWN"]) {
    const result = await ctx.request("/api/budget/query", { method: "POST", body: { intent: "hypothetical_resumption", targetSubscriptionId } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "BUDGET_UNKNOWN_SUBSCRIPTION");
  }
  const records = [{ serviceName: "MusicBox", subscriptionId: "I-ONE" }, { serviceName: "MusicBox", subscriptionId: "I-TWO" }];
  assert.equal(resolveResumptionName(["MusicBox"], [], records).type, "duplicate_subscription_name");
  assert.equal(resolveResumptionName(["MusicBox"], [{ serviceName: "MusicBox" }], records).type, "name_collision");
});

test("MusicBox setup and subscription reruns reuse IDs and preserve StreamBox state", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "shield-demo-setup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "lib"));
  for (const file of ["setup-demo.mjs", "subscribe-demo.mjs", "lib/demo-config.mjs"]) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(dir, file));
  }
  const primary = '{"subscriptionId":"I-ORIGINAL","planId":"P-ORIGINAL","productRequestId":"keep"}';
  await writeFile(path.join(dir, "demo-state.json"), primary);
  const preload = path.join(dir, "fake-paypal.mjs");
  await writeFile(preload, `
    import http from "node:http";
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url, options) => {
      if (!url.startsWith("https://api-m.sandbox.paypal.com/")) throw new Error("Sandbox required");
      appendFileSync(new URL("./calls.jsonl", import.meta.url), JSON.stringify({ url, method: options.method, body: options.body }) + "\\n");
      let value;
      if (url.endsWith("/v1/oauth2/token")) value = { access_token: "test-token" };
      else if (url.endsWith("/v1/catalogs/products")) value = { id: "PROD-MUSIC" };
      else if (url.endsWith("/v1/billing/plans")) value = { id: "P-MUSIC" };
      else if (url.endsWith("/v1/billing/subscriptions")) value = { id: "I-MUSIC" };
      else if (url.endsWith("/I-MUSIC")) value = { id: "I-MUSIC", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/test-approval" }] };
      else throw new Error("Unexpected URL");
      return new Response(JSON.stringify(value), { status: 200 });
    };
    http.createServer = () => ({ on() {}, listen(port, host, callback) { callback(); } });
  `);
  const run = promisify(execFile);
  for (let pass = 0; pass < 2; pass++) {
    for (const script of ["setup-demo.mjs", "subscribe-demo.mjs"]) {
      await run(process.execPath, ["--import", pathToFileURL(preload).href, path.join(dir, script), "--musicbox"], {
        env: { ...process.env, PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "test-id", PAYPAL_CLIENT_SECRET: "test-secret" },
      });
    }
  }
  assert.equal(await readFile(path.join(dir, "demo-state.json"), "utf8"), primary);
  const saved = JSON.parse(await readFile(path.join(dir, "musicbox-demo-state.json"), "utf8"));
  assert.equal(saved.subscriptionId, "I-MUSIC");
  assert.equal(saved.serviceName, "MusicBox");
  const calls = (await readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const creates = calls.filter((c) => c.method === "POST" && !c.url.endsWith("/token"));
  assert.equal(creates.length, 3, "one product, one plan, one subscription across both runs");
  const plan = JSON.parse(creates.find((c) => c.url.endsWith("/plans")).body);
  assert.equal(plan.billing_cycles.length, 1);
  assert.equal(plan.billing_cycles[0].sequence, 1);
  assert.deepEqual(plan.billing_cycles[0].pricing_scheme.fixed_price, { value: "8.00", currency_code: "USD" });
  assert.equal(plan.billing_cycles[0].frequency.interval_unit, "MONTH");
});
