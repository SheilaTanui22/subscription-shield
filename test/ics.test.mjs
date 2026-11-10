import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  escapeICSText,
  foldICSLine,
  formatUTCStamp,
  sanitizeFilename,
  isReminderInFuture,
  buildTrialReminderICS,
} from "../public/ics.mjs";

function sampleTrial(overrides = {}) {
  return {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    serviceName: "StreamBox",
    trialEndDate: "2026-12-01",
    renewalPriceCents: 999,
    currency: "USD",
    billingFrequency: "monthly",
    ...overrides,
  };
}

describe("escapeICSText", () => {
  test("escapes backslash, semicolon, and comma", () => {
    assert.equal(escapeICSText("a\\b;c,d"), "a\\\\b\\;c\\,d");
  });

  test("escapes a literal newline to the two-character \\n sequence", () => {
    assert.equal(escapeICSText("line one\nline two"), "line one\\nline two");
  });

  test("escapes CRLF and bare CR the same as LF", () => {
    assert.equal(escapeICSText("a\r\nb"), "a\\nb");
    assert.equal(escapeICSText("a\rb"), "a\\nb");
  });

  test("backslashes are escaped before the newline substitution runs (no double-escaping)", () => {
    // A literal backslash-n in the input must stay distinguishable from an
    // escaped real newline: "\\n" -> "\\\\n", not "\\n" colliding with a
    // genuine newline's escape.
    assert.equal(escapeICSText("a\\nb"), "a\\\\nb");
  });

  test("null/undefined become an empty string, not the literal word", () => {
    assert.equal(escapeICSText(null), "");
    assert.equal(escapeICSText(undefined), "");
  });
});

describe("escapeICSText: injection resistance", () => {
  test("a service name containing a real newline cannot introduce a new physical ICS line", () => {
    const malicious = "Evil\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Injected";
    const escaped = escapeICSText(malicious);
    assert.equal(escaped.includes("\n"), false);
    assert.equal(escaped.includes("\r"), false);
    assert.ok(escaped.includes("\\n"));
  });

  test("the full generated ICS has no raw newline inside the escaped SUMMARY/DESCRIPTION values", () => {
    const trial = sampleTrial({ serviceName: "Evil\nEND:VEVENT\nBEGIN:VEVENT\nX-INJECTED:true" });
    const ics = buildTrialReminderICS(trial, new Date(2026, 10, 1, 9, 0), new Date(2026, 9, 1, 12, 0));

    // Every physical line must be a well-formed ICS content line (a known
    // property/BEGIN/END keyword, or a folded continuation starting with a
    // single space) — an injected "BEGIN:VEVENT"/"END:VEVENT" line would
    // show up as a *second* top-level occurrence if the escaping failed.
    const physicalLines = ics.split("\r\n").filter(Boolean);
    const beginEventCount = physicalLines.filter((l) => l === "BEGIN:VEVENT").length;
    const endEventCount = physicalLines.filter((l) => l === "END:VEVENT").length;
    assert.equal(beginEventCount, 1);
    assert.equal(endEventCount, 1);

    for (const line of physicalLines) {
      const isKnownKeyword = /^(BEGIN|END):[A-Z]+$/.test(line);
      const isProperty = /^[A-Z-]+[;:]/.test(line);
      const isContinuation = line.startsWith(" ");
      assert.ok(
        isKnownKeyword || isProperty || isContinuation,
        `line did not look like valid ICS content: ${JSON.stringify(line)}`
      );
    }
  });
});

