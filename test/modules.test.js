"use strict";

/** Module logic with a fake Teams reader and a fake LLM — no network. */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tp-mod-"));
process.env.TEAMPILOT_HOME = home;
const dir = path.join(home, "workspaces", "t");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "workspace.yaml"), `
workspace: { name: T, timezone: UTC, workdays: [monday, tuesday, wednesday, thursday, friday, saturday, sunday] }
llm: { provider: none }
venues:
  ch: { kind: console, teamId: T1, channelId: C1 }
modules: {}
`);
fs.copyFileSync(path.join(__dirname, "..", "templates", "people.yaml"), path.join(dir, "people.yaml"));

const { createContext } = require("../src/core/context");
const standup = require("../src/modules/standup");
const leave = require("../src/modules/leave");

function fakeLlm(reply) {
  const calls = [];
  return { enabled: true, names: ["fake"], calls, complete: async (req) => { calls.push(req); return typeof reply === "function" ? reply(req, calls.length) : reply; } };
}
const msg = (o) => ({ parentId: null, deleted: false, isCard: false, hasImage: false, reactions: [], mentions: [], title: "", ...o });

test("standup: collects every message per person; summary drops invented people and keeps links", async () => {
  const ctx = createContext("t", { quiet: true });
  const today = ctx.calendar.today();
  const team = standup.teamsOf(ctx, { teams: [{ key: "p", name: "Platform", venue: "ch", members: ["alex", "priya", "sam"], schedule: { summary: "0 17 * * *" } }] })[0];
  const root = msg({ id: "r", at: `${today}T09:00:00Z`, from: { isBot: true, name: "bot" }, title: standup.titles.checkin(team, today), isCard: true });
  ctx.reader.read = async () => [
    root,
    msg({ id: "1", parentId: "r", at: `${today}T09:30:00Z`, from: { aadId: "aad-alex", name: "Alex Morgan" }, text: "Shipped export, PR https://git.example.com/pr/412" }),
    msg({ id: "2", parentId: "r", at: `${today}T09:40:00Z`, from: { aadId: "aad-alex", name: "Alex Morgan" }, text: "thanks all" }),
    msg({ id: "3", at: `${today}T09:50:00Z`, from: { aadId: "x", name: "Someone Else" }, text: "unrelated root post" }),
  ];
  const day = await standup.collect(ctx, team, today);
  assert.strictEqual(day.rootId, "r");
  assert.strictEqual(day.byPerson.alex.length, 2); // follow-up doesn't erase the update
  assert.ok(!day.byPerson.priya);
  assert.strictEqual(ctx.directory.mentionId(ctx.directory.get("alex")), "aad-alex"); // id harvested

  ctx.llm = fakeLlm("Here's the summary:\n\n**Alex Morgan**\n✅ Done: shipped the export\n\n**Priya Raman**\n✅ Done: reviewed everything");
  const c = await standup._test.summaryCard(ctx, team, today, day);
  assert.match(c.body, /\*\*Alex Morgan\*\*/);
  assert.doesNotMatch(c.body, /reviewed everything/); // Priya posted nothing
  assert.match(c.body, /https:\/\/git\.example\.com\/pr\/412/); // dropped link restored
  assert.match(c.body, /No update today: \*\*Priya Raman\*\*, \*\*Sam Okafor\*\*/);
  assert.doesNotMatch(c.body, /Here's/);

  // No updates at all → deterministic, the LLM is never asked.
  ctx.llm = fakeLlm("**Alex Morgan** — big wins!");
  const empty = await standup._test.summaryCard(ctx, team, today, { byPerson: {} });
  assert.match(empty.body, /No updates were posted today/);
  assert.strictEqual(ctx.llm.calls.length, 0);
});

test("leave: extraction with aliases, intent gate, provisional + clarification, reply fixes it", async () => {
  const ctx = createContext("t", { quiet: true });
  const today = ctx.calendar.today();
  const tomorrow = require("../src/core/clock").addDays(today, 1);
  const posted = [];
  ctx.post = async (m) => { posted.push(m); return { posted: true }; };
  let feed = [
    msg({ id: "L1", at: `${today}T08:00:00Z`, from: { aadId: "p1", name: "Priya Raman" }, text: "Not feeling well, taking leave tomorrow" }),
    msg({ id: "L2", at: `${today}T08:05:00Z`, from: { aadId: "s1", name: "Sam Okafor" }, text: "@Alex Morgan can you review my PR" }),
    msg({ id: "L3", at: `${today}T08:10:00Z`, from: { aadId: "a1", name: "Alex Morgan" }, text: "I'll be off tomorrow for some personal work" }),
  ];
  ctx.reader.read = async () => feed;
  ctx.llm = fakeLlm((req) => {
    assert.match(req.prompt, /\[m1\]/); // short aliases, never raw ids
    assert.doesNotMatch(req.prompt, /review my PR/); // gated out before the model
    return JSON.stringify([
      { m: "m1", person: "Priya Raman", dates: [tomorrow], code: "SL", confidence: "high" },
      { m: "m2", person: "Alex Morgan", dates: [tomorrow], code: "XX", confidence: "low" },
      { m: "m9", person: "Sam Okafor", dates: [tomorrow], code: "AL" },
    ]);
  });
  const cfg = { sources: ["ch"], clarifyVenue: "ch", codes: { AL: "Annual leave", SL: "Sick leave" } };
  await leave.ingest(ctx, cfg);
  assert.strictEqual(ctx.leave.get("priya", tomorrow).code, "SL");
  assert.strictEqual(ctx.leave.get("alex", tomorrow).provisional, true);
  assert.strictEqual(ctx.leave.get("sam", tomorrow), null); // unknown alias m9 ignored
  assert.strictEqual(posted.length, 1);
  assert.match(posted[0].title, /^Leave check · Alex Morgan/);

  // Jordan (not Alex) replies under the bot's question: it's about Alex.
  const clarRoot = msg({ id: "Q", at: `${today}T08:20:00Z`, from: { isBot: true, name: "bot" }, title: posted[0].title, isCard: true });
  feed = [...feed, clarRoot, msg({ id: "R1", parentId: "Q", at: `${today}T09:00:00Z`, from: { aadId: "j1", name: "Jordan Lee" }, text: "yes, annual leave" })];
  ctx.llm = fakeLlm((req) => {
    assert.match(req.prompt, /It is about Alex Morgan/);
    return JSON.stringify([{ m: "m1", person: "Jordan Lee", dates: [tomorrow], code: "AL", confidence: "high" }]);
  });
  await leave.ingest(ctx, cfg);
  assert.strictEqual(ctx.leave.get("alex", tomorrow).code, "AL");
  assert.strictEqual(ctx.leave.get("alex", tomorrow).provisional, false);
  assert.strictEqual(ctx.leave.get("jordan", tomorrow), null);
  assert.ok(ctx.store.read("leave/clarifications.json", [])[0].resolved);
});
