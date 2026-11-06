"use strict";

/**
 * Weekly timesheet compliance — deterministic, no LLM.
 *
 *   reminder → one card for the period (instructions, link, deadline, holiday line)
 *   poll     → silent: counts confirmations
 *   nudge    → tags only the people still pending (silent if none)
 *   final    → the pending list to the coordinators
 *
 * A person counts as confirmed by any of:
 *   - a reaction on the reminder card
 *   - a message after the reminder containing a confirm word ("done", "submitted"…)
 *     or a screenshot
 *   - a coordinator's message with a confirm word that @mentions them ("done for @Sam")
 *   - `teampilot timesheet <ws> confirm <person>`
 * Nobody on leave for every working day of the period is chased. Hours are never
 * stated or inferred on a card — only the instructions you configure.
 */

const { check } = require("../../core/config");
const { pretty } = require("../../core/clock");

function settings(cfg) {
  return {
    name: cfg.name || "Timesheets",
    venue: cfg.venue,
    finalVenue: cfg.finalVenue || cfg.venue,
    periodEnds: cfg.periodEnds || "friday",
    instructions: cfg.instructions || "Please submit your timesheet for this week.",
    link: cfg.link || null,
    deadline: cfg.deadline || null,
    holidayNote: cfg.holidayNote || null,
    tagOnReminder: !!cfg.tagOnReminder,
    confirmRe: new RegExp(`\\b(${cfg.confirmWords || "done|submitted|filled|completed|updated|sent"})\\b`, "i"),
    participantIds: cfg.participants || null,
    coordinatorIds: cfg.coordinators || [],
    schedule: cfg.schedule || {},
  };
}

function period(ctx, s, date = ctx.calendar.today()) {
  return ctx.calendar.periodContaining(date, s.periodEnds);
}
const stateFile = (end) => `timesheet/${end}.json`;
const title = (s, p) => `${s.name} · week ending ${pretty(p.end)}`;

function participants(ctx, s, date) {
  return s.participantIds ? ctx.directory.resolveIds(s.participantIds, date) : ctx.directory.active(date).filter((p) => p.timesheet);
}

function offAllPeriod(ctx, personId, p) {
  const days = ctx.calendar.workdaysBetween(p.start, p.end);
  return days.length > 0 && days.every((d) => ctx.leave.isOff(personId, d));
}

function status(ctx, s, date = ctx.calendar.today()) {
  const p = period(ctx, s, date);
  const st = ctx.store.read(stateFile(p.end), { confirmed: {} });
  const all = participants(ctx, s, date);
  const excused = all.filter((x) => offAllPeriod(ctx, x.id, p));
  const confirmed = all.filter((x) => st.confirmed[x.id]);
  const pending = all.filter((x) => !st.confirmed[x.id] && !excused.includes(x));
  return { period: p, all, confirmed, pending, excused, state: st };
}