describe("foldICSLine", () => {
  test("leaves short lines untouched", () => {
    assert.equal(foldICSLine("SUMMARY:short"), "SUMMARY:short");
  });

  test("folds a line over 75 octets, continuation prefixed with a space", () => {
    const long = "DESCRIPTION:" + "x".repeat(100);
    const folded = foldICSLine(long);
    const physicalLines = folded.split("\r\n");
    assert.ok(physicalLines.length > 1);
    for (const line of physicalLines.slice(1)) {
      assert.ok(line.startsWith(" "));
    }
    // Re-joining (stripping the CRLF + single leading space of each
    // continuation) must reconstruct the original content exactly.
    const rejoined = physicalLines.map((l, i) => (i === 0 ? l : l.slice(1))).join("");
    assert.equal(rejoined, long);
  });

  test("each physical line is at most 75 octets", () => {
    const long = "DESCRIPTION:" + "y".repeat(300);
    const folded = foldICSLine(long);
    for (const line of folded.split("\r\n")) {
      assert.ok(new TextEncoder().encode(line).length <= 75);
    }
  });

  test("does not split a multi-byte UTF-8 character across a fold boundary", () => {
    // Repeat a 3-byte character enough times to force folding, then check
    // every physical line decodes to valid, non-replacement-character text.
    const long = "SUMMARY:" + "€".repeat(40);
    const folded = foldICSLine(long);
    for (const line of folded.split("\r\n")) {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      assert.equal(content.includes("�"), false);
    }
  });
});

describe("formatUTCStamp", () => {
  test("formats a UTC instant as YYYYMMDDTHHMMSSZ", () => {
    const date = new Date(Date.UTC(2026, 10, 10, 14, 5, 9));
    assert.equal(formatUTCStamp(date), "20261110T140509Z");
  });

  test("pads single-digit components", () => {
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.equal(formatUTCStamp(date), "20260102T030405Z");
  });
});

describe("sanitizeFilename", () => {
  test("keeps letters, digits, spaces, hyphens, underscores", () => {
    assert.equal(sanitizeFilename("StreamBox Pro_2"), "StreamBox Pro_2");
  });

  test("replaces path separators and other unsafe characters", () => {
    assert.equal(sanitizeFilename("../../etc/passwd"), "etc-passwd");
  });

  test("collapses runs of unsafe characters to a single hyphen", () => {
    assert.equal(sanitizeFilename("A!!!B???C"), "A-B-C");
  });

  test("strips control characters and embedded newlines", () => {
    assert.equal(sanitizeFilename("Evil\nName\tHere"), "Evil-Name-Here");
  });

  test("falls back to a default for an empty or fully-unsafe name", () => {
    assert.equal(sanitizeFilename(""), "trial-reminder");
    assert.equal(sanitizeFilename("!!!???"), "trial-reminder");
  });

  test("truncates to the max length", () => {
    const result = sanitizeFilename("x".repeat(200), { maxLength: 10 });
    assert.equal(result.length, 10);
  });
});

describe("isReminderInFuture: past-reminder handling", () => {
  const now = new Date(2026, 10, 10, 12, 0, 0);

  test("a reminder an hour from now is in the future", () => {
    assert.equal(isReminderInFuture(new Date(2026, 10, 10, 13, 0, 0), now), true);
  });

  test("a reminder an hour ago is not in the future", () => {
    assert.equal(isReminderInFuture(new Date(2026, 10, 10, 11, 0, 0), now), false);
  });

  test("a reminder exactly equal to 'now' counts as past, not future", () => {
    assert.equal(isReminderInFuture(new Date(2026, 10, 10, 12, 0, 0), now), false);
  });

  test("a reminder a full day in the past (e.g. trialEndDate - leadDays already elapsed) is rejected", () => {
    assert.equal(isReminderInFuture(new Date(2026, 10, 9, 9, 0, 0), now), false);
  });

  test("an invalid (null/NaN) candidate is never treated as in the future", () => {
    assert.equal(isReminderInFuture(null, now), false);
    assert.equal(isReminderInFuture(new Date(NaN), now), false);
  });
});

