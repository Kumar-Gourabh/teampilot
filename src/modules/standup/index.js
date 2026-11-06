"use strict";

/**
 * Daily standups for any number of teams.
 *
 *   check-in  → a card asking for updates (people reply in its thread, or in a chat)
 *   nudge     → optional; tags only the people still missing (silent if all are in)
 *   summary   → what people actually wrote, summarised; who is on leave; who is
 *               missing; an escalation when someone has gone quiet for N days
 *
 * The summary never invents work: people-led lines are only kept for people who
 * posted, a day with no updates is a deterministic card (no "wins"), and when
 * the LLM is unavailable a plain fallback is posted instead of nothing.
 */

const { check } = require("../../core/config");
const { pretty } = require("../../core/clock");
const guards = require("../../core/llm/guards");

const DEFAULT_PROMPT = [
  "✅ What you finished",
  "🔜 What you're working on today",
  "🚧 Anything blocking you",
];

// ---------------------------------------------------------------------------
// Team configuration

function teamsOf(ctx, cfg) {
  return (cfg.teams || []).map((t) => ({
    key: t.key,
    name: t.name || t.key,
    venue: t.venue,
    summaryVenue: t.summaryVenue || t.venue,
    intake: t.intake || "thread",
    intakeVenue: t.intakeVenue || t.venue,
    schedule: t.schedule || {},
    memberIds: t.members || null,
    leadIds: t.leads || [],
    ccIds: t.cc || [],
    tagMissing: t.tagMissing !== false,
    escalate: t.escalate ? { to: t.escalate.to || [], afterDays: t.escalate.afterDays || 3 } : null,
    questions: t.questions || DEFAULT_PROMPT,
    context: t.context || "",
  }));
}

function members(ctx, team, date) {
  return team.memberIds ? ctx.directory.resolveIds(team.memberIds, date) : ctx.directory.inTeam(team.key, date);
}

const titles = {
  checkin: (t, d) => `${t.name} standup · ${pretty(d)}`,
  nudge: (t, d) => `${t.name} standup reminder · ${pretty(d)}`,
  summary: (t, d) => `${t.name} daily summary · ${pretty(d)}`,
};

// ---------------------------------------------------------------------------
// Reading updates

const dayFile = (team, date) => `standup/${team.key || team}/${date}.json`;

function loadDay(ctx, teamKey, date) {
  return ctx.store.read(dayFile(teamKey, date), null);
}

async function collect(ctx, team, date = ctx.calendar.today()) {
  const roster = members(ctx, team, date);
  const pool = [...roster, ...ctx.directory.resolveIds(team.leadIds, date)];
  const venue = ctx.venue(team.intakeVenue);
  const msgs = await ctx.reader.read(venue, { from: date, to: date, replyLookbackDays: 0 });

  let source = msgs.filter((m) => !m.from.isBot);
  let rootId = null;
  if (team.intake === "thread" && !venue.chatId) {
    const want = titles.checkin(team, date);
    const root = msgs.find((m) => m.from.isBot && !m.parentId && m.title.includes(want));
    if (root) {
      rootId = root.id;
      source = source.filter((m) => m.parentId === root.id);
    }
  }

  const byPerson = {};
  const harvest = [];
  const strangers = new Set();
  for (const m of source) {
    const p = ctx.directory.match({ aadId: m.from.aadId, name: m.from.name }, pool);
    if (!p) { strangers.add(m.from.name); continue; }
    if (m.from.aadId) harvest.push({ personId: p.id, aadId: m.from.aadId });
    if (!roster.some((r) => r.id === p.id)) continue; // a lead's comment isn't their standup
    // Keep EVERY message a person sent, not only the latest — a short follow-up
    // ("thanks!") must not erase the real update before it.
    (byPerson[p.id] = byPerson[p.id] || []).push({ text: m.text, at: m.at, hasImage: m.hasImage });
  }
  ctx.directory.harvest(harvest);

  const day = { date, collectedAt: new Date().toISOString(), rootId, byPerson, strangers: [...strangers] };
  ctx.store.write(dayFile(team, date), day);
  return day;
}

