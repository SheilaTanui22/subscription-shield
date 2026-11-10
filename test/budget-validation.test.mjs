import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateBudgetInput } from "../public/budget-validation.mjs";

describe("validateBudgetInput", () => {
  test("null amount means unset", () => {
    const result = validateBudgetInput({ amount: null });
    assert.equal(result.valid, true);
    assert.equal(result.value.amountCents, null);
  });

  test("omitted amount also means unset", () => {
    const result = validateBudgetInput({});
    assert.equal(result.valid, true);
    assert.equal(result.value.amountCents, null);
  });

  test("empty string also means unset", () => {
    const result = validateBudgetInput({ amount: "" });
    assert.equal(result.valid, true);
    assert.equal(result.value.amountCents, null);
  });

  test("a $0 budget is valid and distinct from unset", () => {
    const result = validateBudgetInput({ amount: "0" });
    assert.equal(result.valid, true);
    assert.equal(result.value.amountCents, 0);
  });

  test("parses a whole-dollar amount using exact-cents parsing", () => {
    const result = validateBudgetInput({ amount: "50" });
    assert.equal(result.value.amountCents, 5000);
  });

  test("parses an amount with cents", () => {
    const result = validateBudgetInput({ amount: "49.99" });
    assert.equal(result.value.amountCents, 4999);
  });

  test("rejects a negative amount", () => {
    const result = validateBudgetInput({ amount: "-10" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.amount);
  });

  test("rejects more than two decimal places", () => {
    const result = validateBudgetInput({ amount: "10.999" });
    assert.equal(result.valid, false);
  });

  test("rejects non-numeric input", () => {
    const result = validateBudgetInput({ amount: "lots" });
    assert.equal(result.valid, false);
  });
});
