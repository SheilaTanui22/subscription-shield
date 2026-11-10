// Pure calendar-day date helpers for manually tracked trials. No DOM
// dependencies, so this module is imported verbatim by both the browser
// (public/app.mjs) and the Node test suite — one implementation, one set of
// rules for "how many days remain."

// Parses a "YYYY-MM-DD" calendar date into a local-midnight Date. Using the
// local Date constructor (not `new Date("YYYY-MM-DD")`, which parses as UTC
// midnight) avoids the displayed date silently shifting by a day in
// timezones behind UTC.
export function parseCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Adds (or, with a negative count, subtracts) whole calendar days to a
// "YYYY-MM-DD" string or local-midnight Date, returning a local-midnight
// Date. Relies on the Date constructor's own day-overflow normalization
// (e.g. day 0 of a month rolls back into the previous month), so month and
// year boundaries are handled correctly without any special-casing.
export function addDays(dateInput, days) {
  const date = typeof dateInput === "string" ? parseCalendarDate(dateInput) : dateInput;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Whole calendar days between two local-midnight dates. Rounds rather than
// truncates so a 23- or 25-hour daylight-saving transition day still counts
// as exactly one calendar day, not zero.
export function daysBetween(from, to) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / msPerDay);
}

export function daysRemaining(trialEndDate, now = new Date()) {
  return daysBetween(startOfToday(now), parseCalendarDate(trialEndDate));
}

export function trialStatus(trial, now = new Date()) {
  const days = daysRemaining(trial.trialEndDate, now);
  if (days < 0) return { kind: "passed", days };
  if (days === 0) return { kind: "today", days };
  if (days <= trial.reminderLeadDays) return { kind: "soon", days };
  return { kind: "normal", days };
}

export function isDueForReminder(trial, now = new Date()) {
  const kind = trialStatus(trial, now).kind;
  return kind === "soon" || kind === "today";
}