/** Consecutive working days without an update, not counting leave days. */
function silentStreak(ctx, team, personId, date) {
  let streak = 0;
  let d = date;
  for (let i = 0; i < 30; i++) {
    if (ctx.calendar.isWorkday(d) && !ctx.leave.isOff(personId, d)) {
      const day = loadDay(ctx, team.key, d);
      if (!day) break; // no record that far back — don't guess
      if (day.byPerson[personId]) break;
      streak++;
    }
    d = ctx.calendar.previousWorkday(d);
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Cards

function checkinCard(ctx, team, date) {
  const roster = members(ctx, team, date);
  const away = roster.filter((p) => ctx.leave.isOff(p.id, date));
  const asked = roster.filter((p) => !away.includes(p));
  const where = team.intake === "thread" ? "Reply **in this thread**" : "Reply here";
  const lines = [
    `Good morning! ${where} with your update:`,
    team.questions.join("\n"),
    asked.length ? asked.map((p) => `**${p.name}**`).join(" · ") : "",
    away.length ? `🌴 On leave today: ${away.map((p) => p.name).join(", ")}` : "",
  ];
  return { title: titles.checkin(team, date), body: lines.filter(Boolean).join("\n\n"), mentionPool: asked };
}

function pending(ctx, team, date, day) {
  return members(ctx, team, date).filter((p) => !ctx.leave.isOff(p.id, date) && !(day && day.byPerson[p.id]));
}

function nudgeCard(ctx, team, date, day) {
  const missing = pending(ctx, team, date, day);
  if (!missing.length) return null;
  const where = team.intake === "thread" ? "under today's standup post" : "in the chat";
  return {
    title: titles.nudge(team, date),
    body: `${missing.map((p) => `**${p.name}**`).join(", ")} — when you get a moment, please add today's update ${where}. 🙏`,
    mentionPool: missing,
  };
}

function summaryPrompt(team, date, posters, day, ctx) {
  const updates = posters.map((p) => `### ${p.name}\n${day.byPerson[p.id].map((u) => u.text).join("\n---\n")}`).join("\n\n");
  return {
    system: "You turn a team's standup messages into a short, accurate summary for their Microsoft Teams channel. You only report what people actually wrote. You never invent tasks, completions, wins, hours or people.",
    prompt: [
      `Team: ${team.name}. Date: ${date}.${team.context ? ` Context: ${team.context}` : ""}`,
      `Summarise ONLY these ${posters.length} people, in this order: ${posters.map((p) => p.name).join(", ")}. Anyone else named inside an update is a collaborator, not a teammate — never give them their own section.`,
      "For each person write exactly:",
      "**Full Name**\n✅ Done: <what they finished, or omit the line>\n🔜 Next: <what they're doing next, or omit the line>\n🚧 Blocker: <only if they reported one>",
      "Rules: max ~25 words per line. Keep every URL and ticket key exactly as written. Don't quote chat text verbatim beyond short phrases. Don't add headings, intros, sign-offs, or a team-level 'wins' section. Leave a blank line between people.",
      "",
      "UPDATES:",
      updates,
    ].join("\n"),
  };
}

async function summaryCard(ctx, team, date, day) {
  const roster = members(ctx, team, date);
  const away = roster.filter((p) => ctx.leave.isOff(p.id, date));
  const posters = roster.filter((p) => day.byPerson[p.id]);
  const missing = roster.filter((p) => !away.includes(p) && !posters.includes(p));
  const sections = [];
  let source = "none";

  if (!posters.length) {
    sections.push("No updates were posted today.");
  } else if (ctx.llm.enabled) {
    try {
      const raw = guards.stripPreamble(await ctx.llm.complete(summaryPrompt(team, date, posters, day, ctx)));
      const { text, dropped } = guards.keepOnlyPeople(raw, posters.map((p) => p.name));
      if (dropped.length) ctx.log.warn(`${team.key} summary: removed lines about ${dropped.join(", ")} (no update from them)`);
      const allText = posters.flatMap((p) => day.byPerson[p.id].map((u) => u.text)).join("\n");
      const lost = guards.lostLinks(allText, text);
      sections.push(text);
      if (lost.length) sections.push(`🔗 Links shared today:\n${lost.map((u) => `- ${u}`).join("\n")}`);
      source = "llm";
    } catch (e) {
      ctx.log.warn(`${team.key} summary: LLM unavailable (${e.message}); posting the plain version`);
    }
  }
  if (posters.length && source !== "llm") {
    sections.push(posters.map((p) => `**${p.name}** — posted ${day.byPerson[p.id].length} update${day.byPerson[p.id].length > 1 ? "s" : ""}`).join("\n"));
    sections.push("_The full updates are in today's thread._");
    source = "fallback";
  }

  if (away.length) sections.push(`🌴 On leave: ${away.map((p) => p.name).join(", ")}`);
  if (missing.length) sections.push(`⏳ No update today: ${missing.map((p) => (team.tagMissing ? `**${p.name}**` : p.name)).join(", ")}`);

  let escalateTo = [];
  if (team.escalate) {
    const quiet = missing.map((p) => ({ p, n: silentStreak(ctx, team, p.id, date) })).filter((x) => x.n >= team.escalate.afterDays);
    if (quiet.length) {
      sections.push(`⚠️ Needs attention — no update for several working days: ${quiet.map((x) => `${x.p.name} (${x.n} days)`).join(", ")}`);
      escalateTo = ctx.directory.resolveIds(team.escalate.to, date);
    }
  }

  return {
    title: titles.summary(team, date),
    body: sections.join("\n\n"),
    mentionPool: team.tagMissing ? [...posters, ...missing] : posters,
    escalateTo,
    meta: { source, posters: posters.map((p) => p.id), missing: missing.map((p) => p.id), away: away.map((p) => p.id) },
  };
}

// ---------------------------------------------------------------------------
// Module

function validate(cfg, config) {
  const errors = [];
  if (!Array.isArray(cfg.teams) || !cfg.teams.length) return ["teams: list at least one team"];
  const keys = new Set();
  cfg.teams.forEach((t, i) => {
    const w = `teams[${i}]${t && t.key ? ` (${t.key})` : ""}`;
    if (!t.key || !/^[a-z0-9-]+$/.test(t.key)) errors.push(`${w}: key is required (lowercase letters, numbers, -)`);
    if (keys.has(t.key)) errors.push(`${w}: duplicate key`);
    keys.add(t.key);
    check.venue(config, t.venue, `${w}.venue`, errors, { readable: !t.intakeVenue });
    if (t.intakeVenue) check.venue(config, t.intakeVenue, `${w}.intakeVenue`, errors, { readable: true });
    if (t.summaryVenue) check.venue(config, t.summaryVenue, `${w}.summaryVenue`, errors);
    if (!["thread", "venue"].includes(t.intake || "thread")) errors.push(`${w}.intake must be "thread" or "venue"`);
    const s = t.schedule || {};
    if (!s.checkin && !s.summary) errors.push(`${w}.schedule: give at least checkin or summary`);
    for (const k of Object.keys(s)) {
      if (!["checkin", "nudge", "summary"].includes(k)) errors.push(`${w}.schedule.${k}: unknown (checkin, nudge, summary)`);
      else check.cron(s[k], `${w}.schedule.${k}`, errors);
    }
  });
  return errors;
}

function jobs(ctx, cfg, { dry = false } = {}) {
  const out = [];
  for (const team of teamsOf(ctx, cfg)) {
    const s = team.schedule;
    const base = { team: team.key };
    if (s.checkin) out.push({
      ...base, id: `standup:${team.key}:checkin`, cron: s.checkin, catchUp: true,
      expect: { venue: team.venue, title: (d) => titles.checkin(team, d) },
      run: async () => {
        const date = ctx.calendar.today();
        const c = checkinCard(ctx, team, date);
        return ctx.post({ venue: team.venue, title: c.title, body: c.body, job: `standup:${team.key}:checkin`, key: `standup:${team.key}:checkin:${date}`, mention: { people: c.mentionPool }, dry });
      },
    });
    if (s.nudge) out.push({
      ...base, id: `standup:${team.key}:nudge`, cron: s.nudge, catchUp: false,
      expect: { venue: team.venue, title: (d) => titles.nudge(team, d), conditional: true },
      run: async () => {
        const date = ctx.calendar.today();
        const day = await collect(ctx, team, date);
        const c = nudgeCard(ctx, team, date, day);
        if (!c) return { note: "everyone has posted — no reminder needed" };
        return ctx.post({ venue: team.venue, title: c.title, body: c.body, job: `standup:${team.key}:nudge`, key: `standup:${team.key}:nudge:${date}:${ctx.calendar.now().minutes}`, mention: { people: c.mentionPool }, dry });
      },
    });
    if (s.summary) out.push({
      ...base, id: `standup:${team.key}:summary`, cron: s.summary, catchUp: true,
      expect: { venue: team.summaryVenue, title: (d) => titles.summary(team, d), summary: true },
      run: async () => {
        const date = ctx.calendar.today();
        const day = await collect(ctx, team, date);
        const c = await summaryCard(ctx, team, date, day);
        return ctx.post({
          venue: team.summaryVenue, title: c.title, body: c.body, job: `standup:${team.key}:summary`, key: `standup:${team.key}:summary:${date}`,
          mention: { people: c.mentionPool, cc: [...ctx.directory.resolveIds(team.ccIds, date), ...c.escalateTo] }, meta: { ...c.meta, team: team.key }, dry,
        });
      },
    });
  }
  return out;
}

const commands = {
  collect: {
    usage: "standup collect <team> [--date YYYY-MM-DD]   read today's updates and print who posted",
    async run(ctx, cfg, args) {
      const team = teamsOf(ctx, cfg).find((t) => t.key === args._[0]);
      if (!team) throw new Error(`no standup team "${args._[0]}"`);
      const day = await collect(ctx, team, args.date || ctx.calendar.today());
      for (const p of members(ctx, team, day.date)) {
        const u = day.byPerson[p.id];
        console.log(`${u ? "✅" : ctx.leave.isOff(p.id, day.date) ? "🌴" : "⏳"} ${p.name}${u ? ` — ${u.length} message(s)` : ""}`);
      }
      if (day.strangers.length) console.log(`(not on the roster: ${day.strangers.join(", ")})`);
      if (team.intake === "thread" && !day.rootId) console.log("(no check-in card found today — counted every message in the venue)");
    },
  },
  streaks: {
    usage: "standup streaks <team>   working days since each member last posted",
    async run(ctx, cfg, args) {
      const team = teamsOf(ctx, cfg).find((t) => t.key === args._[0]);
      if (!team) throw new Error(`no standup team "${args._[0]}"`);
      const date = ctx.calendar.today();
      for (const p of members(ctx, team, date)) console.log(`${String(silentStreak(ctx, team, p.id, date)).padStart(3)}  ${p.name}`);
    },
  },
};

module.exports = {
  key: "standup",
  title: "Daily standups",
  validate,
  jobs,
  commands,
  // used by other modules
  teamsOf, members, loadDay, collect, silentStreak, titles,
  _test: { checkinCard, nudgeCard, summaryCard },
};
