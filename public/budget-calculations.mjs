import { dateKey } from "./trial-dates.mjs";
import { formatCentsAsAmount } from "./trial-validation.mjs";

// All budget math lives here, in plain functions operating on plain data —
// never in the AI model's output. Every function is pure (no I/O, no
// "now" except as an explicit, overridable argument) so it can be unit
// tested exactly, and so the same logic runs unmodified in the browser and
// on the server (see trial-dates.mjs / trial-validation.mjs for the same
// split-by-reuse pattern).

// Monthly-equivalent cents for a single trial, for DISPLAY only ("annual
// price ÷ 12"). Rounded independently per item — see
// totalMonthlyEquivalentCents() below for why the aggregate total is
// computed differently (sum-then-round, not round-then-sum).
export function monthlyEquivalentCents(renewalPriceCents, billingFrequency) {
  if (billingFrequency === "yearly") {
    return Math.round(renewalPriceCents / 12);
  }
  return renewalPriceCents;
}

// Sums potential-renewal costs to one monthly-equivalent total. Annual
// amounts are summed BEFORE dividing by 12 and rounding once at the end,
// rather than rounding each trial's monthly-equivalent individually and
// then summing those roundings. This keeps the aggregate's rounding error
// bounded to at most half a cent regardless of how many annual trials are
// included, instead of compounding one rounding error per trial.
export function totalMonthlyEquivalentCents(trials) {
  let monthlySum = 0;
  let yearlySum = 0;
  for (const trial of trials) {
    if (trial.billingFrequency === "yearly") {
      yearlySum += trial.renewalPriceCents;
    } else {
      monthlySum += trial.renewalPriceCents;
    }
  }
  return monthlySum + Math.round(yearlySum / 12);
}

// A trial's renewal date passing tells us nothing about whether it was
// actually renewed, cancelled, or left alone — this app has no way to
// observe that. So an expired trial is never dropped from the potential
// total (that would silently understate cost) and never assumed renewed
// either; it's kept in the total and flagged `statusUnknown: true` so the
// UI can say so honestly.
export function categorizeTrial(trial, todayKey) {
  const statusUnknown = trial.trialEndDate < todayKey;
  return {
    id: trial.id,
    serviceName: trial.serviceName,
    renewalPriceCents: trial.renewalPriceCents,
    billingFrequency: trial.billingFrequency,
    trialEndDate: trial.trialEndDate,
    monthlyEquivalentCents: monthlyEquivalentCents(trial.renewalPriceCents, trial.billingFrequency),
    statusUnknown,
  };
}

export function categorizeTrials(trials, now = new Date()) {
  const todayKey = dateKey(now);
  return trials.map((trial) => categorizeTrial(trial, todayKey));
}

// Classifies the one PayPal sandbox subscription this demo tracks into
// exactly one category, from either a fetched summary or a fetch error.
// ACTIVE is "verified" by PayPal's own status field, but that is still
// never treated as proof of a completed charge — see the "sandbox" label
// callers must keep attached to this, and the fact it's never folded into
// potentialRenewalTotal. A fetch failure (no demo state, PayPal
// unreachable, etc.) becomes "unavailable" with a reason, never silently 0.
export function categorizePaypalSubscription({ summary, error } = {}) {
  if (error) {
    return { category: "unavailable", reason: error.message };
  }
  if (!summary) {
    return { category: "unavailable", reason: "No subscription data was loaded." };
  }

  const serviceName = (summary.planName ?? "StreamBox").split(":")[0].trim();

  if (summary.status === "ACTIVE") {
    const price = summary.recurringPrice;
    if (!price) {
      return { category: "unknown", serviceName, status: summary.status, reason: "No recurring price reported." };
    }
    const priceCents = Math.round(Number(price.value) * 100);
    const unit = price.intervalUnit?.toUpperCase();
    const monthlyEquivCents =
      unit === "YEAR" ? Math.round(priceCents / (12 * (price.intervalCount || 1))) : priceCents;
    return {
      category: "active",
      serviceName,
      status: summary.status,
      renewalPriceCents: priceCents,
      monthlyEquivalentCents: monthlyEquivCents,
    };
  }

  if (summary.status === "SUSPENDED") {
    return { category: "paused", serviceName, status: summary.status };
  }

  return {
    category: "unknown",
    serviceName,
    status: summary.status,
    reason: `PayPal reported status "${summary.status}", which this app does not treat as active or paused.`,
  };
}

export function budgetComparison(budgetCents, totalCents) {
  if (budgetCents === null) {
    return { status: "unset", budgetCents: null, totalCents, diffCents: null };
  }
  const diffCents = totalCents - budgetCents;
  return {
    status: diffCents > 0 ? "over" : diffCents < 0 ? "under" : "at",
    budgetCents,
    totalCents,
    diffCents,
  };
}

// Builds the full deterministic summary combining the user's budget, their
// tracked trial renewals (potential costs only), and the sandbox PayPal
// subscription (kept separate — see categorizePaypalSubscription). This is
// the one function both the no-AI /api/budget/summary route and the
// AI-assisted conversation route call to get their numbers, so suggested
// buttons and free-text questions always agree.
export function buildBudgetSummary({ budget, trials, paypal, excludeTrialIds = [], now = new Date() }) {
  const excluded = new Set(excludeTrialIds);
  const allItems = categorizeTrials(trials, now);
  const includedItems = allItems.filter((item) => !excluded.has(item.id));
  const excludedItems = allItems.filter((item) => excluded.has(item.id));

  const totalCents = totalMonthlyEquivalentCents(includedItems);
  const paypalSandbox = categorizePaypalSubscription(paypal ?? {});

  return {
    budget: { amountCents: budget?.amountCents ?? null, currency: budget?.currency ?? "USD" },
    potentialRenewals: {
      totalMonthlyEquivalentCents: totalCents,
      items: includedItems,
      excludedItems,
    },
    paypalSandbox,
    comparison: budgetComparison(budget?.amountCents ?? null, totalCents),
  };
}

// Formats a signed cents amount as "$12.99" / "-$12.99". Deliberately
// formats the absolute value and prepends the sign itself, rather than
// passing a negative number straight to formatCentsAsAmount: that helper
// computes `Math.trunc(cents / 100)`, which for small negative amounts
// (e.g. -50) truncates to -0, and `` `${-0}` `` stringifies as "0" — silently
// dropping the minus sign. Avoided entirely by never handing it a negative.
export function formatSignedUsd(cents) {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${formatCentsAsAmount(Math.abs(cents))}`;
}

export function formatUsd(cents) {
  return `$${formatCentsAsAmount(cents)}`;
}
