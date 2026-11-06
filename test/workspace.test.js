"use strict";

/**
 * End-to-end over a real workspace on disk: init → validate → dry-run jobs
 * through the Teams-workflow path (mentions decorated, nothing sent), and the
 * supervisor catching a missing post and an invented summary line.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "teampilot.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tp-ws-"));
process.env.TEAMPILOT_HOME = home;

const cli = (...a) => execFileSync(process.execPath, [BIN, ...a], { env: { ...process.env, TEAMPILOT_HOME: home }, encoding: "utf8" });

test("init creates a workspace that doctor checks", () => {
  cli("init", "acme", "--yes");
  const dir = path.join(home, "workspaces", "acme");
  for (const f of ["workspace.yaml", "people.yaml", "holidays.yaml", ".env"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.strictEqual(fs.statSync(path.join(dir, ".env")).mode & 0o077, 0);
  // Fresh template: ids and secrets are blank, so doctor must fail — loudly and specifically.
  let out = "";
  try { cli("doctor", "acme"); } catch (e) { out = e.stdout; }
  assert.match(out, /must be readable/);
  assert.match(out, /WEBHOOK_STANDUP is empty/);
});

test("a configured workspace dry-runs every job and the supervisor catches problems", async () => {
  const dir = path.join(home, "workspaces", "acme");
  let ws = fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8");
  ws = ws.replace(/teamId: ""/g, 'teamId: "T1"').replace(/channelId: ""/g, 'channelId: "C1"').replace(/chatId: ""/g, 'chatId: "19:abc"');
  ws = ws.replace("provider: anthropic", "provider: none");
  ws = ws.replace(/catchUpMinutes: 180/, "catchUpMinutes: 180\n  uptime: { from: \"09:00\", to: \"18:00\" }");
  fs.writeFileSync(path.join(dir, "workspace.yaml"), ws);
  fs.writeFileSync(path.join(dir, ".env"), ["STANDUP", "TIMESHEET", "LEAVE", "LEADERSHIP", "ALERTS"].map((v) => `WEBHOOK_${v}=https://example.invalid/${v}`).join("\n"));

  const { createRuntime } = require("../src/runtime");
  const rt = createRuntime("acme", { dry: true, quiet: true });
  // leave needs an LLM; everything else validates
  assert.deepStrictEqual(rt.errors.filter((e) => !/needs an LLM/.test(e)), []);
  fs.writeFileSync(path.join(dir, "workspace.yaml"), ws.replace(/leave:\n    enabled: true/, "leave:\n    enabled: false"));

  const rt2 = createRuntime("acme", { dry: true, quiet: true });
  assert.deepStrictEqual(rt2.errors, []);
  const ids = rt2.jobs.map((j) => j.id);
  for (const id of ["standup:platform:checkin", "standup:platform:summary", "timesheet:reminder", "weekly-report", "supervisor:pass", "supervisor:end-of-day"]) assert.ok(ids.includes(id), id);
  assert.deepStrictEqual(rt2.scheduler.deadSlots().map((d) => d.job), ["supervisor:end-of-day"]); // 18:30 is outside 09:00–18:00

  // Dry check-in through the teams-workflow path: tags people, posts nothing, records nothing.
  const { ctx } = rt2;
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    await rt2.jobs.find((j) => j.id === "standup:platform:checkin").run();
  } finally { console.log = orig; }
  assert.match(logs.join("\n"), /would tag: Alex Morgan, Priya Raman, Sam Okafor/);
  assert.strictEqual(ctx.delivery.postsOn(ctx.calendar.today()).length, 0);

  // Supervisor: a summary line for someone who didn't post, plus a missed check-in.
  const today = ctx.calendar.today();
  ctx.store.append(`posts/${today}.jsonl`, {
    at: new Date(Date.now() - 3600e3).toISOString(), date: today, job: "standup:platform:summary", key: "k", venue: "standup-channel", title: "t",
    body: "**Alex Morgan**\n✅ Done: shipped\n\n**Sam Okafor**\n✅ Done: invented", tagged: [], untagged: [], meta: { posters: ["alex"], missing: ["priya"], away: [] },
  });
  const sup = require("../src/modules/supervisor");
  const fakeScheduler = { ...rt2.scheduler, runsOn: () => ({}), slotsToday: () => [0] };
  ctx.config.identity.graph.enabled = false;
  const findings = await sup.runChecks(ctx, { graceMinutes: 0, verifyDelivery: false, quietDays: 3 }, { allJobs: rt2.jobs, scheduler: fakeScheduler, date: today });
  const whats = findings.map((f) => `${f.area}: ${f.what}`).join("\n");
  if (ctx.calendar.isWorkday(today)) {
    assert.match(whats, /Sam Okafor", who didn't post/);
    assert.match(whats, /standup:platform:checkin: no post today/);
  }
});
