"use strict";

/**
 * Who is off, when. One ledger per workspace, shared by every module in the same
 * process — standups don't chase people on leave, timesheets don't nudge someone
 * off all week, @mentions never ping someone who is away.
 *
 * Entries come from the leave module (source "auto") or a human via the CLI
 * (source "manual"). Automation never overwrites a manual entry: a correction a
 * person made stays corrected.
 */

const FILE = "leave/ledger.json";

function createLedger(store) {
  const load = () => store.read(FILE, { entries: {} });
  const key = (personId, date) => `${personId}|${date}`;

  const ledger = {
    get(personId, date) {
      return load().entries[key(personId, date)] || null;
    },
    /** Off for the whole day (a half day still works the other half). */
    isOff(personId, date) {
      const e = ledger.get(personId, date);
      return !!e && !e.half;
    },
    on(date) {
      return Object.entries(load().entries)
        .filter(([k]) => k.endsWith(`|${date}`))
        .map(([k, e]) => ({ personId: k.split("|")[0], date, ...e }));
    },
    between(from, to) {
      return Object.entries(load().entries)
        .map(([k, e]) => ({ personId: k.split("|")[0], date: k.split("|")[1], ...e }))
        .filter((e) => e.date >= from && e.date <= to)
        .sort((a, b) => (a.date + a.personId).localeCompare(b.date + b.personId));
    },
    /**
     * Record leave. Returns { written:[dates], kept:[{date, reason}] }.
     * opts: { code, half, source: "auto"|"manual", provisional, ref, note, force }
     */
    set(personId, dates, opts) {
      const written = [], kept = [];
      store.update(FILE, { entries: {} }, (doc) => {
        for (const date of dates) {
          const k = key(personId, date);
          const cur = doc.entries[k];
          if (cur && cur.source === "manual" && opts.source !== "manual" && !opts.force) {
            kept.push({ date, reason: "a person corrected this day by hand" });
            continue;
          }
          doc.entries[k] = {
            code: opts.code, half: !!opts.half, source: opts.source || "auto",
            provisional: !!opts.provisional, ref: opts.ref || null, note: opts.note || null, at: new Date().toISOString(),
          };
          written.push(date);
        }
        return doc;
      });
      return { written, kept };
    },
    clear(personId, dates, { source = "auto", force = false } = {}) {
      const cleared = [];
      store.update(FILE, { entries: {} }, (doc) => {
        for (const date of dates) {
          const k = key(personId, date);
          const cur = doc.entries[k];
          if (!cur) continue;
          if (cur.source === "manual" && source !== "manual" && !force) continue;
          delete doc.entries[k];
          cleared.push(date);
        }
        return doc;
      });
      return cleared;
    },
  };
  return ledger;
}

module.exports = { createLedger };
