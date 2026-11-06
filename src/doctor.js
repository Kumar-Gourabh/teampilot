"use strict";

/**
 * `teampilot doctor <ws>` — everything that can be checked before a working day
 * goes wrong. Offline checks always; --online also signs in and reads each venue.
 */

const fs = require("fs");
const { validatePeople } = require("./core/people");
const { createRuntime } = require("./runtime");

const ID_KEYS = new Set(["members", "leads", "cc", "to", "participants", "coordinators", "owners"]);

function personRefs(node, where, out) {
  if (Array.isArray(node)) return node.forEach((x, i) => personRefs(x, `${where}[${i}]`, out));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (ID_KEYS.has(k) && Array.isArray(v)) v.forEach((id) => out.push({ id, where: `${where}.${k}` }));
    else personRefs(v, `${where}.${k}`, out);
  }
}

async function doctor(name, { online = false } = {}) {
  const rows = [];
  const ok = (m) => rows.push(["✓", m]);
  const bad = (m) => rows.push(["✗", m]);
  const warn = (m) => rows.push(["!", m]);

  let rt;
  try {
    rt = createRuntime(name, { quiet: true });
  } catch (e) {
    bad(e.message);
    return finish(rows);
  }
  const { ctx, errors, scheduler, enabled } = rt;
  const cfg = ctx.config;

  if (errors.length) errors.forEach(bad);
  else ok(`workspace.yaml is valid (${enabled.length ? enabled.join(", ") : "no modules enabled"})`);

  if (!fs.existsSync(cfg.workspace.peopleFile)) bad(`people file missing: ${cfg.workspace.peopleFile}`);
  else {
    const pe = validatePeople(ctx.directory.all());
    if (pe.length) pe.forEach(bad);
    else ok(`${ctx.directory.all().length} people (${ctx.directory.active(ctx.calendar.today()).length} active)`);
  }
  const refs = [];
  personRefs(cfg.modules, "modules", refs);
  const unknown = refs.filter((r) => !ctx.directory.get(r.id));
  unknown.forEach((r) => bad(`${r.where}: "${r.id}" is not an id in people.yaml`));
  const gone = refs.filter((r) => ctx.directory.get(r.id) && !ctx.directory.isActive(ctx.directory.get(r.id), ctx.calendar.today()));
  gone.forEach((r) => warn(`${r.where}: "${r.id}" has left (filtered automatically; tidy up when convenient)`));

  ok(`${ctx.holidays.length} holiday(s) loaded; today is ${ctx.calendar.isWorkday(ctx.calendar.today()) ? "a working day" : "not a working day"} in ${cfg.workspace.timezone}`);

  const usedVenues = new Set();
  JSON.stringify(cfg.modules, (k, v) => { if (typeof v === "string" && cfg.venues[v]) usedVenues.add(v); return v; });
  for (const vn of usedVenues) {
    const v = cfg.venues[vn];
    if (v.kind !== "console" && !ctx.secret(v.webhook)) bad(`venue ${vn}: secret ${v.webhook} is empty in .env`);
  }
  for (const vn of Object.keys(cfg.venues)) if (!usedVenues.has(vn)) warn(`venue ${vn} is defined but nothing uses it`);

  const llm = cfg.llm || {};
  if ((llm.provider || "none") === "none") warn("no LLM configured — summaries use plain fallbacks and leave must be entered by hand");
  else if (!ctx.secret(llm.apiKey || (llm.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "LLM_API_KEY"))) bad(`llm: secret ${llm.apiKey || "ANTHROPIC_API_KEY"} is empty`);
  else ok(`LLM: ${ctx.llm.names.join(" → ")}`);

  if (!errors.length) {
    for (const d of scheduler.deadSlots()) bad(`${d.job} runs at ${d.times.join(", ")} — outside workspace.uptime, it will never fire`);
    ok(`${rt.jobs.length} scheduled job(s)`);
  }

  if (online) {
    try {
      await ctx.auth.tokenSilent();
      ok(`Microsoft 365 sign-in works (${(await ctx.auth.whoAmI()).join(", ")})`);
      for (const vn of usedVenues) {
        const v = ctx.venue(vn);
        if (!v.chatId && !v.teamId) continue;
        try {
          const msgs = await ctx.reader.read(v, { from: ctx.calendar.today(), withReplies: false });
          ok(`venue ${vn} is readable (${msgs.length} message(s) today)`);
        } catch (e) {
          bad(`venue ${vn} can't be read: ${e.message.slice(0, 160)}`);
        }
      }
    } catch (e) {
      bad(e.message);
    }
  } else {
    warn("offline checks only — add --online to test sign-in and venue access");
  }
  return finish(rows);
}

function finish(rows) {
  for (const [s, m] of rows) console.log(`${s} ${m}`);
  const failed = rows.filter((r) => r[0] === "✗").length;
  console.log(failed ? `\n${failed} problem(s) to fix.` : "\nReady.");
  return failed === 0;
}

module.exports = { doctor };
