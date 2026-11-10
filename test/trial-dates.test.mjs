import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  parseCalendarDate,
  daysRemaining,
  trialStatus,
  isDueForReminder,
  addDays,
  dateKey,
} from "../public/trial-dates.mjs";

describe("parseCalendarDate", () => {
  test("does not shift the day backward (no UTC round-trip)", () => {
    // `new Date("2026-01-15")` parses as UTC midnight, which displays as
    // Jan 14 in any timezone behind UTC. parseCalendarDate must not do that.
    const date = parseCalendarDate("2026-01-15");
    assert.equal(date.getFullYear(), 2026);
    assert.equal(date.getMonth(), 0);
    assert.equal(date.getDate(), 15);
  });
});

describe("daysRemaining", () => {
  test("is positive for a future date beyond the reminder window", () => {
    const now = new Date(2026, 0, 1);
    assert.equal(daysRemaining("2026-01-11", now), 10);
  });

  test("is zero when the end date is today", () => {
    const now = new Date(2026, 0, 1, 23, 59);
    assert.equal(daysRemaining("2026-01-01", now), 0);
  });

  test("is negative once the end date has passed", () => {
    const now = new Date(2026, 0, 5);
    assert.equal(daysRemaining("2026-01-01", now), -4);
  });

  test("is correct across a month boundary", () => {
    const now = new Date(2026, 0, 29); // Jan 29, 2026
    assert.equal(daysRemaining("2026-02-02", now), 4);
  });

  test("is correct across a year boundary", () => {
    const now = new Date(2026, 11, 30); // Dec 30, 2026
    assert.equal(daysRemaining("2027-01-02", now), 3);
  });

  test("is correct across the Feb 29 leap day", () => {
    const now = new Date(2028, 1, 28); // Feb 28, 2028 (leap year)
    assert.equal(daysRemaining("2028-03-01", now), 2);
  });
});

describe("daysRemaining across daylight-saving transitions", () => {
  const originalTz = process.env.TZ;

  before(() => {
    // US Eastern observes DST; 2026-03-08 is a 23-hour "spring forward" day
    // and 2026-11-01 is a 25-hour "fall back" day in that zone.
    process.env.TZ = "America/New_York";
  });

  after(() => {
    process.env.TZ = originalTz;
  });

  test("a span crossing the spring-forward transition still counts whole calendar days", () => {
    const now = new Date(2026, 2, 7); // Mar 7, 2026, before the 23-hour day
    assert.equal(daysRemaining("2026-03-09", now), 2);
  });

  test("a span crossing the fall-back transition still counts whole calendar days", () => {
    const now = new Date(2026, 9, 31); // Oct 31, 2026, before the 25-hour day
    assert.equal(daysRemaining("2026-11-02", now), 2);
  });
});

describe("trialStatus", () => {
  const reminderLeadDays = 3;

  test("'normal' when more days remain than the reminder window", () => {
    const now = new Date(2026, 0, 1);
    const status = trialStatus({ trialEndDate: "2026-01-05", reminderLeadDays }, now);
    assert.equal(status.kind, "normal");
    assert.equal(status.days, 4);
  });

  test("'soon' at the exact reminder-window boundary", () => {
    const now = new Date(2026, 0, 1);
    const status = trialStatus({ trialEndDate: "2026-01-04", reminderLeadDays }, now);
    assert.equal(status.kind, "soon");
    assert.equal(status.days, 3);
  });

  test("'soon' one day inside the reminder window", () => {
    const now = new Date(2026, 0, 1);
    const status = trialStatus({ trialEndDate: "2026-01-02", reminderLeadDays }, now);
    assert.equal(status.kind, "soon");
  });

  test("'today' when the end date is today", () => {
    const now = new Date(2026, 0, 1);
    const status = trialStatus({ trialEndDate: "2026-01-01", reminderLeadDays }, now);
    assert.equal(status.kind, "today");
    assert.equal(status.days, 0);
  });

  test("'passed' the day after the end date", () => {
    const now = new Date(2026, 0, 2);
    const status = trialStatus({ trialEndDate: "2026-01-01", reminderLeadDays }, now);
    assert.equal(status.kind, "passed");
    assert.equal(status.days, -1);
  });

  test("'passed' for a date long in the past", () => {
    const now = new Date(2026, 0, 1);
    const status = trialStatus({ trialEndDate: "2020-01-01", reminderLeadDays }, now);
    assert.equal(status.kind, "passed");
  });
});

describe("isDueForReminder", () => {
  test("true for 'soon' and 'today', false otherwise", () => {
    const now = new Date(2026, 0, 1);
    assert.equal(isDueForReminder({ trialEndDate: "2026-01-01", reminderLeadDays: 3 }, now), true);
    assert.equal(isDueForReminder({ trialEndDate: "2026-01-04", reminderLeadDays: 3 }, now), true);
    assert.equal(isDueForReminder({ trialEndDate: "2026-01-05", reminderLeadDays: 3 }, now), false);
    assert.equal(isDueForReminder({ trialEndDate: "2025-12-31", reminderLeadDays: 3 }, now), false);
  });
});

describe("addDays", () => {
  test("adds days within a month", () => {
    assert.equal(dateKey(addDays("2026-11-10", 3)), "2026-11-13");
  });

  test("subtracts days (negative count) within a month", () => {
    assert.equal(dateKey(addDays("2026-11-10", -3)), "2026-11-07");
  });

  test("rolls over a month boundary going forward", () => {
    assert.equal(dateKey(addDays("2026-11-29", 3)), "2026-12-02");
  });

  test("rolls back over a month boundary going backward", () => {
    assert.equal(dateKey(addDays("2026-12-01", -3)), "2026-11-28");
  });

  test("rolls over a year boundary", () => {
    assert.equal(dateKey(addDays("2026-12-30", 3)), "2027-01-02");
    assert.equal(dateKey(addDays("2027-01-02", -3)), "2026-12-30");
  });

  test("rolls back across the Feb 29 leap day correctly", () => {
    assert.equal(dateKey(addDays("2028-03-01", -1)), "2028-02-29");
  });

  test("accepts a Date input as well as a string", () => {
    const start = new Date(2026, 10, 10);
    assert.equal(dateKey(addDays(start, 5)), "2026-11-15");
  });

  test("zero days is a no-op", () => {
    assert.equal(dateKey(addDays("2026-11-10", 0)), "2026-11-10");
  });
});
