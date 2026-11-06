"use strict";

/**
 * The supervisor watches every other job and tells the operator when something
 * is off — before the team notices.
 *
 * Deterministic checks (every pass):
 *   - a job failed
 *   - a scheduled post never went out
 *   - a post was accepted by the webhook but never appeared in the venue
 *     (a 202 is not delivery: broken or foreign-owned flows swallow cards)
 *   - the same card appeared twice (a stray copy of a bot, a manual re-send)
 *   - a summary describes work for someone who posted nothing
 *   - a card names someone who has left
 *   - sign-in expired / a venue can't be read / leave reading has stalled /
 *     a job is scheduled outside the host's uptime window
 * End of day: people signals (members quiet for N working days, unanswered leave
 * questions) and an all-clear heartbeat — a silent supervisor is ambiguous.
 * Optional: an LLM "judge" that checks each summary against the updates it was
 * written from.
 *
 * It only ever posts to its own alert venue, and each finding is reported once.
 */

const { check } = require("../../core/config");
const { hhmm, pretty } = require("../../core/clock");
const guards = require("../../core/llm/guards");
const { sameName } = require("../../core/people");
const standup = require("../standup");

const SEV = { high: "🔴", medium: "🟠", info: "🔵" };

function settings(cfg) {
  return {
    alertVenue: cfg.alertVenue,
    ownerIds: cfg.owners || [],
    graceMinutes: cfg.graceMinutes || 20,
    verifyDelivery: cfg.verifyDelivery !== false,
    judge: !!cfg.judge,
    quietDays: cfg.quietDays || 3,
    allClear: cfg.allClear !== false,
    schedule: cfg.schedule || {},
  };
}

