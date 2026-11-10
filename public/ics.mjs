// Pure .ics (RFC 5545) generation for trial calendar reminders. No DOM
// dependencies, so this module is used as-is by the browser and imported
// directly by the Node test suite.

const CRLF = "\r\n";
const PRODID = "-//Subscription Shield//Trial Reminder//EN";

// Escapes a TEXT property value per RFC 5545 §3.3.11: backslash,
// semicolon, and comma are backslash-escaped, and any literal newline
// becomes the two-character sequence "\n". Order matters — backslashes
// must be escaped first, or the backslashes introduced by the later
// replacements would themselves get doubled.
//
// This is also the injection defense: a crafted service name containing a
// real newline (or "BEGIN:VEVENT", a colon, etc.) can never reach the
// output as an actual line break or unescaped structural character, so it
// can't break out of this property's value onto a new physical ICS line.
export function escapeICSText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Folds one logical content line to <=75 octets per physical line (RFC
// 5545 §3.1), continuation lines prefixed with a single space. Splits on
// UTF-8 byte boundaries without cutting a multi-byte character in half.
export function foldICSLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const chunks = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end > start + 1 && (bytes[end] & 0xc0) === 0x80) {
      end -= 1; // back off a UTF-8 continuation byte rather than split it
    }
    chunks.push(bytes.slice(start, end));
    start = end;
    limit = 74; // continuation lines reserve 1 octet for the leading space
  }

  const decoder = new TextDecoder();
  return chunks.map((chunk, i) => (i === 0 ? decoder.decode(chunk) : " " + decoder.decode(chunk))).join(CRLF);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Formats a Date as a UTC timestamp per RFC 5545 (YYYYMMDDTHHMMSSZ). The
// caller is responsible for the Date already representing the correct
// instant — this just serializes it.
export function formatUTCStamp(date) {
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const s = pad2(date.getUTCSeconds());
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

// Produces a filesystem/download-safe filename stem from arbitrary text:
// keeps letters, digits, spaces, hyphens, and underscores; collapses
// everything else (path separators, control characters, quotes, ...) to a
// hyphen. Never returns an empty string.
export function sanitizeFilename(text, { maxLength = 60, fallback = "trial-reminder" } = {}) {
  const cleaned = String(text ?? "")
    .replace(/[^\p{L}\p{N} _-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_\s]+|[-_\s]+$/g, "")
    .trim();
  const base = cleaned.length > 0 ? cleaned : fallback;
  return base.slice(0, maxLength) || fallback;
}

// Whether a candidate reminder instant is strictly after "now" — the only
// condition under which a reminder may be downloaded. A reminder exactly
// equal to "now" counts as past (a calendar alert for the current instant
// is meaningless by the time the file is opened).
export function isReminderInFuture(reminderAt, now = new Date()) {
  return reminderAt instanceof Date && !Number.isNaN(reminderAt.getTime()) && reminderAt.getTime() > now.getTime();
}

function formatMoney(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

// Builds a single-event .ics calendar file for a trial renewal reminder.
//
//   trial: { id, serviceName, trialEndDate (YYYY-MM-DD), renewalPriceCents,
//            currency, billingFrequency }
//   reminderAt: a Date for the exact instant the alarm should fire —
//     already correctly resolved from the user's locally-chosen date/time
//     (the caller constructs this with the local Date constructor, so the
//     browser's own timezone/DST rules apply automatically).
//   now: a Date used for DTSTAMP (defaults to the current time).
//
// Returns the full .ics file content, CRLF line endings throughout,
// trailing CRLF included.
export function buildTrialReminderICS(trial, reminderAt, now = new Date()) {
  const uid = `trial-${trial.id}@subscription-shield.local`;
  const dtstamp = formatUTCStamp(now);
  const dtstart = formatUTCStamp(reminderAt);
  const dtend = formatUTCStamp(new Date(reminderAt.getTime() + 15 * 60 * 1000));

  const summary = `Review ${trial.serviceName} trial`;
  const frequencyLabel = trial.billingFrequency === "yearly" ? "year" : "month";
  const renewal = `${formatMoney(trial.renewalPriceCents, trial.currency)} / ${frequencyLabel}`;

  const description = [
    `Service: ${trial.serviceName}`,
    `Recorded trial end date: ${trial.trialEndDate}`,
    `Renewal terms (as recorded in Subscription Shield): ${renewal}`,
    "",
    "Note: this reminder time was chosen by you and is not a verified billing time from the provider.",
    "",
    "This is a one-time snapshot. Editing or deleting the trial in Subscription Shield will not update or remove this calendar event.",
  ].join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeICSText(summary)}`,
    `DESCRIPTION:${escapeICSText(description)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeICSText(summary)}`,
    "TRIGGER:PT0S",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.map(foldICSLine).join(CRLF) + CRLF;
}
