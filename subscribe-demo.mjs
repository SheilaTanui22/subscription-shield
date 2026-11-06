import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const base = process.env.PAYPAL_BASE_URL;
const stateFile = new URL("./demo-state.json", import.meta.url);
const callback = "http://localhost:3002";

async function main() {
  if (base !== "https://api-m.sandbox.paypal.com") {
    throw new Error("Sandbox URL required.");
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  if (!state.planId) throw new Error("Run setup-demo.mjs first.");

  const save = () =>
    writeFile(stateFile, JSON.stringify(state, null, 2));

  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const auth = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20000),
  });

  if (!auth.ok) throw new Error(`Authentication: HTTP ${auth.status}`);
  const { access_token } = await auth.json();
  if (!access_token) throw new Error("No access token returned.");

  async function api(path, body, requestId) {
    const headers = {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;

    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });

    const data = await response.json();
    if (!response.ok) {
      const issues = (data.details ?? []).map(x => x.issue).join(", ");
      throw new Error(
        `HTTP ${response.status}: ${data.name ?? "API_ERROR"} ${issues}`
      );
    }
    return data;
  }

  if (!state.subscriptionId) {
    state.subscriptionRequestId ??= randomUUID();
    await save();

    const subscription = await api(
      "/v1/billing/subscriptions",
      {
        plan_id: state.planId,
        application_context: {
          brand_name: "Subscription Shield Demo",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          return_url: `${callback}/approved`,
          cancel_url: `${callback}/cancelled`,
        },
      },
      state.subscriptionRequestId
    );

    if (!subscription.id) throw new Error("No subscription ID returned.");
    state.subscriptionId = subscription.id;
    await save();
  }

  async function getSubscription() {
    return api(
      `/v1/billing/subscriptions/${encodeURIComponent(state.subscriptionId)}`
    );
  }

  function summary(subscription) {
    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      nextBillingTime:
        subscription.billing_info?.next_billing_time ?? "Not available yet",
      environment: "sandbox",
    };
  }

  const subscription = await getSubscription();
  console.log(JSON.stringify(summary(subscription), null, 2));

  const approvalUrl = subscription.links?.find(
    link => link.rel === "approve"
  )?.href;

  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");

    const path = new URL(request.url, callback).pathname;

    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Method not allowed.");
      return;
    }

    if (path === "/cancelled") {
      response.end("Checkout exited. No approval confirmed.");
      return;
    }

    if (path !== "/approved" && path !== "/status") {
      response.writeHead(404);
      response.end("Not found.");
      return;
    }

    try {
      // Verify our saved subscription with PayPal.
      // The redirect itself is not proof of approval.
      const current = await getSubscription();
      const result = JSON.stringify(summary(current), null, 2);
      console.log(result);
      response.end(result);
    } catch (error) {
      console.error(error.message);
      response.writeHead(502);
      response.end("Could not verify status. Check PowerShell.");
    }
  });

  server.on("error", error => {
    console.error("Local server:", error.message);
    process.exitCode = 1;
  });

  server.listen(3002, "127.0.0.1", () => {
    if (approvalUrl) {
      console.log("\nOpen this link to approve with your sandbox buyer:");
      console.log(approvalUrl);
    }
    console.log(`\nCheck status: ${callback}/status`);
    console.log("Leave this window running. Press Ctrl+C when finished.");
  });
}

main().catch(error => {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
});