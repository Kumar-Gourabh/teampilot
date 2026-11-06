#!/usr/bin/env node
"use strict";

// Node prefers IPv6 when a host has an AAAA record; on a host without an IPv6
// route every webhook POST then fails while reads keep working. Prefer IPv4.
require("dns").setDefaultResultOrder("ipv4first");

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const BOOL_FLAGS = new Set(["dry", "half", "undo", "fallback", "end-of-day", "yes", "online", "help", "force"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) args[k] = inline;
      else if (BOOL_FLAGS.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) args[k] = true;
      else args[k] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.home) process.env.TEAMPILOT_HOME = path.resolve(String(args.home));

const paths = require("../src/core/paths");
const pkg = require("../package.json");

const HELP = `TeamPilot ${pkg.version} — team operations autopilot for Microsoft Teams

Set up
  teampilot init [workspace] [--yes]        create a workspace (one per company or project)
  teampilot demo                            see every card on sample data — no accounts needed
  teampilot login <ws> [--fallback]         sign in to Microsoft 365 (device code, once)
  teampilot discover <ws>                   list the teams, channels and chats you can use
  teampilot doctor <ws> [--online]          check config, secrets, sign-in and venues
  teampilot workspaces                      list workspaces

Run
  teampilot start <ws>                      run the scheduler (use a service; see teampilot service)
  teampilot jobs <ws>                       every job and when it runs today
  teampilot run <ws> <job-id> [--dry]       run one job now (--dry prints, posts nothing)
  teampilot service <ws> [systemd|launchd]  print a service definition for this host

Modules
  teampilot standup <ws> collect <team> | streaks <team>
  teampilot timesheet <ws> status | poll | confirm <person> [--undo]
  teampilot leave <ws> ingest [--dry] | list | set <person> <from> [to] --code X | clear | export
  teampilot weekly-report <ws> preview
  teampilot supervisor <ws> check [--end-of-day]

People
  teampilot people <ws> [list]              the directory, with who has left
  teampilot people <ws> depart <id> <last-working-day>

Options
  --home <dir>   where workspaces live (default ~/.teampilot, or $TEAMPILOT_HOME)
`;

function ask(rl, q, def) {
  return new Promise((res) => rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => res(a.trim() || def || "")));
}

