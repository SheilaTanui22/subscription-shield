import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  fetchSubscriptionSummary,
  pauseSubscription,
  resumeSubscription,
  getSubscriptionStatus,
} from "../lib/subscription-service.mjs";

const STATE = { subscriptionId: "I-FAKE123", planId: "P-FAKEPLAN" };

const PLAN = {
  id: "P-FAKEPLAN",
  name: "StreamBox: 7 days free, then USD 12 monthly",
  billing_cycles: [
    {
      tenure_type: "TRIAL",
      sequence: 1,
      total_cycles: 1,
      frequency: { interval_unit: "DAY", interval_count: 7 },
    },
    {
      tenure_type: "REGULAR",
      sequence: 2,
      total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { value: "12.00", currency_code: "USD" } },
    },
  ],
};

// A fake PayPal client whose `request` resolves from a scripted queue, so
// no network call (and no live PayPal mutation) ever happens in tests.
function fakeClient(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    request: async (path, opts = {}) => {
      calls.push({ path, method: opts.method ?? "GET", body: opts.body });
      if (queue.length === 0) throw new Error(`Unexpected PayPal call: ${path}`);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const noDelay = async () => {};

describe("fetchSubscriptionSummary", () => {
  test("reports plan details and a confirmed next billing date for an ACTIVE subscription", async () => {
    const subscription = {
      id: "I-FAKE123",
      status: "ACTIVE",
      status_update_time: "2026-01-01T00:00:00Z",
      billing_info: {
        next_billing_time: "2026-02-01T00:00:00Z",
        last_payment: { time: "2026-01-01T00:05:00Z" },
      },
    };
    const client = fakeClient([subscription, PLAN]);

    const summary = await fetchSubscriptionSummary(client, STATE);

    assert.equal(summary.status, "ACTIVE");
    assert.equal(summary.planName, PLAN.name);
    assert.deepEqual(summary.trial, { intervalUnit: "DAY", intervalCount: 7, totalCycles: 1 });
    assert.deepEqual(summary.recurringPrice, {
      value: "12.00",
      currencyCode: "USD",
      intervalUnit: "MONTH",
      intervalCount: 1,
    });
    assert.equal(summary.nextBillingTime, "2026-02-01T00:00:00Z");
    assert.equal(summary.nextBillingConfirmed, true);
  });

  test("never presents a suspended subscription as having a confirmed upcoming charge", async () => {
    const subscription = {
      id: "I-FAKE123",
      status: "SUSPENDED",
      billing_info: {
        // PayPal can still echo a stale next_billing_time while suspended.
        next_billing_time: "2026-02-01T00:00:00Z",
      },
    };
    const client = fakeClient([subscription, PLAN]);

    const summary = await fetchSubscriptionSummary(client, STATE);

    assert.equal(summary.status, "SUSPENDED");
    assert.equal(summary.nextBillingTime, null);
    assert.equal(summary.nextBillingConfirmed, false);
  });
});

describe("pauseSubscription", () => {
  test("suspends an ACTIVE subscription and verifies SUSPENDED", async () => {
    const client = fakeClient([
      { status: "ACTIVE" }, // initial status check
      null, // suspend call (204 No Content)
      { status: "SUSPENDED" }, // verification poll
    ]);

    const result = await pauseSubscription(client, STATE, { delay: noDelay });

    assert.deepEqual(result, { verified: true, status: "SUSPENDED", alreadyInState: false });
    const suspendCall = client.calls.find(c => c.path.endsWith("/suspend"));
    assert.ok(suspendCall, "expected a call to the suspend endpoint");
    assert.equal(suspendCall.method, "POST");
  });

  test("is a no-op when already SUSPENDED and does not call suspend again", async () => {
    const client = fakeClient([{ status: "SUSPENDED" }]);

    const result = await pauseSubscription(client, STATE, { delay: noDelay });

    assert.deepEqual(result, { verified: true, status: "SUSPENDED", alreadyInState: true });
    assert.equal(client.calls.filter(c => c.path.endsWith("/suspend")).length, 0);
  });

  test("refuses to pause a subscription that is not ACTIVE", async () => {
    const client = fakeClient([{ status: "APPROVAL_PENDING" }]);

    await assert.rejects(
      () => pauseSubscription(client, STATE, { delay: noDelay }),
      error => {
        assert.match(error.message, /Cannot pause/);
        assert.equal(error.status, 409);
        return true;
      }
    );
  });

  test("propagates a PayPal API failure during the suspend call", async () => {
    const apiError = new Error("HTTP 500: INTERNAL_SERVER_ERROR");
    apiError.status = 500;
    const client = fakeClient([{ status: "ACTIVE" }, apiError]);

    await assert.rejects(
      () => pauseSubscription(client, STATE, { delay: noDelay }),
      /INTERNAL_SERVER_ERROR/
    );
  });

  test("reports unverified when PayPal never confirms SUSPENDED within the retry budget", async () => {
    const client = fakeClient([
      { status: "ACTIVE" },
      null,
      { status: "ACTIVE" },
      { status: "ACTIVE" },
      { status: "ACTIVE" },
      { status: "ACTIVE" }, // final re-check after exhausting attempts
    ]);

    const result = await pauseSubscription(client, STATE, { delay: noDelay, attempts: 3 });

    assert.equal(result.verified, false);
    assert.equal(result.status, "ACTIVE");
  });
});

describe("resumeSubscription", () => {
  test("activates a SUSPENDED subscription and verifies ACTIVE", async () => {
    const client = fakeClient([
      { status: "SUSPENDED" },
      null,
      { status: "ACTIVE" },
    ]);

    const result = await resumeSubscription(client, STATE, { delay: noDelay });

    assert.deepEqual(result, { verified: true, status: "ACTIVE", alreadyInState: false });
    const activateCall = client.calls.find(c => c.path.endsWith("/activate"));
    assert.ok(activateCall, "expected a call to the activate endpoint");
  });

  test("is a no-op when already ACTIVE", async () => {
    const client = fakeClient([{ status: "ACTIVE" }]);

    const result = await resumeSubscription(client, STATE, { delay: noDelay });

    assert.deepEqual(result, { verified: true, status: "ACTIVE", alreadyInState: true });
    assert.equal(client.calls.filter(c => c.path.endsWith("/activate")).length, 0);
  });

  test("refuses to resume a subscription that is not SUSPENDED", async () => {
    const client = fakeClient([{ status: "CANCELLED" }]);

    await assert.rejects(
      () => resumeSubscription(client, STATE, { delay: noDelay }),
      error => {
        assert.match(error.message, /Cannot resume/);
        assert.equal(error.status, 409);
        return true;
      }
    );
  });

  test("propagates a PayPal API failure during the activate call", async () => {
    const apiError = new Error("HTTP 404: RESOURCE_NOT_FOUND");
    apiError.status = 404;
    const client = fakeClient([{ status: "SUSPENDED" }, apiError]);

    await assert.rejects(
      () => resumeSubscription(client, STATE, { delay: noDelay }),
      /RESOURCE_NOT_FOUND/
    );
  });

  test("reports unverified when PayPal never confirms ACTIVE within the retry budget", async () => {
    const client = fakeClient([
      { status: "SUSPENDED" },
      null,
      { status: "SUSPENDED" },
      { status: "SUSPENDED" },
      { status: "SUSPENDED" }, // final re-check after exhausting attempts
    ]);

    const result = await resumeSubscription(client, STATE, { delay: noDelay, attempts: 2 });

    assert.equal(result.verified, false);
    assert.equal(result.status, "SUSPENDED");
  });
});

test("getSubscriptionStatus returns the raw status field", async () => {
  const client = fakeClient([{ status: "ACTIVE" }]);
  const status = await getSubscriptionStatus(client, STATE);
  assert.equal(status, "ACTIVE");
});
