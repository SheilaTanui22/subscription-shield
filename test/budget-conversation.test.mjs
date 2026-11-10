import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  interpretQuestion,
  resolveServiceNames,
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
