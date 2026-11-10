import { test } from "node:test";
import assert from "node:assert/strict";

import { isTrustedOrigin } from "../lib/http-security.mjs";

const target = { host: "127.0.0.1", port: "3001" };

test("accepts a matching 127.0.0.1 origin", () => {
  const request = { headers: { origin: "http://127.0.0.1:3001" } };
  assert.equal(isTrustedOrigin(request, target), true);
});

test("accepts a matching localhost origin", () => {
  const request = { headers: { origin: "http://localhost:3001" } };
  assert.equal(isTrustedOrigin(request, target), true);
});

test("rejects a different origin", () => {
  const request = { headers: { origin: "http://evil.example.com" } };
  assert.equal(isTrustedOrigin(request, target), false);
});

test("rejects a mismatched port", () => {
  const request = { headers: { origin: "http://127.0.0.1:9999" } };
  assert.equal(isTrustedOrigin(request, target), false);
});

test("rejects a missing Origin header", () => {
  const request = { headers: {} };
  assert.equal(isTrustedOrigin(request, target), false);
});
