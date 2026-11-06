"use strict";

/**
 * `teampilot demo` — every card TeamPilot produces, on sample data, printed to
 * the terminal. No Microsoft account, no webhooks, no API key. It creates a
 * throwaway workspace under the OS temp folder and removes it afterwards.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { addDays } = require("./core/clock");

async function run() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teampilot-demo-"));
  process.env.TEAMPILOT_HOME = home;
  const paths = require("./core/paths");
  const dir = paths.ensureDir(paths.workspaceDir("demo"));
  const T = path.join(paths.ROOT, "templates");
  fs.writeFileSync(path.join(dir, "workspace.yaml"), `
workspace: { name: Demo Co, timezone: UTC, workdays: [monday, tuesday, wednesday, thursday, friday, saturday, sunday], signoff: TeamPilot }
llm: { provider: none }
venues:
  terminal: { kind: console }
modules: {}
`);
  fs.copyFileSync(path.join(T, "people.yaml"), path.join(dir, "people.yaml"));
  fs.writeFileSync(path.join(dir, "holidays.yaml"), "holidays: []\n");

  const { createContext } = require("./core/context");
  const ctx = createContext("demo", { quiet: true });
  const standup = require("./modules/standup");
  const timesheet = require("./modules/timesheet");
  const weekly = require("./modules/weekly-report");
  const today = ctx.calendar.today();

  const team = standup.teamsOf(ctx, { teams: [{ key: "platform", name: "Platform", venue: "terminal", members: ["alex", "priya", "sam"], leads: ["jordan"], cc: ["jordan"], escalate: { to: ["jordan"], afterDays: 2 }, schedule: { checkin: "0 10 * * *" } }] })[0];
  ctx.leave.set("sam", [today], { code: "AL", source: "manual" });

  const say = async (c, job) => ctx.post({ venue: "terminal", title: c.title, body: c.body, job, mention: { people: c.mentionPool || [], cc: c.cc || [] }, dry: true });

  console.log("TeamPilot demo — sample data, nothing is posted anywhere.\n(Alex, Priya and Sam are on the Platform team; Jordan leads it; Sam is on leave today.)");

  await say(standup._test.checkinCard(ctx, team, today), "standup check-in");
  ctx.store.write(`standup/platform/${today}.json`, { date: today, byPerson: {
    alex: [{ text: "Finished the invoice export (PR #412). Today: retry logic for webhooks. No blockers.", at: new Date().toISOString() }],
  }, strangers: [] });
  await say(standup._test.nudgeCard(ctx, team, today, standup.loadDay(ctx, "platform", today)), "standup nudge");
  // Two earlier days where only Alex posted, so Priya trips the 2-day escalation.
  for (const i of [1, 2]) ctx.store.write(`standup/platform/${addDays(today, -i)}.json`, { byPerson: { alex: [{ text: "earlier update" }] }, strangers: [] });
  const sum = await standup._test.summaryCard(ctx, team, today, standup.loadDay(ctx, "platform", today));
  await say({ ...sum, cc: sum.escalateTo }, "standup summary (no LLM configured → plain version)");

  const ts = timesheet.settings({ venue: "terminal", coordinators: ["jordan"], deadline: "Friday 5 PM", link: "https://timesheets.example.com", schedule: {} });
  await say(timesheet._test.reminderCard(ctx, ts), "timesheet reminder");

  const r = await weekly.buildReport(ctx, { venue: "terminal" }, { modules: { standup: { teams: [{ key: "platform", name: "Platform", venue: "terminal", members: ["alex", "priya", "sam"] }] } } });
  await say(r, "weekly report");

  console.log("With an LLM configured, summaries and highlights are written from the actual updates (and checked by code so nobody is credited with work they didn't report).");
  console.log("\nNext: teampilot init");
  fs.rmSync(home, { recursive: true, force: true });
}

module.exports = { run };
