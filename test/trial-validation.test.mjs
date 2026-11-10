import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parsePriceToCents, formatCentsAsAmount, validateTrialInput } from "../public/trial-validation.mjs";

describe("parsePriceToCents", () => {
  test("parses whole dollar amounts", () => {
    assert.equal(parsePriceToCents("12"), 1200);
  });

  test("parses amounts with cents", () => {
    assert.equal(parsePriceToCents("12.99"), 1299);
  });

  test("parses a single trailing decimal digit", () => {
    assert.equal(parsePriceToCents("12.5"), 1250);
  });

  test("parses zero", () => {
    assert.equal(parsePriceToCents("0"), 0);
    assert.equal(parsePriceToCents("0.00"), 0);
  });

  test("avoids classic floating-point rounding error (0.1 + 0.2 style)", () => {
    // 19.99 cannot be represented exactly as a binary float; a naive
    // Math.round(parseFloat(x) * 100) can land on 1998 instead of 1999.
    assert.equal(parsePriceToCents("19.99"), 1999);
    assert.equal(parsePriceToCents("0.29"), 29);
    assert.equal(parsePriceToCents("1.10"), 110);
  });

  test("rejects negative amounts", () => {
    assert.equal(parsePriceToCents("-5"), null);
  });

  test("rejects more than two decimal places", () => {
    assert.equal(parsePriceToCents("12.999"), null);
  });

  test("rejects non-numeric input", () => {
    assert.equal(parsePriceToCents("abc"), null);
    assert.equal(parsePriceToCents(""), null);
    assert.equal(parsePriceToCents(undefined), null);
    assert.equal(parsePriceToCents(null), null);
  });
});

test("formatCentsAsAmount round-trips through parsePriceToCents", () => {
  for (const cents of [0, 29, 100, 1299, 1999, 123456]) {
    const formatted = formatCentsAsAmount(cents);
    assert.equal(parsePriceToCents(formatted), cents);
  }
});

function validInput(overrides = {}) {
  return {
    serviceName: "StreamBox",
    trialEndDate: "2026-12-01",
    renewalPrice: "12.99",
    currency: "USD",
    billingFrequency: "monthly",
    reminderLeadDays: 3,
    ...overrides,
  };
}

describe("validateTrialInput", () => {
  test("accepts a fully valid payload", () => {
    const result = validateTrialInput(validInput());
    assert.equal(result.valid, true);
    assert.deepEqual(result.value, {
      serviceName: "StreamBox",
      trialEndDate: "2026-12-01",
      renewalPriceCents: 1299,
      currency: "USD",
      billingFrequency: "monthly",
      reminderLeadDays: 3,
      source: "manual",
    });
  });

  test("trims the service name", () => {
    const result = validateTrialInput(validInput({ serviceName: "  StreamBox  " }));
    assert.equal(result.valid, true);
    assert.equal(result.value.serviceName, "StreamBox");
  });

  test("defaults the reminder lead time to 3 days when omitted", () => {
    const { reminderLeadDays, ...rest } = validInput();
    const result = validateTrialInput(rest);
    assert.equal(result.valid, true);
    assert.equal(result.value.reminderLeadDays, 3);
  });

  test("allows a zero renewal price", () => {
    const result = validateTrialInput(validInput({ renewalPrice: "0" }));
    assert.equal(result.valid, true);
    assert.equal(result.value.renewalPriceCents, 0);
  });

  test("allows a past trial end date", () => {
    const result = validateTrialInput(validInput({ trialEndDate: "2020-01-01" }));
    assert.equal(result.valid, true);
  });

  test("rejects a missing service name", () => {
    const result = validateTrialInput(validInput({ serviceName: "   " }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.serviceName);
  });

  test("rejects a service name longer than 100 characters", () => {
    const result = validateTrialInput(validInput({ serviceName: "x".repeat(101) }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.serviceName);
  });

  test("accepts a service name exactly 100 characters long", () => {
    const result = validateTrialInput(validInput({ serviceName: "x".repeat(100) }));
    assert.equal(result.valid, true);
  });

  test("rejects a missing trial end date", () => {
    const result = validateTrialInput(validInput({ trialEndDate: "" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.trialEndDate);
  });

  test("rejects a malformed trial end date", () => {
    const result = validateTrialInput(validInput({ trialEndDate: "12/01/2026" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.trialEndDate);
  });

  test("rejects an impossible calendar date (Feb 30)", () => {
    const result = validateTrialInput(validInput({ trialEndDate: "2026-02-30" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.trialEndDate);
  });

  test("accepts Feb 29 on a leap year", () => {
    const result = validateTrialInput(validInput({ trialEndDate: "2028-02-29" }));
    assert.equal(result.valid, true);
  });

  test("rejects Feb 29 on a non-leap year", () => {
    const result = validateTrialInput(validInput({ trialEndDate: "2026-02-29" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.trialEndDate);
  });

  test("rejects a negative renewal price", () => {
    const result = validateTrialInput(validInput({ renewalPrice: "-1" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.renewalPrice);
  });

  test("rejects an unsupported currency", () => {
    const result = validateTrialInput(validInput({ currency: "EUR" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.currency);
  });

  test("rejects an unsupported billing frequency", () => {
    const result = validateTrialInput(validInput({ billingFrequency: "weekly" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.billingFrequency);
  });

  test("rejects an unsupported reminder lead time", () => {
    const result = validateTrialInput(validInput({ reminderLeadDays: 5 }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.reminderLeadDays);
  });

  test("reports every invalid field at once", () => {
    const result = validateTrialInput({
      serviceName: "",
      trialEndDate: "not-a-date",
      renewalPrice: "-5",
      currency: "EUR",
      billingFrequency: "weekly",
      reminderLeadDays: 9,
    });
    assert.equal(result.valid, false);
    assert.deepEqual(Object.keys(result.errors).sort(), [
      "billingFrequency",
      "currency",
      "reminderLeadDays",
      "renewalPrice",
      "serviceName",
      "trialEndDate",
    ]);
  });

  test("defaults source to manual when omitted", () => {
    const result = validateTrialInput(validInput());
    assert.equal(result.valid, true);
    assert.equal(result.value.source, "manual");
  });

  test("accepts source=ai_import", () => {
    const result = validateTrialInput(validInput({ source: "ai_import" }));
    assert.equal(result.valid, true);
    assert.equal(result.value.source, "ai_import");
  });

  test("rejects an unrecognized source", () => {
    const result = validateTrialInput(validInput({ source: "scraped" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.source);
  });
});
