import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { demoConfiguration } from "./lib/demo-config.mjs";

const base = process.env.PAYPAL_BASE_URL;
const clientId = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;

if (base !== "https://api-m.sandbox.paypal.com") {
  throw new Error("Sandbox URL required. Check your .env file.");
}

if (!clientId || !secret) {
  throw new Error("Missing PayPal credentials.");
}

const demo = demoConfiguration(process.argv.slice(2));
const stateFile = new URL(`./${demo.fileName}`, import.meta.url);
let state;

try {
  state = JSON.parse(await readFile(stateFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  state = {
    productRequestId: randomUUID(),
    planRequestId: randomUUID(),
  };
}

async function save() {
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

async function main() {
  state.serviceName ??= demo.name;
  await save();

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

  if (!auth.ok) {
    throw new Error(`Authentication failed: HTTP ${auth.status}`);
  }

  const { access_token } = await auth.json();
  if (!access_token) throw new Error("PayPal did not return an access token.");

  async function create(path, body, requestId) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    const data = await response.json();

    if (!response.ok) {
      const issues = (data.details ?? [])
        .map(detail => detail.issue)
        .join(", ");
      throw new Error(
        `HTTP ${response.status}: ${data.name ?? "API_ERROR"} ${issues}`
      );
    }

    if (!data.id) throw new Error("PayPal returned no resource ID.");
    return data;
  }

  if (!state.productId) {
    const product = await create(
      "/v1/catalogs/products",
      {
        name: `${demo.name} — Subscription Shield Demo`,
        description: "Fictional subscription service for sandbox testing.",
        type: "SERVICE",
        category: "SOFTWARE",
      },
      state.productRequestId
    );

    state.productId = product.id;
    await save();
  }

  if (!state.planId) {
    const plan = await create(
      "/v1/billing/plans",
      {
        product_id: state.productId,
        name: `${demo.name}: ${demo.trialDays ? `${demo.trialDays} days free, then ` : ""}USD ${demo.price} monthly`,
        status: "ACTIVE",
        billing_cycles: [
          ...(demo.trialDays ? [{
            frequency: { interval_unit: "DAY", interval_count: demo.trialDays },
            tenure_type: "TRIAL",
            sequence: 1,
            total_cycles: 1,
          }] : []),
          {
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: demo.trialDays ? 2 : 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: { value: demo.price, currency_code: "USD" },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
      },
      state.planRequestId
    );

    state.planId = plan.id;
    await save();
  }

  console.log(`SUCCESS: ${demo.name} sandbox plan is ready.`);
  console.log("Product ID:", state.productId);
  console.log("Plan ID:", state.planId);
  console.log(`Terms: ${demo.trialDays ? `${demo.trialDays} days free, then ` : ""}USD ${demo.price}/month.`);
  console.log(state.subscriptionId ? "Existing subscription preserved." : "No buyer has subscribed yet.");
}

main().catch(error => {
  console.error("SETUP FAILED:", error.message);
  process.exitCode = 1;
});
