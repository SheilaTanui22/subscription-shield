const MAX_SERVICE_NAME_LENGTH = 100;
const VALID_FREQUENCIES = new Set(["monthly", "yearly"]);
const VALID_REMINDER_DAYS = new Set([1, 3, 7]);
const VALID_SOURCES = new Set(["manual", "ai_import"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;

function isValidCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  // Days-in-month computed from UTC parts only (no local-timezone
  // involvement), so this check can't drift with the server's timezone.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

// Converts a user-entered dollar amount ("12", "12.5", "12.99") to integer
// cents using string/BigInt arithmetic only — no floating-point math is
// involved, so there is no risk of 0.1 + 0.2-style rounding error.
export function parsePriceToCents(input) {
  let text = input;
  if (typeof text === "number") {
    if (!Number.isFinite(text)) return null;
    text = String(text);
  }
  if (typeof text !== "string") return null;

  const trimmed = text.trim();
  if (!PRICE_PATTERN.test(trimmed)) return null;

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const centsText = fractionPart.padEnd(2, "0");
  const totalCents = BigInt(wholePart) * 100n + BigInt(centsText || "0");

  if (totalCents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(totalCents);
}

export function formatCentsAsAmount(cents) {
  const whole = Math.trunc(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `${whole}.${String(remainder).padStart(2, "0")}`;
}

export function validateTrialInput(input = {}) {
  const errors = {};

  const serviceName = typeof input.serviceName === "string" ? input.serviceName.trim() : "";
  if (!serviceName) {
    errors.serviceName = "Service name is required.";
  } else if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
    errors.serviceName = `Service name must be ${MAX_SERVICE_NAME_LENGTH} characters or fewer.`;
  }

  const trialEndDate = typeof input.trialEndDate === "string" ? input.trialEndDate.trim() : "";
  if (!trialEndDate || !isValidCalendarDate(trialEndDate)) {
    errors.trialEndDate = "Enter a valid trial end date.";
  }

  const renewalPriceCents = parsePriceToCents(input.renewalPrice);
  if (renewalPriceCents === null || renewalPriceCents < 0) {
    errors.renewalPrice = "Enter a renewal price of 0 or more, with up to 2 decimal places.";
  }

  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (currency !== "USD") {
    errors.currency = "Only USD is supported in this version.";
  }

  const billingFrequency =
    typeof input.billingFrequency === "string" ? input.billingFrequency.trim().toLowerCase() : "";
  if (!VALID_FREQUENCIES.has(billingFrequency)) {
    errors.billingFrequency = "Choose monthly or yearly billing.";
  }

  let reminderLeadDays = input.reminderLeadDays;
  if (reminderLeadDays === undefined || reminderLeadDays === null || reminderLeadDays === "") {
    reminderLeadDays = 3;
  } else {
    reminderLeadDays = Number(reminderLeadDays);
  }
  if (!VALID_REMINDER_DAYS.has(reminderLeadDays)) {
    errors.reminderLeadDays = "Reminder lead time must be 1, 3, or 7 days.";
  }

  let source = input.source;
  if (source === undefined || source === null || source === "") {
    source = "manual";
  }
  if (!VALID_SOURCES.has(source)) {
    errors.source = "Unrecognized trial source.";
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      serviceName,
      trialEndDate,
      renewalPriceCents,
      currency,
      billingFrequency,
      reminderLeadDays,
      source,
    },
  };
}
