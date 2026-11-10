import { validateBudgetInput } from "../public/budget-validation.mjs";
import { buildBudgetSummary } from "../public/budget-calculations.mjs";
import {
  budgetOverviewAnswer,
  compareToBudgetAnswer,
  rankRenewalsAnswer,
  hypotheticalExclusionAnswer,
  hypotheticalResumptionAnswer,
} from "../public/budget-templates.mjs";

export const SUPPORTED_QUERY_INTENTS = new Set([
  "budget_overview",
  "compare_renewals_to_budget",
  "rank_renewals",
  "hypothetical_exclusion",
  "hypothetical_resumption",
]);

function invalidInputError(errors) {
  const error = new Error("Invalid budget input.");
  error.status = 400;
  error.fieldErrors = errors;
  return error;
}

function unsupportedIntentError(intent) {
  const error = new Error(`Unsupported budget query intent: "${intent}".`);
  error.status = 400;
  error.code = "BUDGET_UNSUPPORTED_INTENT";
  return error;
}

function unknownRecordError(ids) {
  const error = new Error(`Unknown tracked record id(s): ${ids.join(", ")}.`);
  error.status = 400;
  error.code = "BUDGET_UNKNOWN_RECORD";
  return error;
}

// Orchestrates the budget feature's storage + deterministic calculations.
// `fetchPaypalSummary` is injected (rather than imported directly) so this
// service never has to know how to construct a PayPal client or load demo
// state — tests can hand it a stub that resolves or rejects, exactly like
// the real one does when there is no demo subscription set up.
export function createBudgetService({ budgetStore, trialService, fetchPaypalSummary }) {
  async function getBudget() {
    return budgetStore.get();
  }

  async function setBudget(input) {
    const validation = validateBudgetInput(input);
    if (!validation.valid) {
      throw invalidInputError(validation.errors);
    }

    return budgetStore.set(() => ({
      amountCents: validation.value.amountCents,
      currency: "USD",
      updatedAt: new Date().toISOString(),
    }));
  }

  async function loadPaypalSummary() {
    try {
      const summary = await fetchPaypalSummary();
      return { summary };
    } catch (error) {
      return { error };
    }
  }

  // Builds the full deterministic summary (budget + tracked trials +
  // sandbox PayPal status). Both the no-AI /api/budget/summary route and
  // every resolved conversation answer are built from this one function,
  // so a suggested-button answer and a free-text answer about the same
  // thing always agree.
  async function buildSummary({ excludeTrialIds = [] } = {}) {
    const [budget, trials, paypal] = await Promise.all([
      budgetStore.get(),
      trialService.list(),
      loadPaypalSummary(),
    ]);
    return buildBudgetSummary({ budget, trials, paypal, excludeTrialIds });
  }

  async function validateTrialIds(ids) {
    if (ids.length === 0) return;
    const trials = await trialService.list();
    const validIds = new Set(trials.map((trial) => trial.id));
    const unknown = ids.filter((id) => !validIds.has(id));
    if (unknown.length > 0) {
      throw unknownRecordError(unknown);
    }
  }

  // The deterministic query path: no AI call, a known intent, and
  // (for hypothetical_exclusion) explicit trial ids that must already
  // exist. Used directly by the suggested-question buttons, and by the
  // AI-assisted /ask path once it has resolved free text into this same
  // shape.
  async function answerQuery({ intent, excludeTrialIds = [], paused = [], activeSandbox = [], negated = false }) {
    if (!SUPPORTED_QUERY_INTENTS.has(intent)) {
      throw unsupportedIntentError(intent);
    }

    if (intent === "hypothetical_exclusion") {
      await validateTrialIds(excludeTrialIds);
    }

    const summary = await buildSummary({
      excludeTrialIds: intent === "hypothetical_exclusion" ? excludeTrialIds : [],
    });

    let answer;
    if (intent === "budget_overview") {
      answer = budgetOverviewAnswer(summary);
    } else if (intent === "compare_renewals_to_budget") {
      answer = compareToBudgetAnswer(summary);
    } else if (intent === "rank_renewals") {
      answer = rankRenewalsAnswer(summary);
    } else if (intent === "hypothetical_resumption") {
      answer = hypotheticalResumptionAnswer(summary, { negated });
    } else {
      answer = hypotheticalExclusionAnswer(summary, {
        pausedRecordNames: paused,
        activeSandboxNames: activeSandbox,
      });
    }

    return { intent, answer, summary };
  }

  return { getBudget, setBudget, buildSummary, answerQuery };
}
