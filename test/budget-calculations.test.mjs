import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  monthlyEquivalentCents,
  totalMonthlyEquivalentCents,
  categorizeTrial,
  categorizeTrials,
  categorizePaypalSubscription,
  budgetComparison,
  buildBudgetSummary,
  formatSignedUsd,
  formatUsd,
} from "../public/budget-calculations.mjs";

function trial(overrides = {}) {
  return {
    id: "t1",
    serviceName: "StreamBox",
    renewalPriceCents: 999,
    billingFrequency: "monthly",
    trialEndDate: "2026-12-01",
    ...overrides,
  };
}

describe("monthlyEquivalentCents", () => {
  test("monthly is unchanged", () => {
    assert.equal(monthlyEquivalentCents(999, "monthly"), 999);
  });

  test("yearly divides by 12, rounded", () => {
    // 12000 / 12 = 1000 exactly
    assert.equal(monthlyEquivalentCents(12000, "yearly"), 1000);
  });

  test("yearly rounding rounds to the nearest cent", () => {
    // 10000 / 12 = 833.33... -> rounds to 833
    assert.equal(monthlyEquivalentCents(10000, "yearly"), 833);
    // 10006 / 12 = 833.8333 -> rounds to 834
    assert.equal(monthlyEquivalentCents(10006, "yearly"), 834);
  });
});

describe("totalMonthlyEquivalentCents", () => {
  test("sums monthly trials directly", () => {
    const total = totalMonthlyEquivalentCents([
      trial({ renewalPriceCents: 999, billingFrequency: "monthly" }),
      trial({ renewalPriceCents: 1499, billingFrequency: "monthly" }),
    ]);
    assert.equal(total, 2498);
  });

  test("aggregates annual cents before dividing/rounding, not per-item", () => {
    // Two annual trials at 1001 cents each: summing the RAW cents first
    // (2002) then dividing by 12 and rounding once gives 167. Rounding
    // each one individually first (1001/12 = 83.4 -> 83 twice = 166)
    // would under-count by a cent. This test locks in the sum-then-round
    // behavior documented in the source.
    const perItemRounded = Math.round(1001 / 12) * 2;
    const total = totalMonthlyEquivalentCents([
      trial({ id: "a", renewalPriceCents: 1001, billingFrequency: "yearly" }),
      trial({ id: "b", renewalPriceCents: 1001, billingFrequency: "yearly" }),
    ]);
    assert.equal(total, Math.round((1001 + 1001) / 12));
    assert.notEqual(total, perItemRounded);
  });

  test("mixes monthly and yearly trials correctly", () => {
    const total = totalMonthlyEquivalentCents([
      trial({ id: "a", renewalPriceCents: 999, billingFrequency: "monthly" }),
      trial({ id: "b", renewalPriceCents: 12000, billingFrequency: "yearly" }),
    ]);
    assert.equal(total, 999 + 1000);
  });

  test("empty list totals to zero", () => {
    assert.equal(totalMonthlyEquivalentCents([]), 0);
  });
});

describe("categorizeTrial / categorizeTrials", () => {
  test("a future trial end date is not flagged statusUnknown", () => {
    const item = categorizeTrial(trial({ trialEndDate: "2099-01-01" }), "2026-01-01");
    assert.equal(item.statusUnknown, false);
  });

  test("today's trial end date is not flagged statusUnknown (not yet passed)", () => {
    const item = categorizeTrial(trial({ trialEndDate: "2026-01-01" }), "2026-01-01");
    assert.equal(item.statusUnknown, false);
  });

  test("a past trial end date IS flagged statusUnknown, but keeps its cost", () => {
    const item = categorizeTrial(trial({ trialEndDate: "2020-01-01", renewalPriceCents: 999 }), "2026-01-01");
    assert.equal(item.statusUnknown, true);
    // Never silently assumed renewed, but also never silently dropped/zeroed.
    assert.equal(item.monthlyEquivalentCents, 999);
  });

  test("categorizeTrials uses the given `now` for every trial consistently", () => {
    const items = categorizeTrials(
      [trial({ id: "a", trialEndDate: "2026-01-01" }), trial({ id: "b", trialEndDate: "2025-01-01" })],
      new Date(2026, 0, 15)
    );
    assert.equal(items.find((i) => i.id === "a").statusUnknown, true);
    assert.equal(items.find((i) => i.id === "b").statusUnknown, true);
  });
});

