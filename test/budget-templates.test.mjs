import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildBudgetSummary } from "../public/budget-calculations.mjs";
import {
  budgetOverviewAnswer,
  compareToBudgetAnswer,
  rankRenewalsAnswer,
  hypotheticalExclusionAnswer,
  hypotheticalResumptionAnswer,
  hypotheticalResumptionRejectedAnswer,
  unsupportedAnswer,
  rejectedAnswer,
} from "../public/budget-templates.mjs";

function trial(overrides = {}) {
  return {
    id: "t1",
    serviceName: "DesignNest Demo",
    renewalPriceCents: 1499,
    billingFrequency: "monthly",
    trialEndDate: "2099-01-01",
    ...overrides,
  };
}

describe("budgetOverviewAnswer", () => {
  test("mentions the total and sandbox separation when a budget is set", () => {
    const summary = buildBudgetSummary({
      budget: { amountCents: 2000 },
      trials: [trial()],
      paypal: { summary: { status: "ACTIVE", planName: "StreamBox", recurringPrice: { value: "9.99", intervalUnit: "MONTH" } } },
    });
    const answer = budgetOverviewAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("$20.00")));
    assert.ok(answer.body.some((line) => line.includes("$14.99")));
    assert.ok(answer.body.some((line) => line.toLowerCase().includes("sandbox")));
    assert.equal(answer.includedRecords.length, 1);
  });

  test("handles an unset budget without crashing or inventing a number", () => {
    const summary = buildBudgetSummary({ budget: { amountCents: null }, trials: [], paypal: {} });
    const answer = budgetOverviewAnswer(summary);
    assert.ok(answer.body.some((line) => line.toLowerCase().includes("haven't set")));
  });
});

describe("compareToBudgetAnswer", () => {
  test("labels the comparison as tracked/planned, not bank spending", () => {
    const summary = buildBudgetSummary({ budget: { amountCents: 1000 }, trials: [trial()], paypal: {} });
    const answer = compareToBudgetAnswer(summary);
    assert.ok(answer.body.some((line) => line.toLowerCase().includes("not a record of your actual bank spending")));
  });

  test("reports 'over' correctly", () => {
    const summary = buildBudgetSummary({ budget: { amountCents: 1000 }, trials: [trial({ renewalPriceCents: 1499 })], paypal: {} });
    const answer = compareToBudgetAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("over")));
  });

  test("reports 'under' correctly", () => {
    const summary = buildBudgetSummary({ budget: { amountCents: 5000 }, trials: [trial({ renewalPriceCents: 1499 })], paypal: {} });
    const answer = compareToBudgetAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("under")));
  });
});

describe("rankRenewalsAnswer", () => {
  test("ranks trials highest-cost first", () => {
    const summary = buildBudgetSummary({
      budget: { amountCents: null },
      trials: [
        trial({ id: "a", serviceName: "Cheap", renewalPriceCents: 500 }),
        trial({ id: "b", serviceName: "Expensive", renewalPriceCents: 2500 }),
      ],
      paypal: {},
    });
    const answer = rankRenewalsAnswer(summary);
    const expensiveLine = answer.body.find((line) => line.includes("Expensive"));
    const cheapLine = answer.body.find((line) => line.includes("Cheap"));
    assert.ok(expensiveLine.startsWith("1."));
    assert.ok(cheapLine.startsWith("2."));
  });

  test("handles no tracked renewals gracefully", () => {
    const summary = buildBudgetSummary({ budget: { amountCents: null }, trials: [], paypal: {} });
    const answer = rankRenewalsAnswer(summary);
    assert.equal(answer.includedRecords.length, 0);
  });
});

describe("hypotheticalExclusionAnswer", () => {
  test("never claims a subscription was changed", () => {
    const summary = buildBudgetSummary({
      budget: { amountCents: 1000 },
      trials: [trial({ id: "a" }), trial({ id: "b", serviceName: "Other", renewalPriceCents: 500 })],
      paypal: {},
      excludeTrialIds: ["a"],
    });
    const answer = hypotheticalExclusionAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("No subscription was changed")));
    assert.ok(!answer.body.some((line) => /money saved/i.test(line)));
  });

  test("explains an already-paused sandbox record without changing totals", () => {
    const summary = buildBudgetSummary({ budget: { amountCents: null }, trials: [trial()], paypal: {} });
    const answer = hypotheticalExclusionAnswer(summary, { pausedRecordNames: ["StreamBox"] });
    assert.ok(answer.body.some((line) => line.includes("already paused")));
    assert.ok(answer.body.some((line) => line.includes("No subscription was changed")));
  });

  test("explains an active sandbox record is never part of the tracked total", () => {
    const summary = buildBudgetSummary({ budget: { amountCents: null }, trials: [trial()], paypal: {} });
    const answer = hypotheticalExclusionAnswer(summary, { activeSandboxNames: ["StreamBox"] });
    assert.ok(answer.body.some((line) => line.toLowerCase().includes("sandbox")));
  });
});