async function poll(ctx, s) {
  const today = ctx.calendar.today();
  const p = period(ctx, s, today);
  const venue = ctx.venue(s.venue);
  const msgs = await ctx.reader.read(venue, { from: p.start, to: today, replyLookbackDays: 7 });
  const reminder = msgs.find((m) => m.from.isBot && m.title.includes(title(s, p)));
  if (!reminder) return { note: "reminder card not found in the venue yet" };

  const pool = participants(ctx, s, today);
  const coords = ctx.directory.resolveIds(s.coordinatorIds, today);
  const found = {};
  const harvest = [];
  const mark = (person, via, at) => { if (person && !found[person.id]) found[person.id] = { via, at }; };

  for (const r of reminder.reactions) {
    mark(ctx.directory.match({ aadId: r.aadId }, pool), "reaction", reminder.at);
  }
  const after = msgs.filter((m) => !m.from.isBot && m.at >= reminder.at && (venue.chatId || m.parentId === reminder.id || !m.parentId));
  for (const m of after) {
    const sender = ctx.directory.match({ aadId: m.from.aadId, name: m.from.name }, [...pool, ...coords]);
    if (sender && m.from.aadId) harvest.push({ personId: sender.id, aadId: m.from.aadId });
    const says = s.confirmRe.test(m.text) || m.hasImage;
    if (!says || !sender) continue;
    if (coords.some((c) => c.id === sender.id) && m.mentions.length) {
      for (const x of m.mentions) mark(ctx.directory.match({ aadId: x.aadId, name: x.name }, pool), `confirmed by ${sender.name}`, m.at);
    } else if (pool.some((x) => x.id === sender.id)) {
      mark(sender, m.hasImage && !s.confirmRe.test(m.text) ? "screenshot" : "message", m.at);
    }
  }
  ctx.directory.harvest(harvest);
  let added = 0;
  ctx.store.update(stateFile(p.end), { confirmed: {} }, (st) => {
    st.reminderId = reminder.id;
    for (const [id, v] of Object.entries(found)) if (!st.confirmed[id]) { st.confirmed[id] = v; added++; }
    st.polledAt = new Date().toISOString();
    return st;
  });
  return { note: `${added} new confirmation(s)` };
}

function reminderCard(ctx, s) {
  const today = ctx.calendar.today();
  const p = period(ctx, s, today);
  const hols = ctx.calendar.holidaysBetween(p.start, p.end);
  const st = status(ctx, s, today);
  const lines = [
    s.instructions.trim(),
    s.link ? `🔗 ${s.link}` : "",
    s.deadline ? `⏰ Deadline: ${s.deadline}` : "",
    hols.length ? `📅 Holiday this week: ${hols.map((h) => `${h.name} (${pretty(h.date)})`).join(", ")}${s.holidayNote ? ` — ${s.holidayNote}` : ""}` : "",
    "Once you've submitted, reply **done** here or react to this message. You'll get a reminder only if we haven't seen it.",
    s.tagOnReminder && st.pending.length ? st.pending.map((x) => `**${x.name}**`).join(" · ") : "",
  ];
  return { title: title(s, p), body: lines.filter(Boolean).join("\n\n"), mentionPool: s.tagOnReminder ? st.pending : [] };
}

// ---------------------------------------------------------------------------

function validate(cfg, config) {
  const errors = [];
  check.venue(config, cfg.venue, "venue", errors, { readable: true });
  if (cfg.finalVenue) check.venue(config, cfg.finalVenue, "finalVenue", errors);
  const s = cfg.schedule || {};
  if (!s.reminder) errors.push("schedule.reminder is required");
  for (const k of Object.keys(s)) {
    if (!["reminder", "poll", "nudge", "final"].includes(k)) errors.push(`schedule.${k}: unknown (reminder, poll, nudge, final)`);
    else check.cron(s[k], `schedule.${k}`, errors);
  }
  try { require("../../core/clock").dayIndex(cfg.periodEnds || "friday"); } catch (e) { errors.push(`periodEnds: ${e.message}`); }
  return errors;
}

