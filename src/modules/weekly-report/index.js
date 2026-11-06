"use strict";

/**
 * Weekly report for leadership: per team, what got done (from the week's real
 * standup updates), participation, who was on leave, and timesheet status.
 * Highlights are LLM-written but roster-locked and sourced only from updates;
 * participation numbers are computed, never generated.
 */

const { check } = require("../../core/config");
const { addDays, dowOf, pretty } = require("../../core/clock");
const guards = require("../../core/llm/guards");
const standup = require("../standup");
const timesheet = require("../timesheet");

function weekStart(iso) {
  return addDays(iso, -((dowOf(iso) + 6) % 7)); // Monday
}

async function teamSection(ctx, team, days, today) {
  const roster = standup.members(ctx, team, today);
  const loaded = days.map((d) => ({ d, day: standup.loadDay(ctx, team.key, d) }));
  const rows = roster.map((p) => {
    // Only days the bot actually recorded count — never days before it was running.
    const expected = loaded.filter((x) => x.day && !ctx.leave.isOff(p.id, x.d)).length;
    const posted = loaded.filter((x) => x.day && x.day.byPerson[p.id]).length;
    return { p, expected, posted };
  });
  const exp = rows.reduce((a, r) => a + r.expected, 0);
  const got = rows.reduce((a, r) => a + Math.min(r.posted, r.expected), 0);
  const quiet = rows.filter((r) => r.expected >= 2 && r.posted === 0);
  const lines = [`**${team.name}** — updates on ${got} of ${exp} expected person-days${exp ? ` (${Math.round((100 * got) / exp)}%)` : ""}`];

  const updates = [];
  for (const { d, day } of loaded) {
    if (!day) continue;
    for (const [id, msgs] of Object.entries(day.byPerson)) {
      const p = ctx.directory.get(id);
      if (p) updates.push(`[${d}] ${p.name}: ${msgs.map((m) => m.text).join(" / ")}`);
    }
  }
  if (updates.length && ctx.llm.enabled) {
    try {
      const posters = [...new Set(updates.map((u) => u.split("] ")[1].split(":")[0]))];
      const raw = guards.stripPreamble(await ctx.llm.complete({
        system: "You write short, factual weekly highlights for leadership from a team's own standup updates. Nothing that isn't in the updates.",
        prompt: [
          `Team: ${team.name}. Week of ${days[0]}.`,
          "Write 3–6 bullets ('- ' prefix): the most important things finished or shipped, then any blocker still open at the end of the week.",
          "Credit people by **Full Name** only from this list: " + posters.join(", ") + ".",
          "Keep URLs and ticket keys exactly. Max ~25 words per bullet. No intro, no heading, no sign-off.",
          "", "UPDATES:", updates.join("\n"),
        ].join("\n"),
      }));
      lines.push(guards.keepOnlyPeople(raw, posters).text);
    } catch (e) {
      ctx.log.warn(`weekly report ${team.key}: highlights unavailable (${e.message})`);
    }
  }
  if (!updates.length) lines.push("No standup updates were recorded this week.");
  if (quiet.length) lines.push(`Quiet this week: ${quiet.map((r) => r.p.name).join(", ")}`);
  return lines.join("\n");
}

async function buildReport(ctx, cfg, config, today = ctx.calendar.today()) {
  const days = ctx.calendar.workdaysBetween(weekStart(today), today);
  const sCfg = config.modules.standup;
  const teams = sCfg && sCfg.enabled !== false ? standup.teamsOf(ctx, sCfg).filter((t) => !cfg.teams || cfg.teams.includes(t.key)) : [];
  const sections = [];
  for (const t of teams) sections.push(await teamSection(ctx, t, days, today));

  if (cfg.includeLeave !== false) {
    const e = ctx.leave.between(days[0] || today, addDays(today, 7));
    const byPerson = {};
    for (const x of e) (byPerson[x.personId] = byPerson[x.personId] || []).push(x.date);
    const lines = Object.entries(byPerson).map(([id, ds]) => `- ${(ctx.directory.get(id) || { name: id }).name}: ${ds.map(pretty).join(", ")}`);
    if (lines.length) sections.push(`**Leave this week and next**\n${lines.join("\n")}`);
  }
  const tsCfg = config.modules.timesheet;
  if (cfg.includeTimesheet !== false && tsCfg && tsCfg.enabled !== false) {
    const st = timesheet.status(ctx, timesheet.settings(tsCfg), today);
    sections.push(`**Timesheets** (week ending ${pretty(st.period.end)}): ${st.confirmed.length} of ${st.all.length - st.excused.length} confirmed${st.pending.length ? ` · pending: ${st.pending.map((p) => p.name).join(", ")}` : ""}`);
  }
  return { title: `${cfg.title || "Weekly team summary"} · week of ${pretty(weekStart(today))}`, body: sections.join("\n\n") || "Nothing to report this week." };
}

function validate(cfg, config) {
  const errors = [];
  check.venue(config, cfg.venue, "venue", errors);
  if (!cfg.schedule) errors.push("schedule is required (e.g. \"0 17 * * 5\")");
  else check.cron(cfg.schedule, "schedule", errors);
  const keys = ((config.modules.standup && config.modules.standup.teams) || []).map((t) => t.key);
  for (const k of cfg.teams || []) if (!keys.includes(k)) errors.push(`teams: "${k}" is not a standup team`);
  return errors;
}

function jobs(ctx, cfg, { dry = false } = {}) {
  const title = (d) => `${cfg.title || "Weekly team summary"} · week of ${pretty(weekStart(d))}`;
  return [{
    id: "weekly-report", cron: cfg.schedule, catchUp: true,
    expect: { venue: cfg.venue, title },
    run: async () => {
      const r = await buildReport(ctx, cfg, ctx.config);
      return ctx.post({ venue: cfg.venue, title: r.title, body: r.body, job: "weekly-report", key: `weekly-report:${weekStart(ctx.calendar.today())}`, mention: { people: [], cc: ctx.directory.resolveIds(cfg.cc || [], ctx.calendar.today()) }, dry });
    },
  }];
}

const commands = {
  preview: {
    usage: "weekly-report preview          print this week's report without posting",
    async run(ctx, cfg) {
      const r = await buildReport(ctx, cfg, ctx.config);
      console.log(`== ${r.title} ==\n\n${r.body}`);
    },
  },
};

module.exports = { key: "weeklyReport", title: "Weekly leadership report", validate, jobs, commands, buildReport };
