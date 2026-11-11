import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  interpretQuestion,
  resolveServiceNames,
  resolveResumptionName,
  resolveBudgetChangeAmount,
  interpretAndResolve,
  MAX_QUESTION_LENGTH,
} from "../lib/budget-conversation.mjs";

function stubClient(response) {
  return {
    createStructuredMessage: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function trial(overrides = {}) {
  return {
    id: "t1",
    serviceName: "DesignNest Demo",
    renewalPriceCents: 1499,
    trialEndDate: "2099-01-01",
    ...overrides,
  };
}

describe("interpretQuestion", () => {
  test("rejects an empty question before calling the AI client", async () => {
    let called = false;
    const client = { createStructuredMessage: async () => { called = true; } };
    await assert.rejects(interpretQuestion(client, ""), (error) => {
      assert.equal(error.code, "BUDGET_QUESTION_EMPTY");
      return true;
    });
    assert.equal(called, false);
  });

  test("rejects a question over the max length before calling the AI client", async () => {
    let called = false;
    const client = { createStructuredMessage: async () => { called = true; } };
    const longText = "a".repeat(MAX_QUESTION_LENGTH + 1);
    await assert.rejects(interpretQuestion(client, longText), (error) => {
      assert.equal(error.code, "BUDGET_QUESTION_TOO_LONG");
      return true;
    });
    assert.equal(called, false);
  });

  test("returns the classified intent and service names for a valid response", async () => {
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: ["DesignNest Demo"] });
    const result = await interpretQuestion(client, "What if I don't renew DesignNest Demo?");
    assert.equal(result.intent, "hypothetical_exclusion");
    assert.deepEqual(result.serviceNames, ["DesignNest Demo"]);
  });

  test("normalizes an unrecognized intent value to 'unsupported'", async () => {
    const client = stubClient({ intent: "delete_my_account", serviceNames: [] });
    const result = await interpretQuestion(client, "please help");
    assert.equal(result.intent, "unsupported");
  });

  test("passes through negated:true for hypothetical_resumption", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"], negated: true });
    const result = await interpretQuestion(client, "What if I don't unpause StreamBox?");
    assert.equal(result.negated, true);
  });

  test("defaults negated to false when the model omits it", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"] });
    const result = await interpretQuestion(client, "What if I unpause StreamBox?");
    assert.equal(result.negated, false);
  });

  test("ignores a stray negated:true for any intent other than hypothetical_resumption", async () => {
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: ["DesignNest Demo"], negated: true });
    const result = await interpretQuestion(client, "What if I don't renew DesignNest Demo?");
    assert.equal(result.negated, false);
  });

  test("drops a service name the model invented that never appears in the question (trust-but-verify)", async () => {
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: ["Totally Made Up Service"] });
    const result = await interpretQuestion(client, "What if I don't renew DesignNest Demo?");
    assert.deepEqual(result.serviceNames, []);
  });

  test("keeps a service name that does appear, case-insensitively", async () => {
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: ["designnest demo"] });
    const result = await interpretQuestion(client, "What if I don't renew DesignNest Demo?");
    assert.deepEqual(result.serviceNames, ["designnest demo"]);
  });

  test("propagates a provider error (e.g. busy/timeout) unchanged", async () => {
    const busyError = new Error("busy");
    busyError.code = "OLLAMA_BUSY";
    busyError.status = 409;
    const client = stubClient(busyError);
    await assert.rejects(interpretQuestion(client, "How am I doing?"), (error) => {
      assert.equal(error.code, "OLLAMA_BUSY");
      return true;
    });
  });

  test("rejects a malformed (non-object) AI response", async () => {
    const client = stubClient(null);
    await assert.rejects(interpretQuestion(client, "How am I doing?"), (error) => {
      assert.equal(error.code, "AI_INVALID_RESPONSE");
      return true;
    });
  });

  test("extracts amount and relative for hypothetical_budget_change", async () => {
    const client = stubClient({
      intent: "hypothetical_budget_change",
      serviceNames: [],
      amount: "100",
      relative: true,
    });
    const result = await interpretQuestion(client, "What happens if I add $100?");
    assert.equal(result.amount, "100");
    assert.equal(result.relative, true);
  });

  test("drops an amount the model invented that never appears in the question (trust-but-verify)", async () => {
    const client = stubClient({ intent: "hypothetical_budget_change", serviceNames: [], amount: "500", relative: false });
    const result = await interpretQuestion(client, "What if my budget were $100?");
    assert.equal(result.amount, null);
  });

  test("keeps an amount whose thousands-separator the model reformatted (e.g. the question says \"16 060\", the model echoes \"16,060\")", async () => {
    const client = stubClient({
      intent: "hypothetical_budget_change",
      serviceNames: [],
      amount: "16,060",
      relative: true,
    });
    const result = await interpretQuestion(client, "What happens if I add $16 060?");
    assert.equal(result.amount, "16,060");
  });

  test("ignores amount/relative for any intent other than hypothetical_budget_change", async () => {
    const client = stubClient({
      intent: "hypothetical_exclusion",
      serviceNames: ["DesignNest Demo"],
      amount: "100",
      relative: true,
    });
    const result = await interpretQuestion(client, "What if I don't renew DesignNest Demo for $100?");
    assert.equal(result.amount, null);
    assert.equal(result.relative, false);
  });
});

