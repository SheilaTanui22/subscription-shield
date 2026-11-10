import { formatUsd, formatSignedUsd } from "./budget-calculations.mjs";

// Deterministic, template-rendered answers for the budget conversation.
// Every number here comes from the already-computed `summary` (see
// buildBudgetSummary in budget-calculations.mjs) — nothing in this file
// calls the AI model, so the model can never fabricate an amount, a
// savings figure, or a billing status. The model's only job (see
// lib/budget-conversation.mjs) is picking which of these functions to call
// and which record names it applies to.

function recordLabel(item) {
  const unitNote = item.billingFrequency === "yearly" ? "annual price ÷ 12" : "monthly";
  const base = `${item.serviceName} — ${formatUsd(item.monthlyEquivalentCents)}/mo (${unitNote})`;
  return item.statusUnknown
    ? `${base} — trial end date has passed; renewal status unknown, so this is still counted as a potential cost`
    : base;
}

function toRecordRow(item) {
  return {
    id: item.id,
    serviceName: item.serviceName,
    label: recordLabel(item),
    monthlyEquivalentCents: item.monthlyEquivalentCents,
    statusUnknown: Boolean(item.statusUnknown),
  };
}

export function sandboxNote(paypalSandbox) {
  if (paypalSandbox.category === "active") {
    return `Your PayPal sandbox subscription (${paypalSandbox.serviceName}) is active at ${formatUsd(
      paypalSandbox.monthlyEquivalentCents
    )}/mo, but this is sandbox/demo data, not a real charge, so it is not part of your tracked-potential-cost total below.`;
  }
  if (paypalSandbox.category === "paused") {
    return `Your PayPal sandbox subscription (${paypalSandbox.serviceName}) is currently paused, so it is excluded from any active-plan total and was never part of your tracked-potential-cost total below.`;
  }
  if (paypalSandbox.category === "unknown") {
    return `Your PayPal sandbox subscription (${paypalSandbox.serviceName}) reported an unrecognized status ("${paypalSandbox.status}"); it is treated as unavailable rather than assumed to be $0.`;
  }
  return `PayPal sandbox subscription data is currently unavailable (${paypalSandbox.reason}); it is treated as unavailable rather than assumed to be $0.`;
}

function budgetLine(summary) {
  if (summary.comparison.status === "unset") {
    return "You haven't set a monthly budget yet, so there's nothing to compare against — only the tracked total below.";
  }
  return `Your monthly budget is ${formatUsd(summary.comparison.budgetCents)}.`;
}

export function budgetOverviewAnswer(summary) {
  const items = summary.potentialRenewals.items;
  const total = summary.potentialRenewals.totalMonthlyEquivalentCents;

  const body = [
    budgetLine(summary),
    items.length === 0
      ? "You have no tracked trial renewals right now, so your tracked potential cost is $0.00/mo."
      : `Across ${items.length} tracked record${items.length === 1 ? "" : "s"}, your tracked potential cost is ${formatUsd(
          total
        )}/mo. These are planned/potential costs from trial records you've added — not a record of actual bank spending.`,
    sandboxNote(summary.paypalSandbox),
  ];

  if (summary.comparison.status === "over") {
    body.push(`That's ${formatSignedUsd(summary.comparison.diffCents)} over your budget.`);
  } else if (summary.comparison.status === "under") {
    body.push(`That's ${formatSignedUsd(summary.comparison.diffCents)} under your budget (${formatUsd(
      Math.abs(summary.comparison.diffCents)
    )} of headroom).`);
  } else if (summary.comparison.status === "at") {
    body.push("That matches your budget exactly.");
  }

  return {
    headline: "Budget overview",
    body,
    includedRecords: items.map(toRecordRow),
    excludedRecords: [],
  };
}

export function compareToBudgetAnswer(summary) {
  const items = summary.potentialRenewals.items;
  const total = summary.potentialRenewals.totalMonthlyEquivalentCents;
  const body = [budgetLine(summary)];

  if (summary.comparison.status === "unset") {
    body.push(
      `Your tracked potential cost is ${formatUsd(total)}/mo across ${items.length} record${
        items.length === 1 ? "" : "s"
      }. Set a budget above to see a comparison.`
    );
  } else if (summary.comparison.status === "over") {
    body.push(
      `Your tracked potential cost is ${formatUsd(total)}/mo, which is ${formatSignedUsd(
        summary.comparison.diffCents
      )} over your budget.`
    );
  } else if (summary.comparison.status === "under") {
    body.push(
      `Your tracked potential cost is ${formatUsd(total)}/mo, which is ${formatUsd(
        Math.abs(summary.comparison.diffCents)
      )} under your budget.`
    );
  } else {
    body.push(`Your tracked potential cost is ${formatUsd(total)}/mo, which matches your budget exactly.`);
  }

  body.push(
    "This compares tracked/planned subscription costs only — it is not a record of your actual bank spending and does not include the sandbox PayPal demo subscription."
  );

  return {
    headline: "Tracked subscriptions vs. budget",
    body,
    includedRecords: items.map(toRecordRow),
    excludedRecords: [],
  };
}

