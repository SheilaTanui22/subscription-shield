const REQUIRED_BASE_URL = "https://api-m.sandbox.paypal.com";

export function loadPayPalConfig(env = process.env) {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL } = env;

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("Missing PayPal credentials in .env");
  }

  if (PAYPAL_BASE_URL !== REQUIRED_BASE_URL) {
    throw new Error("This demo requires the PayPal sandbox URL.");
  }

  return {
    clientId: PAYPAL_CLIENT_ID,
    secret: PAYPAL_CLIENT_SECRET,
    baseUrl: PAYPAL_BASE_URL,
  };
}

export function createPayPalClient(config) {
  let cachedToken;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) {
      return cachedToken;
    }

    const credentials = Buffer.from(
      `${config.clientId}:${config.secret}`
    ).toString("base64");

    const response = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
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

  async function request(path, { method = "GET", body, requestId } = {}) {
    const token = await getToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;

    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });

    if (response.status === 204) {
      return null;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const issues = (data.details ?? []).map(detail => detail.issue).join(", ");
      const error = new Error(
        `HTTP ${response.status}: ${data.name ?? "API_ERROR"}${issues ? " " + issues : ""}`
      );
      error.status = response.status;
      throw error;
    }

    return data;
  }

  return { getToken, request };
}
