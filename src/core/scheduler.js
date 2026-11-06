"use strict";

/**
 * Job scheduling with safety nets for the ways scheduled bots fail silently:
 *
 *  - Holidays: jobs skip non-working days unless they ask not to.
 *  - Dead slots: a cron time outside the host's uptime window (a VM that's off at
 *    night) never fires and nobody notices. Those are warned about at start-up
 *    and by `teampilot doctor`.
 *  - Boot catch-up: if the process starts after a slot already passed today
 *    (restart, late boot), catch-up jobs run once — within catchUpMinutes.
 *  - One run per slot: a run ledger per day; together with keyed posts this
 *    makes a restart storm harmless.
 *  - Errors are recorded per job, so the supervisor reports failures instead of
 *    them living only in a log.
 */

const cron = require("./cron");
const { hhmm, toMinutes, addDays } = require("./clock");

function createScheduler(ctx) {
  const { calendar, store, log, config } = ctx;
  const jobs = [];

  /** job: { id, cron: string|string[], run: async () => any, catchUp?, anyDay?, expect? } */
  function add(job) {
    if (jobs.some((j) => j.id === job.id)) throw new Error(`duplicate job id ${job.id}`);
    jobs.push({ ...job, crons: [].concat(job.cron) });
  }

  const runFile = (date) => `scheduler/${date}.json`;

  function slotsToday(job, date) {
    return job.crons.flatMap((c) => cron.slotsOn(c, date)).sort((a, b) => a - b);
  }

  async function execute(job, { slot, reason = "schedule" } = {}) {
    const date = calendar.today();
    if (!job.anyDay && !calendar.isWorkday(date)) {
      log.info(`${job.id}: skipped — ${calendar.holiday(date) || "not a working day"}`);
      return;
    }
    const slotKey = slot === undefined ? "manual" : hhmm(slot);
    const t0 = Date.now();
    try {
      const result = await job.run();
      store.update(runFile(date), {}, (d) => {
        (d[job.id] = d[job.id] || []).push({ slot: slotKey, at: new Date().toISOString(), ok: true, reason, ms: Date.now() - t0, note: result && result.note });
        return d;
      });
    } catch (e) {
      log.error(`${job.id} failed: ${e.stack || e.message}`);
      store.update(runFile(date), {}, (d) => {
        (d[job.id] = d[job.id] || []).push({ slot: slotKey, at: new Date().toISOString(), ok: false, reason, error: String(e.message).slice(0, 500) });
        return d;
      });
    }
  }

  function deadSlots() {
    const up = config.workspace.uptime;
    if (!up) return [];
    const from = toMinutes(up.from), to = toMinutes(up.to);
    const out = [];
    // Check a sample week so day-of-week crons are covered.
    const base = calendar.today();
    const week = Array.from({ length: 7 }, (_, i) => addDays(base, i));
    for (const j of jobs) {
      const bad = new Set();
      for (const d of week) for (const s of slotsToday(j, d)) if (s < from || s > to) bad.add(hhmm(s));
      if (bad.size) out.push({ job: j.id, times: [...bad].sort() });
    }
    return out;
  }

  function start() {
    const nodeCron = require("node-cron");
    for (const job of jobs) {
      for (const expr of job.crons) {
        nodeCron.schedule(expr, () => {
          const now = calendar.now();
          execute(job, { slot: now.minutes });
        }, { timezone: calendar.timezone });
      }
    }
    for (const d of deadSlots()) log.warn(`${d.job} is scheduled at ${d.times.join(", ")} — outside the host uptime window; it will never fire`);
    catchUp();
  }

  function catchUp() {
    const now = calendar.now();
    if (!calendar.isWorkday(now.date)) return;
    const ran = store.read(runFile(now.date), {});
    const window = config.workspace.catchUpMinutes;
    let delay = 30000;
    for (const job of jobs.filter((j) => j.catchUp)) {
      const missed = slotsToday(job, now.date).filter((s) => s < now.minutes && now.minutes - s <= window);
      if (!missed.length) continue;
      const last = missed[missed.length - 1];
      if ((ran[job.id] || []).some((r) => r.slot === hhmm(last))) continue;
      log.info(`catch-up: ${job.id} missed its ${hhmm(last)} slot — running in ${delay / 1000}s`);
      setTimeout(() => execute(job, { slot: last, reason: "catch-up" }), delay);
      delay += 20000;
    }
  }

  function list() {
    const date = calendar.today();
    return jobs.map((j) => ({ id: j.id, cron: j.crons, today: slotsToday(j, date).map(hhmm), catchUp: !!j.catchUp }));
  }

  return { add, start, execute, list, jobs, deadSlots, slotsToday, runsOn: (date) => store.read(runFile(date), {}) };
}

module.exports = { createScheduler };