describe("resolveServiceNames", () => {
  const trials = [trial({ id: "a", serviceName: "DesignNest Demo" }), trial({ id: "b", serviceName: "PaperNest Demo" })];
  const activeSandbox = { category: "active", serviceName: "StreamBox" };
  const pausedSandbox = { category: "paused", serviceName: "StreamBox" };

  test("resolves a single exact (case-insensitive) match to a trial id", () => {
    const result = resolveServiceNames(["designnest demo"], trials, activeSandbox);
    assert.deepEqual(result.resolvedTrialIds, ["a"]);
    assert.deepEqual(result.notFound, []);
  });

  test("flags duplicate-named trials as ambiguous rather than guessing", () => {
    const dupeTrials = [trial({ id: "a" }), trial({ id: "b" })];
    const result = resolveServiceNames(["DesignNest Demo"], dupeTrials, activeSandbox);
    assert.equal(result.ambiguous.length, 1);
    assert.equal(result.ambiguous[0].candidates.length, 2);
    assert.deepEqual(result.resolvedTrialIds, []);
  });

  test("rejects a name matching nothing at all", () => {
    const result = resolveServiceNames(["Nonexistent Service"], trials, activeSandbox);
    assert.deepEqual(result.notFound, ["Nonexistent Service"]);
  });

  test("matches an active sandbox subscription by name separately from trials", () => {
    const result = resolveServiceNames(["StreamBox"], trials, activeSandbox);
    assert.deepEqual(result.activeSandboxNames, ["StreamBox"]);
    assert.deepEqual(result.resolvedTrialIds, []);
  });

  test("matches a paused sandbox subscription by name", () => {
    const result = resolveServiceNames(["StreamBox"], trials, pausedSandbox);
    assert.deepEqual(result.pausedRecordNames, ["StreamBox"]);
  });

  test("a sandbox-name match with unavailable/unknown status is rejected, not silently accepted", () => {
    const result = resolveServiceNames(["StreamBox"], trials, { category: "unavailable", reason: "x" });
    assert.deepEqual(result.notFound, ["StreamBox"]);
  });
});

describe("resolveResumptionName", () => {
  const trials = [trial({ id: "a", serviceName: "DesignNest Demo" })];
  const pausedSandbox = { category: "paused", serviceName: "StreamBox" };

  test("no service name given -> no_name", () => {
    assert.deepEqual(resolveResumptionName([], trials, pausedSandbox), { type: "no_name" });
  });

  test("resolves the sandbox subscription by name, case-insensitively", () => {
    const result = resolveResumptionName(["streambox"], trials, pausedSandbox);
    assert.equal(result.type, "resolved");
    assert.equal(result.name, "streambox");
  });

  test("a name matching only a tracked trial is not_a_subscription (trials have no resume state)", () => {
    const result = resolveResumptionName(["DesignNest Demo"], trials, pausedSandbox);
    assert.equal(result.type, "not_a_subscription");
  });

  test("a name matching neither the sandbox nor a trial is not_found", () => {
    const result = resolveResumptionName(["Ghost Service"], trials, pausedSandbox);
    assert.equal(result.type, "not_found");
    assert.equal(result.name, "Ghost Service");
  });

  test("more than one distinct name mentioned is ambiguous (multiple_names)", () => {
    const result = resolveResumptionName(["StreamBox", "DesignNest Demo"], trials, pausedSandbox);
    assert.equal(result.type, "multiple_names");
  });

  test("a trial sharing the sandbox's exact name is a name_collision, not silently resolved", () => {
    const collidingTrials = [trial({ id: "a", serviceName: "StreamBox" })];
    const result = resolveResumptionName(["StreamBox"], collidingTrials, pausedSandbox);
    assert.equal(result.type, "name_collision");
  });

  test("works the same regardless of the sandbox's current category (active/unknown/unavailable)", () => {
    for (const sandbox of [
      { category: "active", serviceName: "StreamBox" },
      { category: "unknown", serviceName: "StreamBox", status: "EXPIRED" },
      { category: "unavailable", reason: "x" },
    ]) {
      const result = resolveResumptionName(["StreamBox"], trials, sandbox);
      // "unavailable" has no serviceName to match against at all.
      assert.equal(result.type, sandbox.category === "unavailable" ? "not_found" : "resolved");
    }
  });
});