describe("hypotheticalResumptionAnswer", () => {
  function summaryWithSandbox(paypal, trials = [trial()]) {
    return buildBudgetSummary({ budget: { amountCents: null }, trials, paypal });
  }

  test("has a distinct heading from hypothetical exclusion, naming the subscription", () => {
    const summary = summaryWithSandbox({ summary: { status: "SUSPENDED", planName: "StreamBox" } });
    const answer = hypotheticalResumptionAnswer(summary);
    assert.equal(answer.headline, "Hypothetical: what if you resume StreamBox?");
    assert.notEqual(answer.headline, "Hypothetical: what if you don't renew?");
  });

  test("omits unrelated tracked trial records from a response solely about the sandbox subscription", () => {
    const summary = summaryWithSandbox(
      { summary: { status: "SUSPENDED", planName: "StreamBox" } },
      [trial({ id: "a", serviceName: "PaperNest Demo" }), trial({ id: "b", serviceName: "DesignNest Demo" })]
    );
    const answer = hypotheticalResumptionAnswer(summary);
    assert.equal(answer.includedRecords.length, 0);
    assert.equal(answer.excludedRecords.length, 0);
  });

  test("paused: preserves verified price, currency, and billing frequency", () => {
    const summary = summaryWithSandbox({
      summary: {
        status: "SUSPENDED",
        planName: "StreamBox",
        recurringPrice: { value: "12.00", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
      },
    });
    const answer = hypotheticalResumptionAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("$12.00/month") && line.includes("USD")));
  });

  test("paused: never invents a next charge date, an immediate charge, or a savings amount", () => {
    const summary = summaryWithSandbox({
      summary: {
        status: "SUSPENDED",
        planName: "StreamBox",
        recurringPrice: { value: "12.00", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
      },
    });
    const answer = hypotheticalResumptionAnswer(summary);
    const text = answer.body.join(" ");
    assert.ok(!/\bsave(d|s)?\b/i.test(text), "must not claim a savings amount");
    assert.ok(!/immediately charged|charged immediately/i.test(text), "must not claim an immediate charge");
    assert.ok(/next charge date can't currently be confirmed/i.test(text));
    assert.ok(answer.body.some((line) => line.includes("No subscription was changed")));
  });

  test("paused: with no reported price, says terms can't be verified rather than guessing", () => {
    const summary = summaryWithSandbox({ summary: { status: "SUSPENDED", planName: "StreamBox" } });
    const answer = hypotheticalResumptionAnswer(summary);
    assert.ok(answer.body.some((line) => /could not be verified/i.test(line)));
  });

  test("directs an actual resume request to the existing dashboard control", () => {
    const summary = summaryWithSandbox({ summary: { status: "SUSPENDED", planName: "StreamBox" } });
    const answer = hypotheticalResumptionAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("Resume subscription control")));
  });

  describe("negated: \"what if I DON'T resume/unpause X\"", () => {
    test("paused: explains the subscription stays paused if no action is taken", () => {
      const summary = summaryWithSandbox({
        summary: {
          status: "SUSPENDED",
          planName: "StreamBox",
          recurringPrice: { value: "12.00", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
        },
      });
      const answer = hypotheticalResumptionAnswer(summary, { negated: true });
      assert.ok(answer.body.some((line) => /stays paused/i.test(line)));
      assert.ok(answer.body.some((line) => line.includes("No subscription was changed")));
    });

    test("paused: has a distinct headline from the affirmative resumption question", () => {
      const summary = summaryWithSandbox({ summary: { status: "SUSPENDED", planName: "StreamBox" } });
      const affirmative = hypotheticalResumptionAnswer(summary, { negated: false });
      const negated = hypotheticalResumptionAnswer(summary, { negated: true });
      assert.notEqual(negated.headline, affirmative.headline);
      assert.equal(negated.headline, "Hypothetical: what if you don't resume StreamBox?");
    });

    test("paused: does NOT describe the scenario as though resumption were requested", () => {
      // The bug this guards against: a negated question getting an answer
      // that talks about "resuming it would restore billing..." as its
      // leading statement, as if the user asked the opposite question.
      const summary = summaryWithSandbox({
        summary: {
          status: "SUSPENDED",
          planName: "StreamBox",
          recurringPrice: { value: "12.00", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
        },
      });
      const answer = hypotheticalResumptionAnswer(summary, { negated: true });
      assert.ok(!answer.body.some((line) => /^resuming it would restore billing/i.test(line)));
      // It may still mention the verified plan terms for reference, but
      // only alongside the "stays paused" framing, never in place of it.
      const staysPausedIndex = answer.body.findIndex((line) => /stays paused/i.test(line));
      assert.ok(staysPausedIndex === 0 || staysPausedIndex === 1);
    });

    test("already-active: explains there's nothing being left paused", () => {
      const summary = summaryWithSandbox({
        summary: { status: "ACTIVE", planName: "StreamBox", recurringPrice: { value: "12.00", intervalUnit: "MONTH" } },
      });
      const answer = hypotheticalResumptionAnswer(summary, { negated: true });
      assert.ok(answer.body.some((line) => line.includes("already active")));
      assert.ok(answer.body.some((line) => line.includes("No subscription was changed")));
    });

    test("unavailable PayPal data: still states the scenario can't be confirmed", () => {
      const summary = summaryWithSandbox({ error: new Error("No subscription found.") });
      const answer = hypotheticalResumptionAnswer(summary, { negated: true });
      assert.ok(answer.body.some((line) => line.includes("unavailable")));
    });
  });

  test("already-active: explains there's nothing to resume, states its current price, no savings/charge invented", () => {
    const summary = summaryWithSandbox({
      summary: {
        status: "ACTIVE",
        planName: "StreamBox",
        recurringPrice: { value: "12.00", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
      },
    });
    const answer = hypotheticalResumptionAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("already active")));
    assert.ok(answer.body.some((line) => line.includes("$12.00/month")));
    assert.ok(answer.body.some((line) => line.includes("No subscription was changed")));
  });

  test("unrecognized status: states billing timing can't be confirmed", () => {
    const summary = summaryWithSandbox({ summary: { status: "EXPIRED", planName: "StreamBox" } });
    const answer = hypotheticalResumptionAnswer(summary);
    assert.ok(answer.body.some((line) => /can't be confirmed/i.test(line)));
  });

  test("unavailable PayPal data: states the scenario can't be confirmed, never assumes a status", () => {
    const summary = summaryWithSandbox({ error: new Error("No subscription found.") });
    const answer = hypotheticalResumptionAnswer(summary);
    assert.ok(answer.body.some((line) => line.includes("unavailable")));
    assert.ok(answer.body.some((line) => /can't be confirmed/i.test(line)));
  });
});

describe("hypotheticalResumptionRejectedAnswer", () => {
  test("no_name: asks the user to name a subscription", () => {
    const answer = hypotheticalResumptionRejectedAnswer("no_name");
    assert.ok(answer.body.some((line) => line.includes("Name which subscription")));
  });

  test("not_found: names the subscription that wasn't matched", () => {
    const answer = hypotheticalResumptionRejectedAnswer("not_found", { name: "Ghost Service" });
    assert.ok(answer.body.some((line) => line.includes("Ghost Service")));
  });

  test("not_a_subscription: explains a tracked trial has no pause/resume state", () => {
    const answer = hypotheticalResumptionRejectedAnswer("not_a_subscription", { name: "DesignNest Demo" });
    assert.ok(answer.body.some((line) => line.includes("DesignNest Demo") && line.includes("nothing to resume")));
  });

  test("name_collision: asks for clarification instead of guessing", () => {
    const answer = hypotheticalResumptionRejectedAnswer("name_collision", { name: "StreamBox" });
    assert.ok(answer.body.some((line) => line.includes("StreamBox")));
  });

  test("multiple_names: asks to name one subscription at a time", () => {
    const answer = hypotheticalResumptionRejectedAnswer("multiple_names");
    assert.ok(answer.body.some((line) => line.includes("one subscription at a time")));
  });
});

describe("unsupportedAnswer / rejectedAnswer", () => {
  test("unsupportedAnswer explains no actions are taken", () => {
    const answer = unsupportedAnswer();
    assert.ok(answer.body.some((line) => line.includes("can't cancel, pause, or edit")));
  });

  test("rejectedAnswer names the record that wasn't found", () => {
    const answer = rejectedAnswer(["Nope"]);
    assert.ok(answer.body.some((line) => line.includes("Nope")));
  });

  test("rejectedAnswer handles no name given", () => {
    const answer = rejectedAnswer([]);
    assert.equal(answer.body.length, 1);
  });
});
