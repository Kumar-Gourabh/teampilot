"use strict";

/**
 * Time in the workspace's timezone. Dates are plain "YYYY-MM-DD" strings in that
 * timezone everywhere in TeamPilot; never compare raw Date objects across days.
 */

function parts(date = new Date(), tz) {
  const s = new Date(date).toLocaleString("en-CA", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const [d, t] = s.split(", ");
  const [h, m] = t.split(":").map(Number);
  return { date: d, minutes: (h % 24) * 60 + m, dow: dowOf(d) };
}

function dowOf(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function range(fromIso, toIso) {
  const out = [];
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) out.push(d);
  return out;
}

function weekdayName(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

function pretty(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function hhmm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function toMinutes(hm) {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function dayIndex(name) {
  if (typeof name === "number") return name;
  const i = DAY_NAMES.indexOf(String(name || "").toLowerCase());
  if (i === -1) throw new Error(`Unknown weekday "${name}"`);
  return i;
}

/**
 * A calendar bound to one workspace: timezone, working days and holidays.
 * holidays: [{ date: "YYYY-MM-DD", name }]
 */
function createCalendar({ timezone, workdays = [1, 2, 3, 4, 5], holidays = [] }) {
  const holidayMap = new Map(holidays.map((h) => [String(h.date), h.name || "Holiday"]));
  const workset = new Set(workdays.map(dayIndex));
  const cal = {
    timezone,
    now: () => parts(new Date(), timezone),
    today: () => parts(new Date(), timezone).date,
    parts: (d) => parts(d, timezone),
    localDate: (iso) => parts(new Date(iso), timezone).date,
    localTime: (iso) => hhmm(parts(new Date(iso), timezone).minutes),
    holiday: (iso) => holidayMap.get(iso) || null,
    isWorkday: (iso) => workset.has(dowOf(iso)) && !holidayMap.has(iso),
    workdaysBetween: (from, to) => range(from, to).filter((d) => cal.isWorkday(d)),
    previousWorkday(iso) {
      let d = addDays(iso, -1);
      for (let i = 0; i < 30 && !cal.isWorkday(d); i++) d = addDays(d, -1);
      return d;
    },
    /** The [start, end] of the week that ends on `endDay` and contains `iso`. */
    periodContaining(iso, endDay = "friday") {
      const end = dayIndex(endDay);
      const delta = (end - dowOf(iso) + 7) % 7;
      const last = addDays(iso, delta);
      return { start: addDays(last, -6), end: last };
    },
    holidaysBetween: (from, to) => holidays.filter((h) => h.date >= from && h.date <= to),
  };
  return cal;
}

module.exports = { parts, dowOf, addDays, range, weekdayName, pretty, hhmm, toMinutes, dayIndex, createCalendar };