describe("resolveBudgetChangeAmount", () => {
  test("null amount -> no_amount", () => {
    assert.deepEqual(resolveBudgetChangeAmount(null), { type: "no_amount" });
  });

  test("a valid decimal resolves to exact cents", () => {
    assert.deepEqual(resolveBudgetChangeAmount("100"), { type: "resolved", amountCents: 10000 });
    assert.deepEqual(resolveBudgetChangeAmount("49.99"), { type: "resolved", amountCents: 4999 });
  });

  test("a leading '$' is stripped before parsing (observed live: the model echoes it despite instructions)", () => {
    assert.deepEqual(resolveBudgetChangeAmount("$100"), { type: "resolved", amountCents: 10000 });
    assert.deepEqual(resolveBudgetChangeAmount("$ 49.99"), { type: "resolved", amountCents: 4999 });
  });

  test("a thousands separator (comma or space) is stripped before parsing", () => {
    assert.deepEqual(resolveBudgetChangeAmount("16,060"), { type: "resolved", amountCents: 1606000 });
    assert.deepEqual(resolveBudgetChangeAmount("16 060"), { type: "resolved", amountCents: 1606000 });
    assert.deepEqual(resolveBudgetChangeAmount("$16,060"), { type: "resolved", amountCents: 1606000 });
    assert.deepEqual(resolveBudgetChangeAmount("$16 060.50"), { type: "resolved", amountCents: 1606050 });
  });

  test("a negative amount is invalid_amount, not silently clamped to zero", () => {
    const result = resolveBudgetChangeAmount("-50");
    assert.equal(result.type, "invalid_amount");
  });

  test("a non-numeric amount is invalid_amount", () => {
    const result = resolveBudgetChangeAmount("a lot");
    assert.equal(result.type, "invalid_amount");
    assert.equal(result.amount, "a lot");
  });
});

describe("interpretAndResolve", () => {
  const trials = [trial({ id: "a", serviceName: "DesignNest Demo" })];
  const sandbox = { category: "active", serviceName: "StreamBox" };

  test("an unsupported intent (e.g. a cancel request) short-circuits with no record resolution", async () => {
    const client = stubClient({ intent: "unsupported", serviceNames: [] });
    const result = await interpretAndResolve({ client, text: "please cancel DesignNest Demo", trials, paypalSandbox: sandbox });
    assert.equal(result.type, "unsupported");
  });

  test("a non-hypothetical supported intent resolves immediately with no excluded ids", async () => {
    const client = stubClient({ intent: "budget_overview", serviceNames: [] });
    const result = await interpretAndResolve({ client, text: "how am I doing", trials, paypalSandbox: sandbox });
    assert.equal(result.type, "resolved");
    assert.deepEqual(result.excludeTrialIds, []);
  });

  test("hypothetical_exclusion with no service name is rejected", async () => {
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: [] });
    const result = await interpretAndResolve({ client, text: "what if I cancel it", trials, paypalSandbox: sandbox });
    assert.equal(result.type, "rejected");
  });

  test("hypothetical_exclusion with an unmatched name is rejected", async () => {
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: ["Ghost Service"] });
    const result = await interpretAndResolve({
      client,
      text: "what if I don't renew Ghost Service",
      trials,
      paypalSandbox: sandbox,
    });
    assert.equal(result.type, "rejected");
    assert.deepEqual(result.notFound, ["Ghost Service"]);
  });

  test("hypothetical_exclusion with an ambiguous name asks for clarification", async () => {
    const dupeTrials = [trial({ id: "a" }), trial({ id: "b" })];
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: ["DesignNest Demo"] });
    const result = await interpretAndResolve({
      client,
      text: "what if I don't renew DesignNest Demo",
      trials: dupeTrials,
      paypalSandbox: sandbox,
    });
    assert.equal(result.type, "clarification");
    assert.equal(result.ambiguous[0].candidates.length, 2);
  });

  test("hypothetical_exclusion resolves and merges with the current scenario's baseExcludeTrialIds, deduped", async () => {
    const client = stubClient({ intent: "hypothetical_exclusion", serviceNames: ["DesignNest Demo"] });
    const result = await interpretAndResolve({
      client,
      text: "what if I also don't renew DesignNest Demo",
      trials,
      paypalSandbox: sandbox,
      baseExcludeTrialIds: ["a", "existing-other-id"],
    });
    assert.equal(result.type, "resolved");
    assert.deepEqual([...result.excludeTrialIds].sort(), ["a", "existing-other-id"].sort());
  });
});