export function rankRenewalsAnswer(summary) {
  const items = [...summary.potentialRenewals.items].sort(
    (a, b) => b.monthlyEquivalentCents - a.monthlyEquivalentCents
  );

  if (items.length === 0) {
    return {
      headline: "Potential renewals, ranked",
      body: ["You have no tracked trial renewals to rank yet."],
      includedRecords: [],
      excludedRecords: [],
    };
  }

  const body = [
    `Ranked by monthly-equivalent cost, highest first, across ${items.length} tracked record${
      items.length === 1 ? "" : "s"
    }:`,
    ...items.map((item, index) => `${index + 1}. ${recordLabel(item)}`),
  ];

  return {
    headline: "Potential renewals, ranked",
    body,
    includedRecords: items.map(toRecordRow),
    excludedRecords: [],
  };
}

// `pausedRecordNames` / `activeSandboxNames` are names the user asked to
// exclude that turned out to resolve to the PayPal sandbox subscription
// rather than a tracked trial — those get a different, honest answer since
// this app never mixes sandbox amounts into the tracked total, and never
// changes a subscription from a hypothetical question.
export function hypotheticalExclusionAnswer(summary, { pausedRecordNames = [], activeSandboxNames = [] } = {}) {
  const items = summary.potentialRenewals.items;
  const excluded = summary.potentialRenewals.excludedItems;
  const total = summary.potentialRenewals.totalMonthlyEquivalentCents;

  const body = [];

  for (const name of pausedRecordNames) {
    body.push(
      `"${name}" is your PayPal sandbox subscription and is already paused, so it's already excluded from the active-plan total. No subscription was changed.`
    );
  }
  for (const name of activeSandboxNames) {
    body.push(
      `"${name}" is your PayPal sandbox subscription, which is never part of your tracked potential-cost total (sandbox amounts are kept separate from tracked/planned costs). Excluding it hypothetically doesn't change the number below. No subscription was changed.`
    );
  }

  if (excluded.length > 0) {
    const withTotal = formatUsd(totalMonthlyEquivalentCentsOf(items) + totalMonthlyEquivalentCentsOf(excluded));
    body.push(
      `Excluding ${excluded.map((item) => `"${item.serviceName}"`).join(", ")}, your tracked potential cost would be ${formatUsd(
        total
      )}/mo instead of ${withTotal}/mo. No subscription was changed — this is a hypothetical comparison only.`
    );
    if (summary.comparison.status !== "unset") {
      body.push(
        summary.comparison.status === "over"
          ? `That would still be ${formatSignedUsd(summary.comparison.diffCents)} over your budget.`
          : summary.comparison.status === "under"
            ? `That would be ${formatUsd(Math.abs(summary.comparison.diffCents))} under your budget.`
            : "That would match your budget exactly."
      );
    }
  } else if (pausedRecordNames.length === 0 && activeSandboxNames.length === 0) {
    body.push("No matching tracked record was excluded, so your tracked potential cost is unchanged.");
  }

  return {
    headline: "Hypothetical: what if you don't renew?",
    body,
    includedRecords: items.map(toRecordRow),
    excludedRecords: excluded.map(toRecordRow),
  };
}

function totalMonthlyEquivalentCentsOf(items) {
  return items.reduce((sum, item) => sum + item.monthlyEquivalentCents, 0);
}

// Covers two cases the model can't reliably tell apart (and doesn't need
// to — both get the same honest answer): a request to actually cancel or
// pause something, and any other question outside the 4 supported intents.
export function unsupportedAnswer() {
  return {
    headline: "This chat doesn't make changes",
    body: [
      "This conversation only calculates and explains numbers — it can't cancel, pause, or edit any subscription. Use the existing PayPal pause/resume controls on the dashboard for supported sandbox actions.",
      "It also only supports: a budget overview, comparing potential renewals with your budget, ranking potential renewal costs, and hypothetical \"what if I don't renew X\" questions. Try one of the suggested questions, or rephrase using one of those.",
    ],
    includedRecords: [],
    excludedRecords: [],
  };
}

export function rejectedAnswer(notFoundNames = []) {
  return {
    headline: "I couldn't match that to a tracked record",
    body:
      notFoundNames.length > 0
        ? [
            `No tracked record was found named ${notFoundNames.map((name) => `"${name}"`).join(", ")}. Check the spelling, or add it as a trial first.`,
          ]
        : ["Name which tracked record you mean (e.g. \"What if I don't renew DesignNest Demo?\")."],
    includedRecords: [],
    excludedRecords: [],
  };
}
