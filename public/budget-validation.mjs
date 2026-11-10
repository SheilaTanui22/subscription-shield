import { parsePriceToCents } from "./trial-validation.mjs";

// Validates a budget update. Distinguishes "unset" (amount: null) from a
// valid $0 budget (amount: "0") — both are legal, but they mean different
// things downstream (no comparison vs. "I want to spend nothing").
export function validateBudgetInput(input = {}) {
  if (input.amount === null || input.amount === undefined || input.amount === "") {
    return { valid: true, value: { amountCents: null } };
  }

  const amountCents = parsePriceToCents(input.amount);
  if (amountCents === null || amountCents < 0) {
    return {
      valid: false,
      errors: { amount: "Enter a budget of 0 or more, with up to 2 decimal places." },
    };
  }

  return { valid: true, value: { amountCents } };
}