// Regression coverage for the reported bug: with StreamBox paused, these
// questions were both wrongly classified as hypothetical_exclusion and
// produced the generic "already paused, already excluded" answer instead
// of a resumption-specific one. The AI classification itself is mocked
// here (interpretAndResolve's job starts from an already-classified
// intent) — see the live-Ollama verification notes for whether the real
// model actually classifies these two exact questions correctly.
describe("interpretAndResolve: hypothetical_resumption", () => {
  const trials = [trial({ id: "a", serviceName: "DesignNest Demo" })];
  const pausedSandbox = { category: "paused", serviceName: "StreamBox" };

  test('reported question 1: "What happens if I unpause StreamBox?"', async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"], negated: false });
    const result = await interpretAndResolve({
      client,
      text: "What happens if I unpause StreamBox?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "resolved");
    assert.equal(result.intent, "hypothetical_resumption");
    assert.equal(result.negated, false);
    // Never touches trial exclusion state — this intent has nothing to do
    // with renewal exclusion.
    assert.deepEqual(result.excludeTrialIds, []);
  });

  test('reported question 2: "What happens if I add StreamBox back?"', async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"] });
    const result = await interpretAndResolve({
      client,
      text: "What happens if I add StreamBox back?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "resolved");
    assert.equal(result.intent, "hypothetical_resumption");
  });

  test("paraphrase: \"What if I reactivate StreamBox?\"", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"] });
    const result = await interpretAndResolve({
      client,
      text: "What if I reactivate StreamBox?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "resolved");
  });

  test("paraphrase: \"What would happen if I turned StreamBox back on?\"", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"] });
    const result = await interpretAndResolve({
      client,
      text: "What would happen if I turned StreamBox back on?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "resolved");
  });

  test("negation: \"What if I don't unpause StreamBox?\" still resolves to the resumption flow, with negated:true", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"], negated: true });
    const result = await interpretAndResolve({
      client,
      text: "What if I don't unpause StreamBox?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "resolved");
    assert.equal(result.intent, "hypothetical_resumption");
    assert.equal(result.negated, true);
  });

  test("an actual imperative command (not hypothetical) is classified unsupported, not resumption", async () => {
    const client = stubClient({ intent: "unsupported", serviceNames: [] });
    const result = await interpretAndResolve({
      client,
      text: "Resume StreamBox now.",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "unsupported");
  });

  test("already-active subscription still resolves (category doesn't block resolution)", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"] });
    const result = await interpretAndResolve({
      client,
      text: "What if I resume StreamBox?",
      trials,
      paypalSandbox: { category: "active", serviceName: "StreamBox" },
    });
    assert.equal(result.type, "resolved");
  });

  test("an unknown/invented subscription name is rejected with reason not_found", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["Ghost Service"] });
    const result = await interpretAndResolve({
      client,
      text: "What if I resume Ghost Service?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "rejected");
    assert.equal(result.reason, "not_found");
    assert.equal(result.name, "Ghost Service");
  });

  test("unavailable PayPal data: the name can't be confirmed, rejected rather than guessed", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"] });
    const result = await interpretAndResolve({
      client,
      text: "What if I resume StreamBox?",
      trials,
      paypalSandbox: { category: "unavailable", reason: "No subscription found." },
    });
    assert.equal(result.type, "rejected");
    assert.equal(result.reason, "not_found");
  });

  test("no name given is rejected, not silently assumed", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: [] });
    const result = await interpretAndResolve({
      client,
      text: "What if I resume it?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "rejected");
    assert.equal(result.reason, "no_name");
  });

  test("a name matching a tracked trial (not the sandbox) is rejected as not_a_subscription", async () => {
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["DesignNest Demo"] });
    const result = await interpretAndResolve({
      client,
      text: "What if I resume DesignNest Demo?",
      trials,
      paypalSandbox: pausedSandbox,
    });
    assert.equal(result.type, "rejected");
    assert.equal(result.reason, "not_a_subscription");
  });
});

