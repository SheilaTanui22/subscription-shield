import http from "node:http";

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_BASE_URL,
  PORT = "3001",
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  throw new Error("Missing PayPal credentials in .env");
}

if (PAYPAL_BASE_URL !== "https://api-m.sandbox.paypal.com") {
  throw new Error("This demo requires the PayPal sandbox URL.");
}

let cachedToken;
let tokenExpiresAt = 0;

async function getPayPalToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const credentials = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`PayPal authentication failed: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.access_token || !Number.isFinite(data.expires_in)) {
    throw new Error("Unexpected PayPal authentication response.");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(0, data.expires_in - 60) * 1000;
  return cachedToken;
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    if (request.url === "/api/health") {
      response.end(JSON.stringify({
        app: "Subscription Shield",
        status: "running",
      }));
      return;
    }

    if (request.url === "/api/paypal/status") {
      await getPayPalToken();
      response.end(JSON.stringify({
        paypal: "connected",
        environment: "sandbox",
      }));
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: "Route not found" }));
  } catch (error) {
    console.error(error.message);
    response.writeHead(502);
    response.end(JSON.stringify({
      error: "PayPal connection failed. Check the terminal.",
    }));
  }
});

server.listen(Number(PORT), "127.0.0.1", () => {
  console.log(`Subscription Shield: http://localhost:${PORT}/api/health`);
});