async function runChecks(ctx, s, { allJobs, scheduler, endOfDay = false, date = ctx.calendar.today() }) {
  const out = [];
  const add = (f) => out.push(f);
  const now = ctx.calendar.now();
  const isToday = date === now.date;
  const posts = ctx.delivery.postsOn(date);
  if (!ctx.calendar.isWorkday(date)) return out;

  // 1. failed jobs
  for (const [id, runs] of Object.entries(scheduler.runsOn(date))) {
    for (const r of runs.filter((x) => !x.ok)) add({ key: `fail:${id}:${r.slot}`, severity: "high", area: id, what: `failed at ${r.slot}`, detail: r.error });
  }

  // 2. scheduled posts that never went out
  for (const job of allJobs.filter((j) => j.expect && !j.expect.conditional)) {
    const due = scheduler.slotsToday(job, date).filter((m) => !isToday || m + s.graceMinutes <= now.minutes);
    if (!due.length) continue;
    if (!posts.some((p) => p.job === job.id)) {
      add({ key: `missing:${job.id}`, severity: "high", area: job.id, what: `no post today (due ${due.map(hhmm).join(", ")})`, detail: "check the log; if the host was down, run it by hand with teampilot run" });
    }
  }

  // 3. delivery + duplicates, read back from the venues themselves
  const unreadable = new Set();
  if (s.verifyDelivery) {
    const byVenue = {};
    for (const p of posts) (byVenue[p.venue] = byVenue[p.venue] || []).push(p);
    for (const [vn, list] of Object.entries(byVenue)) {
      const v = ctx.venue(vn);
      if (v.kind === "console" || v.kind === "slack" || (!v.chatId && !v.teamId)) continue;
      let msgs;
      try {
        msgs = (await ctx.reader.read(v, { from: date, to: date, withReplies: false })).filter((m) => m.from.isBot);
      } catch (e) {
        unreadable.add(vn);
        add({ key: `unreadable:${vn}`, severity: "high", area: vn, what: e.status === 403 ? "the bot account can't read this venue (not a member?)" : "couldn't read this venue", detail: e.message.slice(0, 200) });
        continue;
      }
      for (const p of list) {
        if (!p.title || Date.now() - Date.parse(p.at) < 5 * 60000) continue;
        const seen = msgs.filter((m) => m.title.includes(p.title));
        if (!seen.length) add({ key: `undelivered:${p.key || p.title}`, severity: "high", area: vn, what: `"${p.title}" was accepted by the webhook but isn't in the venue`, detail: "the posting flow may be broken, disabled or owned by someone who left" });
      }
      const counts = {};
      for (const m of msgs) if (m.title) counts[m.title] = (counts[m.title] || 0) + 1;
      for (const [t, n] of Object.entries(counts)) {
        if (n > 1 && !/reminder/i.test(t)) add({ key: `dup:${vn}:${t}`, severity: "medium", area: vn, what: `"${t}" appeared ${n} times`, detail: "a second copy of the bot running somewhere, or a manual re-send" });
      }
    }
  }

  // 4. card content
  for (const p of posts) {
    for (const u of p.untagged || []) {
      if (u.reason === "has left") add({ key: `leaver:${p.key}:${u.personId}`, severity: "medium", area: p.job, what: `the card names ${u.name}, who has left`, detail: "not tagged — remove them from the team or cc list" });
    }
    if (p.meta && Array.isArray(p.meta.posters) && /:summary$/.test(p.job)) {
      const allowed = [...p.meta.posters, ...(p.meta.missing || []), ...(p.meta.away || [])].map((id) => (ctx.directory.get(id) || { name: id }).name);
      for (const line of p.body.split("\n")) {
        const who = guards.leadName(line);
        if (who && !allowed.some((n) => sameName(n, who))) {
          add({ key: `invented:${p.key}:${who}`, severity: "high", area: p.job, what: `the summary has a line for "${who}", who didn't post`, detail: line.slice(0, 160) });
        }
      }
    }
  }

  // 5. health
  if (ctx.config.identity.graph.enabled) {
    try { await ctx.auth.tokenSilent(); } catch (e) { add({ key: "auth:graph", severity: "high", area: "sign-in", what: "Microsoft 365 sign-in isn't working — reading replies will fail", detail: e.message }); }
  }
  for (const d of scheduler.deadSlots()) add({ key: `dead:${d.job}`, severity: "medium", area: d.job, what: `scheduled at ${d.times.join(", ")}, outside the host's uptime window`, detail: "it will never fire — move it inside workspace.uptime" });
  const leaveJob = allJobs.find((j) => j.id === "leave:ingest");
  if (leaveJob) {
    const last = ctx.store.read("leave/last-ingest.json", null);
    const firstSlot = scheduler.slotsToday(leaveJob, date)[0];
    if (isToday && firstSlot !== undefined && now.minutes > firstSlot + 60 && (!last || ctx.reader.localDate(last.at) !== date)) {
      add({ key: "leave:stale", severity: "medium", area: "leave", what: "leave messages haven't been read today", detail: last ? `last successful read ${last.at}` : "never" });
    }
  }

  // 6. end of day: people signals
  if (endOfDay) {
    const sCfg = ctx.config.modules.standup;
    if (sCfg && sCfg.enabled !== false) {
      for (const team of standup.teamsOf(ctx, sCfg)) {
        for (const p of standup.members(ctx, team, date)) {
          const n = standup.silentStreak(ctx, team, p.id, date);
          if (n >= s.quietDays) add({ key: `quiet:${team.key}:${p.id}:${n}`, severity: "info", area: team.name, what: `${p.name}: no standup update for ${n} working days`, detail: "leave days aren't counted" });
        }
      }
    }
    const clar = ctx.store.read("leave/clarifications.json", []);
    for (const c of clar.filter((x) => !x.resolved && Date.now() - Date.parse(x.askedAt) > 2 * 86400000)) {
      add({ key: `clar:${c.id}`, severity: "info", area: "leave", what: `leave question for ${c.name} (${c.dates.join(", ")}) is unanswered`, detail: "recorded provisionally; fix by hand with teampilot leave set if needed" });
    }
  }

  // 7. optional LLM judge
  if (s.judge && ctx.llm.enabled) {
    for (const p of posts.filter((x) => /:summary$/.test(x.job) && x.meta && x.meta.source === "llm" && x.meta.team)) {
      const day = standup.loadDay(ctx, p.meta.team, date);
      if (!day) continue;
      const updates = Object.entries(day.byPerson).map(([id, ms]) => `${(ctx.directory.get(id) || { name: id }).name}: ${ms.map((m) => m.text).join(" / ")}`).join("\n");
      try {
        const res = guards.parseJsonLoose(await ctx.llm.complete({
          system: "You audit a standup summary against the messages it was written from. Report only claims the messages do not support.",
          prompt: `MESSAGES:\n${updates}\n\nSUMMARY:\n${p.body}\n\nReturn a JSON array of {"person":"...","claim":"...","problem":"invented|wrong person|wrong status|dropped blocker"}. Return [] if the summary is faithful.`,
          maxTokens: 4000,
        }));
        for (const r of Array.isArray(res) ? res : []) add({ key: `judge:${p.key}:${r.person}:${String(r.claim).slice(0, 40)}`, severity: "medium", area: p.job, what: `${r.person}: ${r.problem}`, detail: String(r.claim).slice(0, 200) });
      } catch (e) {
        add({ key: `judge-failed:${p.key}`, severity: "info", area: "supervisor", what: "the accuracy check couldn't run", detail: e.message.slice(0, 200) });
      }
    }
  }
  return out;
}

