import { readFile } from "node:fs/promises";

export async function loadDemoState(stateFileUrl) {
  let raw;
  try {
    raw = await readFile(stateFileUrl, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const notFound = new Error(
        "No subscription found. Run setup-demo.mjs and subscribe-demo.mjs first."
      );
      notFound.status = 404;
      throw notFound;
    }
    throw error;
  }

  const state = JSON.parse(raw);

  if (!state.subscriptionId || !state.planId) {
    const notFound = new Error(
      "No subscription found. Run setup-demo.mjs and subscribe-demo.mjs first."
    );
    notFound.status = 404;
    throw notFound;
  }

  return state;
}

function buildTrialTerms(plan) {
  const trialCycle = plan.billing_cycles?.find(cycle => cycle.tenure_type === "TRIAL");
  if (!trialCycle) return null;

  return {
    intervalUnit: trialCycle.frequency?.interval_unit ?? null,
    intervalCount: trialCycle.frequency?.interval_count ?? null,
    totalCycles: trialCycle.total_cycles ?? null,
  };
}

function buildRecurringPrice(plan) {
  const regularCycle = plan.billing_cycles?.find(cycle => cycle.tenure_type === "REGULAR");
  const pricing = regularCycle?.pricing_scheme?.fixed_price;
  if (!pricing) return null;

  return {
    value: pricing.value,
    currencyCode: pricing.currency_code,
    intervalUnit: regularCycle.frequency?.interval_unit ?? null,
    intervalCount: regularCycle.frequency?.interval_count ?? null,
  };
}

function subscriptionPath(subscriptionId) {
  return `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`;
}

export async function getSubscriptionStatus(client, state) {
  const subscription = await client.request(subscriptionPath(state.subscriptionId));
  return subscription.status;
}

export async function fetchSubscriptionSummary(client, state) {
  const subscription = await client.request(subscriptionPath(state.subscriptionId));
  const plan = await client.request(
    `/v1/billing/plans/${encodeURIComponent(state.planId)}`
  );

  const status = subscription.status;
  const isActive = status === "ACTIVE";
  const nextBillingTime = subscription.billing_info?.next_billing_time ?? null;

  return {
    subscriptionId: subscription.id,
    status,
    statusUpdateTime: subscription.status_update_time ?? null,
    planId: plan.id,
    planName: plan.name ?? null,
    trial: buildTrialTerms(plan),
    recurringPrice: buildRecurringPrice(plan),
    // A suspended (or otherwise non-active) subscription will not actually be
    // billed on the date PayPal last reported, so only surface it as a
    // confirmed upcoming charge while the subscription is ACTIVE.
    nextBillingTime: isActive ? nextBillingTime : null,
    nextBillingConfirmed: isActive && Boolean(nextBillingTime),
    lastPaymentTime: subscription.billing_info?.last_payment?.time ?? null,
    environment: "sandbox",
    fetchedAt: new Date().toISOString(),
  };
}

async function transitionSubscription(
  client,
  state,
  {
    fromStatus,
    toStatus,
    action,
    verb,
    reason,
    delay,
    attempts = 5,
    intervalMs = 1500,
  }
) {
  const before = await getSubscriptionStatus(client, state);

  if (before === toStatus) {
    return { verified: true, status: before, alreadyInState: true };
  }

  if (before !== fromStatus) {
    const error = new Error(
      `Cannot ${verb} a subscription with status ${before}.`
    );
    error.status = 409;
    throw error;
  }

  await client.request(`${subscriptionPath(state.subscriptionId)}/${action}`, {
    method: "POST",
    body: { reason },
  });

  for (let attempt = 0; attempt < attempts; attempt++) {
    const after = await getSubscriptionStatus(client, state);
    if (after === toStatus) {
      return { verified: true, status: after, alreadyInState: false };
    }
    if (attempt < attempts - 1) {
      await delay(intervalMs);
    }
  }

  const latest = await getSubscriptionStatus(client, state);
  return { verified: false, status: latest, alreadyInState: false };
}

export function pauseSubscription(client, state, options = {}) {
  return transitionSubscription(client, state, {
    fromStatus: "ACTIVE",
    toStatus: "SUSPENDED",
    action: "suspend",
    verb: "pause",
    reason:
      options.reason ??
      "User requested pause through Subscription Shield dashboard.",
    delay: options.delay,
    attempts: options.attempts,
    intervalMs: options.intervalMs,
  });
}

export function resumeSubscription(client, state, options = {}) {
  return transitionSubscription(client, state, {
    fromStatus: "SUSPENDED",
    toStatus: "ACTIVE",
    action: "activate",
    verb: "resume",
    reason:
      options.reason ??
      "User requested resume through Subscription Shield dashboard.",
    delay: options.delay,
    attempts: options.attempts,
    intervalMs: options.intervalMs,
  });
}