describe("buildTrialReminderICS: structure", () => {
  const trial = sampleTrial();
  const reminderAt = new Date(2026, 10, 24, 9, 0, 0); // local time
  const now = new Date(2026, 10, 1, 12, 0, 0);
  const ics = buildTrialReminderICS(trial, reminderAt, now);

  test("has CRLF line endings throughout", () => {
    assert.ok(ics.includes("\r\n"));
    // No bare LF without a preceding CR.
    assert.equal(/(?<!\r)\n/.test(ics), false);
  });

  test("has a single well-formed VCALENDAR/VEVENT/VALARM structure", () => {
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /\r\nVERSION:2\.0\r\n/);
    assert.match(ics, /\r\nBEGIN:VEVENT\r\n/);
    assert.match(ics, /\r\nBEGIN:VALARM\r\n/);
    assert.match(ics, /\r\nACTION:DISPLAY\r\n/);
    assert.match(ics, /\r\nTRIGGER:PT0S\r\n/);
    assert.match(ics, /\r\nEND:VALARM\r\n/);
    assert.match(ics, /\r\nEND:VEVENT\r\n/);
    assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  });

  test("UID is stable and based on the trial id", () => {
    assert.match(ics, /UID:trial-a1b2c3d4-e5f6-7890-abcd-ef1234567890@subscription-shield\.local/);
    // Rebuilding with the same trial/time is byte-for-byte identical.
    const again = buildTrialReminderICS(trial, reminderAt, now);
    assert.equal(again, ics);
  });

  test("has DTSTAMP, DTSTART (UTC form, resolved from the local reminder time)", () => {
    assert.match(ics, /DTSTAMP:20261101T\d{6}Z\r\n/);
    assert.match(ics, /DTSTART:20261124T\d{6}Z\r\n/);
  });

  test("SUMMARY is 'Review <service> trial'", () => {
    assert.match(ics, /SUMMARY:Review StreamBox trial\r\n/);
  });

  test("DESCRIPTION includes the recorded end date and renewal terms, and the honest disclaimers", () => {
    // Unfold first: RFC 5545 line folding can legitimately split the long
    // DESCRIPTION value across several physical lines ("\r\n " before each
    // continuation), which is correct behavior, not missing content.
    const unfolded = ics.replace(/\r\n /g, "");
    assert.match(unfolded, /DESCRIPTION:.*Recorded trial end date: 2026-12-01/);
    assert.match(unfolded, /DESCRIPTION:.*9\.99 USD \/ month/);
    assert.match(unfolded, /not a verified billing time/);
    assert.match(unfolded, /not update or remove this calendar event/);
  });
});

describe("buildTrialReminderICS: DST correctness", () => {
  test("a reminder on the US spring-forward day resolves to the correct UTC instant", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 2026-03-08 is a spring-forward day in America/New_York (2am -> 3am,
      // UTC-5 -> UTC-4). 9:00 AM local that day must serialize as 13:00Z,
      // not 14:00Z (which would be true the day before).
      const trial = sampleTrial();
      const reminderAt = new Date(2026, 2, 8, 9, 0, 0);
      const ics = buildTrialReminderICS(trial, reminderAt, new Date(2026, 2, 1));
      assert.match(ics, /DTSTART:20260308T130000Z/);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  test("a reminder the day before (still EST) uses the pre-transition UTC offset", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const trial = sampleTrial();
      const reminderAt = new Date(2026, 2, 7, 9, 0, 0);
      const ics = buildTrialReminderICS(trial, reminderAt, new Date(2026, 2, 1));
      assert.match(ics, /DTSTART:20260307T140000Z/);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  test("a reminder on the US fall-back day resolves to the correct UTC instant", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 2026-11-01 is fall-back (UTC-4 -> UTC-5). 9:00 AM local (after the
      // 1am transition) must serialize using the new UTC-5 offset: 14:00Z.
      const trial = sampleTrial();
      const reminderAt = new Date(2026, 10, 1, 9, 0, 0);
      const ics = buildTrialReminderICS(trial, reminderAt, new Date(2026, 9, 25));
      assert.match(ics, /DTSTART:20261101T140000Z/);
    } finally {
      process.env.TZ = originalTz;
    }
  });
});