function jobs(ctx, cfg, { dry = false } = {}) {
  const s = settings(cfg);
  const out = [];
  const sch = s.schedule;
  if (sch.reminder) out.push({
    id: "timesheet:reminder", cron: sch.reminder, catchUp: true,
    expect: { venue: s.venue, title: (d) => title(s, period(ctx, s, d)) },
    run: async () => {
      const c = reminderCard(ctx, s);
      const p = period(ctx, s);
      return ctx.post({ venue: s.venue, title: c.title, body: c.body, job: "timesheet:reminder", key: `timesheet:reminder:${p.end}`, mention: { people: c.mentionPool }, dry });
    },
  });
  if (sch.poll) out.push({ id: "timesheet:poll", cron: sch.poll, run: () => poll(ctx, s) });
  if (sch.nudge) out.push({
    id: "timesheet:nudge", cron: sch.nudge,
    expect: { venue: s.venue, title: (d) => `${s.name} reminder · week ending ${pretty(period(ctx, s, d).end)}`, conditional: true },
    run: async () => {
      await poll(ctx, s).catch((e) => ctx.log.warn(`timesheet poll before nudge failed: ${e.message}`));
      const st = status(ctx, s);
      if (!st.pending.length) return { note: "everyone has confirmed" };
      const body = [
        `${st.pending.map((x) => `**${x.name}**`).join(", ")} — a quick reminder to submit your timesheet for the week ending ${pretty(st.period.end)}${s.deadline ? ` (deadline: ${s.deadline})` : ""}.`,
        "Reply **done** here once it's in.",
        `${st.confirmed.length} of ${st.all.length - st.excused.length} done so far.`,
      ].join("\n\n");
      return ctx.post({ venue: s.venue, title: `${s.name} reminder · week ending ${pretty(st.period.end)}`, body, job: "timesheet:nudge", key: `timesheet:nudge:${ctx.calendar.today()}:${ctx.calendar.now().minutes}`, mention: { people: st.pending }, dry });
    },
  });
  if (sch.final) out.push({
    id: "timesheet:final", cron: sch.final, catchUp: true,
    expect: { venue: s.finalVenue, title: (d) => `${s.name} status · week ending ${pretty(period(ctx, s, d).end)}` },
    run: async () => {
      await poll(ctx, s).catch((e) => ctx.log.warn(`timesheet poll before final failed: ${e.message}`));
      const st = status(ctx, s);
      const body = [
        `${st.confirmed.length} of ${st.all.length - st.excused.length} confirmed for the week ending ${pretty(st.period.end)}.`,
        st.pending.length ? `⏳ Still pending: ${st.pending.map((x) => x.name).join(", ")}` : "✅ Everyone has confirmed.",
        st.excused.length ? `🌴 On leave all week (not chased): ${st.excused.map((x) => x.name).join(", ")}` : "",
      ].filter(Boolean).join("\n\n");
      return ctx.post({ venue: s.finalVenue, title: `${s.name} status · week ending ${pretty(st.period.end)}`, body, job: "timesheet:final", key: `timesheet:final:${st.period.end}`, mention: { people: [], cc: ctx.directory.resolveIds(s.coordinatorIds, ctx.calendar.today()) }, dry });
    },
  });
  return out;
}

const commands = {
  status: {
    usage: "timesheet status            who has confirmed this period",
    async run(ctx, cfg) {
      const st = status(ctx, settings(cfg));
      console.log(`Week ending ${st.period.end}: ${st.confirmed.length} confirmed, ${st.pending.length} pending, ${st.excused.length} on leave all week`);
      for (const p of st.confirmed) console.log(`  ✅ ${p.name} (${st.state.confirmed[p.id].via})`);
      for (const p of st.pending) console.log(`  ⏳ ${p.name}`);
      for (const p of st.excused) console.log(`  🌴 ${p.name}`);
    },
  },
  poll: {
    usage: "timesheet poll              read the venue now and record confirmations",
    async run(ctx, cfg) { console.log((await poll(ctx, settings(cfg))).note); },
  },
  confirm: {
    usage: "timesheet confirm <person-id> [--undo]   record (or remove) a confirmation by hand",
    async run(ctx, cfg, args) {
      const s = settings(cfg);
      const person = ctx.directory.get(args._[0]);
      if (!person) throw new Error(`unknown person "${args._[0]}"`);
      const p = period(ctx, s);
      ctx.store.update(stateFile(p.end), { confirmed: {} }, (st) => {
        if (args.undo) delete st.confirmed[person.id];
        else st.confirmed[person.id] = { via: "manual", at: new Date().toISOString() };
        return st;
      });
      console.log(`${args.undo ? "Removed" : "Recorded"} ${person.name} for the week ending ${p.end}.`);
    },
  },
};

module.exports = { key: "timesheet", title: "Timesheet compliance", validate, jobs, commands, status, settings, _test: { reminderCard, offAllPeriod } };