async function pass(ctx, cfg, opts) {
  const s = settings(cfg);
  const date = opts.date || ctx.calendar.today();
  const findings = await runChecks(ctx, s, { ...opts, date });
  const file = `supervisor/${date}.json`;
  const st = ctx.store.read(file, { reported: {}, passes: [] });
  const fresh = findings.filter((f) => !st.reported[f.key]);
  const now = ctx.calendar.now();
  const lines = [];
  for (const sev of ["high", "medium", "info"]) {
    const list = fresh.filter((f) => f.severity === sev);
    if (list.length) lines.push(`${SEV[sev]} ${sev.toUpperCase()}\n${list.map((f) => `- ${f.area}: ${f.what}${f.detail ? ` — ${f.detail}` : ""}`).join("\n")}`);
  }
  const owners = ctx.directory.resolveIds(s.ownerIds, date);
  if (lines.length) {
    await ctx.post({
      venue: s.alertVenue, title: `Supervisor · ${pretty(date)} ${hhmm(now.minutes)}`, body: lines.join("\n\n"), job: "supervisor:alert",
      mention: { people: [], cc: fresh.some((f) => f.severity === "high") ? owners : [] }, dry: opts.dry,
    });
  } else if (opts.endOfDay && s.allClear && !findings.length) {
    await ctx.post({ venue: s.alertVenue, title: `Supervisor · ${pretty(date)}`, body: "✅ All clear — every scheduled job ran and every card checked out.", job: "supervisor:all-clear", key: `supervisor:all-clear:${date}`, dry: opts.dry });
  }
  if (!opts.dry) {
    for (const f of fresh) st.reported[f.key] = new Date().toISOString();
    st.passes.push(new Date().toISOString());
    ctx.store.write(file, st);
  } else if (!lines.length) console.log(`[dry] no new findings (${findings.length} already reported today)`);
  return { note: `${findings.length} finding(s), ${fresh.length} new` };
}

function validate(cfg, config) {
  const errors = [];
  check.venue(config, cfg.alertVenue, "alertVenue", errors);
  const sch = cfg.schedule || {};
  if (!sch.passes && !sch.endOfDay) errors.push("schedule: give passes (a list of crons) and/or endOfDay");
  if (sch.passes) check.cron(sch.passes, "schedule.passes", errors);
  if (sch.endOfDay) check.cron(sch.endOfDay, "schedule.endOfDay", errors);
  return errors;
}

function jobs(ctx, cfg, { dry = false, allJobs = [], scheduler } = {}) {
  const s = settings(cfg);
  const out = [];
  if (s.schedule.passes) out.push({ id: "supervisor:pass", cron: s.schedule.passes, catchUp: true, run: () => pass(ctx, cfg, { dry, allJobs, scheduler }) });
  if (s.schedule.endOfDay) out.push({ id: "supervisor:end-of-day", cron: s.schedule.endOfDay, catchUp: true, run: () => pass(ctx, cfg, { dry, allJobs, scheduler, endOfDay: true }) });
  return out;
}

const commands = {
  check: {
    usage: "supervisor check [--date YYYY-MM-DD] [--end-of-day]   run the checks now and print (posts nothing)",
    async run(ctx, cfg, args, runtime) {
      const findings = await runChecks(ctx, settings(cfg), { allJobs: runtime.jobs, scheduler: runtime.scheduler, endOfDay: !!args["end-of-day"], date: args.date || ctx.calendar.today() });
      if (!findings.length) return console.log("✅ No findings.");
      for (const f of findings) console.log(`${SEV[f.severity]} ${f.area}: ${f.what}${f.detail ? `\n     ${f.detail}` : ""}`);
    },
  },
};

module.exports = { key: "supervisor", title: "Supervisor", validate, jobs, commands, runChecks, needsAllJobs: true };