describe("categorizePaypalSubscription", () => {
  test("ACTIVE status with a monthly price becomes category 'active'", () => {
    const result = categorizePaypalSubscription({
      summary: {
        status: "ACTIVE",
        planName: "StreamBox: Premium",
        recurringPrice: { value: "9.99", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
      },
    });
    assert.equal(result.category, "active");
    assert.equal(result.serviceName, "StreamBox");
    assert.equal(result.monthlyEquivalentCents, 999);
  });

  test("ACTIVE status with a yearly price converts to a monthly equivalent", () => {
    const result = categorizePaypalSubscription({
      summary: {
        status: "ACTIVE",
        planName: "StreamBox",
        recurringPrice: { value: "120.00", currencyCode: "USD", intervalUnit: "YEAR", intervalCount: 1 },
      },
    });
    assert.equal(result.monthlyEquivalentCents, 1000);
  });

  test("SUSPENDED status becomes category 'paused'", () => {
    const result = categorizePaypalSubscription({ summary: { status: "SUSPENDED", planName: "StreamBox" } });
    assert.equal(result.category, "paused");
  });

  test("SUSPENDED status still preserves the plan's verified price, currency, and billing frequency", () => {
    // A paused subscription's own plan terms don't disappear — PayPal's
    // plan endpoint reports them regardless of the subscription's status.
    const result = categorizePaypalSubscription({
      summary: {
        status: "SUSPENDED",
        planName: "StreamBox",
        recurringPrice: { value: "12.00", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
      },
    });
    assert.equal(result.category, "paused");
    assert.equal(result.renewalPriceCents, 1200);
    assert.equal(result.currency, "USD");
    assert.equal(result.billingFrequency, "monthly");
  });

  test("SUSPENDED status with no reported price omits plan terms rather than inventing them", () => {
    const result = categorizePaypalSubscription({ summary: { status: "SUSPENDED", planName: "StreamBox" } });
    assert.equal(result.renewalPriceCents, undefined);
  });

  test("an unrecognized status also preserves plan terms when PayPal reports a price", () => {
    const result = categorizePaypalSubscription({
      summary: {
        status: "EXPIRED",
        planName: "StreamBox",
        recurringPrice: { value: "12.00", currencyCode: "USD", intervalUnit: "MONTH", intervalCount: 1 },
      },
    });
    assert.equal(result.category, "unknown");
    assert.equal(result.renewalPriceCents, 1200);
  });

  test("an unrecognized status becomes category 'unknown', never silently active or zero", () => {
    const result = categorizePaypalSubscription({ summary: { status: "EXPIRED", planName: "StreamBox" } });
    assert.equal(result.category, "unknown");
    assert.ok(result.reason);
  });

  test("a fetch error becomes category 'unavailable' with the error's reason, never zero", () => {
    const result = categorizePaypalSubscription({ error: new Error("No subscription found.") });
    assert.equal(result.category, "unavailable");
    assert.equal(result.reason, "No subscription found.");
  });

  test("no data at all (neither summary nor error) is also 'unavailable'", () => {
    const result = categorizePaypalSubscription({});
    assert.equal(result.category, "unavailable");
  });
});

describe("budgetComparison", () => {
  test("no budget set -> status 'unset', no diff computed", () => {
    const result = budgetComparison(null, 5000);
    assert.equal(result.status, "unset");
    assert.equal(result.diffCents, null);
  });

  test("a $0 budget is NOT treated as unset", () => {
    const result = budgetComparison(0, 500);
    assert.equal(result.status, "over");
    assert.equal(result.diffCents, 500);
  });

  test("total under budget -> 'under' with a negative diff", () => {
    const result = budgetComparison(2000, 1500);
    assert.equal(result.status, "under");
    assert.equal(result.diffCents, -500);
  });

  test("total exactly equal to budget -> 'at'", () => {
    const result = budgetComparison(2000, 2000);
    assert.equal(result.status, "at");
    assert.equal(result.diffCents, 0);
  });
});

describe("buildBudgetSummary", () => {
  test("combines budget, trials, and paypal into one deterministic summary", () => {
    const summary = buildBudgetSummary({
      budget: { amountCents: 2000, currency: "USD" },
      trials: [trial({ id: "a", renewalPriceCents: 999 }), trial({ id: "b", renewalPriceCents: 1499 })],
      paypal: { summary: { status: "ACTIVE", planName: "StreamBox", recurringPrice: { value: "9.99", intervalUnit: "MONTH" } } },
      now: new Date(2026, 0, 1),
    });

    assert.equal(summary.potentialRenewals.totalMonthlyEquivalentCents, 2498);
    assert.equal(summary.potentialRenewals.items.length, 2);
    assert.equal(summary.paypalSandbox.category, "active");
    // Sandbox amount must never be folded into the tracked total.
    assert.equal(summary.comparison.totalCents, 2498);
    assert.equal(summary.comparison.status, "over");
  });

  test("excludeTrialIds removes a record from the total and moves it to excludedItems", () => {
    const summary = buildBudgetSummary({
      budget: { amountCents: null },
      trials: [trial({ id: "a", renewalPriceCents: 999 }), trial({ id: "b", renewalPriceCents: 1499 })],
      paypal: {},
      excludeTrialIds: ["b"],
      now: new Date(2026, 0, 1),
    });

    assert.equal(summary.potentialRenewals.totalMonthlyEquivalentCents, 999);
    assert.deepEqual(summary.potentialRenewals.items.map((i) => i.id), ["a"]);
    assert.deepEqual(summary.potentialRenewals.excludedItems.map((i) => i.id), ["b"]);
  });

  test("an unset budget distinguishes from a $0 budget", () => {
    const unset = buildBudgetSummary({ budget: { amountCents: null }, trials: [], paypal: {} });
    const zero = buildBudgetSummary({ budget: { amountCents: 0 }, trials: [], paypal: {} });
    assert.equal(unset.budget.amountCents, null);
    assert.equal(unset.comparison.status, "unset");
    assert.equal(zero.budget.amountCents, 0);
    assert.equal(zero.comparison.status, "at");
  });
});

describe("formatSignedUsd / formatUsd", () => {
  test("formats a positive amount with no sign", () => {
    assert.equal(formatUsd(1299), "$12.99");
  });

  test("formats a large negative amount with a minus sign", () => {
    assert.equal(formatSignedUsd(-150), "-$1.50");
  });

  test("formats a small negative amount (under a dollar) with a minus sign", () => {
    // Regression guard: formatCentsAsAmount(-50) alone would silently lose
    // its sign (Math.trunc(-0.5) is negative zero, which stringifies as
    // "0"), so formatSignedUsd must never pass a negative number through.
    assert.equal(formatSignedUsd(-50), "-$0.50");
  });

  test("formats zero with no sign", () => {
    assert.equal(formatSignedUsd(0), "$0.00");
  });
});
