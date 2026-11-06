import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const base = process.env.PAYPAL_BASE_URL;
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (base !== "https://api-m.sandbox.paypal.com") {
    throw new Error("Sandbox URL required.");
  }
  if (!clientId || !secret) {
    throw new Error("Missing PayPal credentials.");
  }

  const state = JSON.parse(
    await readFile(new URL("./demo-state.json", import.meta.url), "utf8")
  );

  if (!state.subscriptionId) {
    throw new Error("No saved subscription found.");
  }

  const auth = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${clientId}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20000),
  });

  if (!auth.ok) throw new Error(`Authentication: HTTP ${auth.status}`);
  const { access_token } = await auth.json();
  if (!access_token) throw new Error("No access token returned.");

  const url =
    `${base}/v1/billing/subscriptions/` +
    encodeURIComponent(state.subscriptionId);

  const headers = {
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
  };

  async function getStatus() {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new Error(`Status check: HTTP ${response.status}`);
    }
    return (await response.json()).status;
  }

  const before = await getStatus();
  console.log("Subscription:", state.subscriptionId);
  console.log("Before:", before);

  if (before === "SUSPENDED") {
    console.log("Already suspended. No change needed.");
    return;
  }

  if (before !== "ACTIVE") {
    throw new Error(`Cannot pause a subscription with status ${before}.`);
  }

  const response = await fetch(`${url}/suspend`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      reason: "User requested pause through Subscription Shield sandbox demo.",
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      `Pause failed: HTTP ${response.status} ${data.name ?? ""}`
    );
  }

  // Successful suspension returns no JSON body.
  console.log("PayPal accepted the pause request.");

  for (let attempt = 0; attempt < 5; attempt++) {
    const after = await getStatus();
    if (after === "SUSPENDED") {
      console.log("After:", after);
      console.log("SUCCESS: Pause verified with PayPal.");
      return;
    }
    await delay(1500);
  }

  console.log("Pause accepted, but SUSPENDED is not yet confirmed.");
  console.log("Refresh your subscription status page to check again.");
}

main().catch(error => {
  console.error("ERROR:", error.message);
  process.exitCode = 1;
});