// Regression coverage for a follow-up question observed live: "What
// happens if I add $100?" was previously classified "unsupported" (no
// budget-change intent existed at all). The AI classification itself is
// mocked here; see the live-Ollama verification notes for the real model.
describe("interpretAndResolve: hypothetical_budget_change", () => {
  const trials = [];
  const sandbox = { category: "unavailable", reason: "x" };

  test('reported question: "What happens if I add $100?" (relative) — amount includes "$", as the real model actually returned', async () => {
    const client = stubClient({
      intent: "hypothetical_budget_change",
      serviceNames: [],
      amount: "$100",
      relative: true,
    });
    const result = await interpretAndResolve({
      client,
      text: "What happens if I add $100?",
      trials,
      paypalSandbox: sandbox,
    });
    assert.equal(result.type, "resolved");
    assert.equal(result.intent, "hypothetical_budget_change");
    assert.equal(result.amountCents, 10000);
    assert.equal(result.relative, true);
  });

  test('reported question: "What happens if I add $16 060?" — a thousands-separated amount', async () => {
    const client = stubClient({
      intent: "hypothetical_budget_change",
      serviceNames: [],
      amount: "$16 060",
      relative: true,
    });
    const result = await interpretAndResolve({
      client,
      text: "What happens if I add $16 060?",
      trials,
      paypalSandbox: sandbox,
    });
    assert.equal(result.type, "resolved");
    assert.equal(result.amountCents, 1606000);
  });

  test('paraphrase: "What if my budget were $100?" (absolute) — amount includes "$"', async () => {
    const client = stubClient({
      intent: "hypothetical_budget_change",
      serviceNames: [],
      amount: "$100",
      relative: false,
    });
    const result = await interpretAndResolve({
      client,
      text: "What if my budget were $100?",
      trials,
      paypalSandbox: sandbox,
    });
    assert.equal(result.type, "resolved");
    assert.equal(result.amountCents, 10000);
    assert.equal(result.relative, false);
  });

  test("no amount given is rejected with reason no_amount", async () => {
    const client = stubClient({ intent: "hypothetical_budget_change", serviceNames: [], amount: null, relative: false });
    const result = await interpretAndResolve({
      client,
      text: "What if I had more budget?",
      trials,
      paypalSandbox: sandbox,
    });
    assert.equal(result.type, "rejected");
    assert.equal(result.reason, "no_amount");
  });

  test("an invalid amount is rejected with reason invalid_amount", async () => {
    const client = stubClient({
      intent: "hypothetical_budget_change",
      serviceNames: [],
      amount: "lots",
      relative: false,
    });
    const result = await interpretAndResolve({
      client,
      text: "What if I had lots more budget?",
      trials,
      paypalSandbox: sandbox,
    });
    assert.equal(result.type, "rejected");
    assert.equal(result.reason, "invalid_amount");
  });

  test("a question naming a specific subscription is never classified hypothetical_budget_change", async () => {
    // Guards the "add StreamBox back" vs "add $100" distinction: the
    // resumption question must never get misrouted into budget-change
    // just because both involve the word "add".
    const client = stubClient({ intent: "hypothetical_resumption", serviceNames: ["StreamBox"], negated: false });
    const result = await interpretAndResolve({
      client,
      text: "What happens if I add StreamBox back?",
      trials,
      paypalSandbox: { category: "paused", serviceName: "StreamBox" },
    });
    assert.equal(result.intent, "hypothetical_resumption");
  });
});