async function init(name) {
  const yes = !!args.yes || !process.stdin.isTTY;
  const rl = yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = (text, def) => (yes ? Promise.resolve(def) : ask(rl, text, def));
  try {
    name = name || (await q("Workspace name (letters, numbers, -)", "my-team"));
    const dir = paths.workspaceDir(name);
    if (fs.existsSync(path.join(dir, "workspace.yaml"))) throw new Error(`workspace "${name}" already exists at ${dir}`);
    const display = await q("Organisation or project name", name);
    const tz = await q("Timezone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    const yn = async (m, d = "y") => /^y/i.test(await q(`Enable ${m}? (y/n)`, d));
    const flags = {
      __STANDUP__: await yn("daily standups"),
      __TIMESHEET__: await yn("weekly timesheet compliance"),
      __LEAVE__: await yn("leave tracking"),
      __WEEKLY__: await yn("the weekly leadership report"),
      __SUPERVISOR__: await yn("the supervisor"),
    };
    const T = path.join(paths.ROOT, "templates");
    let ws = fs.readFileSync(path.join(T, "workspace.yaml"), "utf8")
      .replace(/__WORKSPACE__/g, name).replace(/__DISPLAY_NAME__/g, display.replace(/"/g, "'")).replace(/__TIMEZONE__/g, tz);
    for (const [k, v] of Object.entries(flags)) ws = ws.replace(new RegExp(k, "g"), String(v));
    paths.ensureDir(path.join(dir, "secrets"));
    fs.writeFileSync(path.join(dir, "workspace.yaml"), ws);
    fs.copyFileSync(path.join(T, "people.yaml"), path.join(dir, "people.yaml"));
    fs.copyFileSync(path.join(T, "holidays.yaml"), path.join(dir, "holidays.yaml"));
    fs.writeFileSync(path.join(dir, ".env"), fs.readFileSync(path.join(T, "env.example"), "utf8"), { mode: 0o600 });
    fs.chmodSync(path.join(dir, "secrets"), 0o700);
    console.log(`\nCreated ${dir}\n
Next:
  1. Edit people.yaml (your people) and holidays.yaml.
  2. Create a Teams Workflows webhook per venue and paste the URLs into .env.
  3. teampilot login ${name}          sign in with the bot account
  4. teampilot discover ${name}       copy team/channel/chat ids into workspace.yaml
  5. teampilot doctor ${name} --online
  6. teampilot run ${name} <job-id> --dry, then install the service (teampilot service ${name})`);
  } finally {
    if (rl) rl.close();
  }
}

function needWs() {
  const ws = args._[1];
  if (!ws) throw new Error("name a workspace (teampilot workspaces lists them)");
  if (!paths.listWorkspaces().includes(ws)) throw new Error(`no workspace "${ws}" in ${paths.workspacesDir()}`);
  return ws;
}

function runtime(ws, opts = {}) {
  const { createRuntime } = require("../src/runtime");
  const rt = createRuntime(ws, opts);
  if (rt.errors.length) throw new Error(`workspace.yaml has problems:\n  - ${rt.errors.join("\n  - ")}\nRun: teampilot doctor ${ws}`);
  return rt;
}

function serviceText(ws, kind) {
  const node = process.execPath;
  const bin = path.join(paths.ROOT, "bin", "teampilot.js");
  const home = paths.home();
  if (kind === "launchd") {
    return fs.readFileSync(path.join(paths.ROOT, "deploy", "launchd", "com.teampilot.workspace.plist"), "utf8")
      .replace(/__WS__/g, ws).replace(/__NODE__/g, node).replace(/__BIN__/g, bin).replace(/__HOME__/g, home);
  }
  return fs.readFileSync(path.join(paths.ROOT, "deploy", "systemd", "teampilot@.service"), "utf8")
    .replace(/__NODE__/g, node).replace(/__BIN__/g, bin).replace(/__HOME__/g, home).replace(/__USER__/g, require("os").userInfo().username)
    + `\n# Install (as root):\n#   cp this file to /etc/systemd/system/teampilot@.service\n#   systemctl daemon-reload && systemctl enable --now teampilot@${ws}\n#   systemctl is-enabled teampilot@${ws}   # verify it survives a reboot\n`;
}

async function main() {
  const cmd = args._[0];
  if (!cmd || args.help || cmd === "help") return console.log(HELP);
  if (cmd === "version" || cmd === "--version") return console.log(pkg.version);
  if (cmd === "init") return init(args._[1]);
  if (cmd === "demo") return require("../src/demo").run();
  if (cmd === "workspaces") {
    const list = paths.listWorkspaces();
    return console.log(list.length ? list.join("\n") : `No workspaces in ${paths.workspacesDir()} — run: teampilot init`);
  }

  if (cmd === "doctor") {
    const ok = await require("../src/doctor").doctor(needWs(), { online: !!args.online });
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (cmd === "login") {
    const ws = needWs();
    const { ctx } = require("../src/runtime").createRuntime(ws, { quiet: true });
    const auth = args.fallback ? ctx.fallbackAuth : ctx.auth;
    if (!auth) throw new Error("no fallback identity configured (identity.graph.fallback in workspace.yaml)");
    const r = await auth.login((m) => console.log(`\n${m}\n`));
    return console.log(`Signed in as ${r.username}. Token cache: ${auth.cachePath}`);
  }
  if (cmd === "discover") {
    const { ctx } = require("../src/runtime").createRuntime(needWs(), { quiet: true });
    const d = await ctx.reader.discover();
    for (const t of d.teams) {
      console.log(`\nTeam: ${t.name}\n  teamId: ${t.teamId}`);
      for (const c of t.channels) console.log(`  - ${c.name}\n      channelId: ${c.channelId}`);
    }
    console.log("\nChats:");
    for (const c of d.chats) console.log(`  - ${c.topic} (${c.type})\n      chatId: ${c.chatId}`);
    return;
  }
  if (cmd === "jobs") {
    const rt = runtime(needWs(), { quiet: true });
    const today = rt.ctx.calendar.today();
    console.log(`${today} — ${rt.ctx.calendar.isWorkday(today) ? "working day" : rt.ctx.calendar.holiday(today) || "not a working day"} (${rt.ctx.config.workspace.timezone})\n`);
    for (const j of rt.scheduler.list()) console.log(`${j.id.padEnd(34)} ${j.cron.join(" | ").padEnd(30)} today: ${j.today.join(", ") || "—"}${j.catchUp ? "  (catch-up)" : ""}`);
    return;
  }
  if (cmd === "run") {
    const ws = needWs();
    const rt = runtime(ws, { dry: !!args.dry, quiet: true });
    const job = rt.jobs.find((j) => j.id === args._[2]);
    if (!job) throw new Error(`no job "${args._[2]}". Jobs: ${rt.jobs.map((j) => j.id).join(", ")}`);
    const r = await job.run();
    if (r && r.note) console.log(r.note);
    if (r && r.skipped) console.log(`skipped: ${r.skipped}`);
    return;
  }
  if (cmd === "start") {
    const ws = needWs();
    const rt = runtime(ws);
    rt.scheduler.start();
    rt.ctx.log.info(`TeamPilot ${pkg.version} started for "${ws}" — ${rt.jobs.length} job(s), modules: ${rt.enabled.join(", ")}`);
    for (const j of rt.scheduler.list()) rt.ctx.log.info(`  ${j.id}: ${j.cron.join(" | ")}`);
    const stop = (sig) => { rt.ctx.log.info(`stopping (${sig})`); process.exit(0); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return new Promise(() => {}); // keep running
  }
  if (cmd === "service") {
    const ws = needWs();
    return console.log(serviceText(ws, args._[2] || (process.platform === "darwin" ? "launchd" : "systemd")));
  }
  if (cmd === "people") {
    const ws = needWs();
    const sub = args._[2] || "list";
    const rt = require("../src/runtime").createRuntime(ws, { quiet: true });
    const today = rt.ctx.calendar.today();
    if (sub === "list") {
      for (const p of rt.ctx.directory.all()) {
        console.log(`${p.id.padEnd(16)} ${p.name.padEnd(28)} ${(p.teams || []).join(",").padEnd(16)} ${rt.ctx.directory.isActive(p, today) ? "" : `left ${p.departedOn}`}`);
      }
      return;
    }
    if (sub === "depart") {
      const [id, date] = args._.slice(3);
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("usage: teampilot people <ws> depart <id> <YYYY-MM-DD last working day>");
      const YAML = require("yaml");
      const file = rt.ctx.config.workspace.peopleFile;
      const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
      const list = doc.get("people");
      const node = list && list.items.find((n) => n.get("id") === id);
      if (!node) throw new Error(`no person "${id}"`);
      node.set("departedOn", date);
      fs.writeFileSync(file, doc.toString());
      return console.log(`${node.get("name")} marked as leaving; last working day ${date}. They drop out of every module from the next day. History is kept.`);
    }
    throw new Error(`unknown people command "${sub}"`);
  }

  const { moduleByCli } = require("../src/runtime");
  const m = moduleByCli(cmd);
  if (m) {
    const ws = needWs();
    const rt = runtime(ws, { quiet: true });
    const cfg = rt.ctx.config.modules[m.key];
    if (!cfg || cfg.enabled === false) throw new Error(`${m.key} is not enabled in ${ws}`);
    const sub = args._[2];
    const c = m.mod.commands && m.mod.commands[sub];
    if (!c) {
      console.log(`Commands for ${cmd}:\n${Object.values(m.mod.commands || {}).map((x) => `  teampilot ${cmd} ${ws} ${x.usage}`).join("\n")}`);
      return;
    }
    return c.run(rt.ctx, cfg, { ...args, _: args._.slice(3) }, rt);
  }
  console.log(HELP);
  process.exitCode = 1;
}

// `start` never resolves; every other command exits when done (open handles such
// as MSAL's cache plugin would otherwise keep the process alive).
main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
