import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBudgetStore } from "../lib/budget-store.mjs";
import { createTrialStore } from "../lib/trial-store.mjs";
import { createTrialService } from "../lib/trial-service.mjs";
import { createBudgetService } from "../lib/budget-service.mjs";

async function withService(fn, { fetchPaypalSummary = async () => { throw new Error("No subscription found."); } } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "budget-service-test-"));
  try {
    const budgetStore = createBudgetStore(path.join(dir, "budget.json"));
    const trialService = createTrialService(createTrialStore(path.join(dir, "trials.json")));
    const service = createBudgetService({ budgetStore, trialService, fetchPaypalSummary });
    await fn({ service, trialService });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("createBudgetService: getBudget/setBudget", () => {
  test("starts unset", () =>
    withService(async ({ service }) => {
      const budget = await service.getBudget();
      assert.equal(budget.amountCents, null);
    }));

  test("setBudget persists a valid amount", () =>
    withService(async ({ service }) => {
      const budget = await service.setBudget({ amount: "25.00" });
      assert.equal(budget.amountCents, 2500);
      assert.ok(budget.updatedAt);

      const reread = await service.getBudget();
      assert.equal(reread.amountCents, 2500);
    }));

  test("setBudget rejects invalid input with fieldErrors", () =>
    withService(async ({ service }) => {
      await assert.rejects(service.setBudget({ amount: "-5" }), (error) => {
        assert.equal(error.status, 400);
        assert.ok(error.fieldErrors.amount);
        return true;
      });
    }));

  test("setBudget(null) unsets a previously set budget", () =>
    withService(async ({ service }) => {
      await service.setBudget({ amount: "25.00" });
      await service.setBudget({ amount: null });
      const budget = await service.getBudget();
      assert.equal(budget.amountCents, null);
    }));
});

describe("createBudgetService: buildSummary", () => {
  test("a failed PayPal fetch becomes 'unavailable', not zero, and the rest still works", () =>
    withService(async ({ service, trialService }) => {
      await trialService.create({
        serviceName: "DesignNest Demo",
        trialEndDate: "2099-01-01",
        renewalPrice: "14.99",
        currency: "USD",
        billingFrequency: "monthly",
      });

      const summary = await service.buildSummary();
      assert.equal(summary.paypalSandbox.category, "unavailable");
      assert.equal(summary.potentialRenewals.totalMonthlyEquivalentCents, 1499);
    }));

  test("works entirely without any AI client involved", () =>
    withService(async ({ service }) => {
      // No AI client is passed to createBudgetService at all — if this
      // throws, budget summaries would wrongly depend on Ollama.
      const summary = await service.buildSummary();
      assert.equal(summary.comparison.status, "unset");
    }));
});

describe("createBudgetService: answerQuery", () => {
  test("rejects an unsupported intent", () =>
    withService(async ({ service }) => {
      await assert.rejects(service.answerQuery({ intent: "delete_everything" }), (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, "BUDGET_UNSUPPORTED_INTENT");
        return true;
      });
    }));

  test("rejects a hypothetical exclusion with an unknown trial id", () =>
    withService(async ({ service }) => {
      await assert.rejects(
        service.answerQuery({ intent: "hypothetical_exclusion", excludeTrialIds: ["does-not-exist"] }),
        (error) => {
          assert.equal(error.status, 400);
          assert.equal(error.code, "BUDGET_UNKNOWN_RECORD");
          return true;
        }
      );
    }));

  test("hypothetical_exclusion with a real id computes a deterministic answer and mutates nothing", () =>
    withService(async ({ service, trialService }) => {
      const trial = await trialService.create({
        serviceName: "DesignNest Demo",
        trialEndDate: "2099-01-01",
        renewalPrice: "14.99",
        currency: "USD",
        billingFrequency: "monthly",
      });

      const result = await service.answerQuery({ intent: "hypothetical_exclusion", excludeTrialIds: [trial.id] });
      assert.equal(result.summary.potentialRenewals.totalMonthlyEquivalentCents, 0);
      assert.equal(result.summary.potentialRenewals.excludedItems.length, 1);

      // Storage was never touched by the hypothetical.
      const stillThere = await trialService.list();
      assert.equal(stillThere.length, 1);
      assert.equal(stillThere[0].id, trial.id);
    }));

  test("budget_overview ignores excludeTrialIds (only hypothetical_exclusion uses them)", () =>
    withService(async ({ service, trialService }) => {
      const trial = await trialService.create({
        serviceName: "DesignNest Demo",
        trialEndDate: "2099-01-01",
        renewalPrice: "14.99",
        currency: "USD",
        billingFrequency: "monthly",
      });

      const result = await service.answerQuery({ intent: "budget_overview", excludeTrialIds: [trial.id] });
      assert.equal(result.summary.potentialRenewals.items.length, 1);
    }));
});
