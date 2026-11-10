import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildBudgetSummary } from "../public/budget-calculations.mjs";
import {
  budgetOverviewAnswer,
  compareToBudgetAnswer,
  rankRenewalsAnswer,
  hypotheticalExclusionAnswer,
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
