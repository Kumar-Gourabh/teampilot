"use strict";

/**
 * Leave tracking from what people already write in Teams ("I'm off Friday",
 * "sick today", "on leave 3–7 Nov").
 *
 *   ingest  → read the source venues, extract leave with the LLM, write the ledger,
 *             ask a clarification question when unsure
 *   digest  → optional "Out today" card
 *
 * Design notes:
 *  - Intent gate: a message with no leave/absence signal is never turned into
 *    leave (an @mention or a greeting is not a day off).
 *  - The model gets a date→weekday table reaching back AND forward — models guess
 *    weekday arithmetic, and "I was off yesterday" needs past dates.
 *  - Messages go to the model under short aliases (m1, m2…) — long Teams ids get
 *    mangled by models, and a mangled id would attach leave to the wrong message.
 *  - Replies count, including replies under posts several days old.
 *  - A reply under the bot's own clarification question is about the person the
 *    question was about, not about whoever replied.
 *  - Unsure → recorded as provisional + one clarification card. Manual
 *    corrections are never overwritten by automation.
 */

const crypto = require("crypto");
const { check } = require("../../core/config");
const { addDays, pretty, weekdayName, range } = require("../../core/clock");
const guards = require("../../core/llm/guards");

const LEAVE_RE = new RegExp([
  "\\bleaves?\\b", "\\bon\\s+leave\\b", "\\bday'?s?\\s*off\\b", "\\boff\\s+(today|tomorrow|on|this|next|for|the|until|till|from)\\b",
  "\\bo\\.?o\\.?o\\.?\\b", "\\bout\\s+of\\s+(the\\s+)?office\\b", "\\bholiday\\b", "\\bvacation\\b", "\\bpto\\b", "\\btime\\s*off\\b",
  "\\bsick\\b", "\\bunwell\\b", "\\bill\\b", "\\bfever\\b", "\\bmedical\\b", "\\bhospital\\b", "\\bemergency\\b", "\\bdoctor\\b",
  "\\bhalf[\\s-]?day\\b", "\\baway\\b", "\\bunavailable\\b", "\\babsent\\b", "\\bnot\\s+(available|coming|working|in)\\b",
  "\\bwo(n'?t|uld\\s+not)\\s+be\\s+(in|available|coming|working|around|online)\\b", "\\bwill\\s+not\\s+be\\s+(in|available|coming|working|around|online)\\b",
  "\\bunpaid\\b", "\\bcomp[\\s-]?off\\b", "\\bcancel", "\\bresum(e|ing)\\b", "\\bback\\s+(tomorrow|on|from)\\b",
].join("|"), "i");
const ABSENCE_RE = /\b(?:wo(?:n'?t)|will\s+not|shall\s+not|cannot|can'?t|couldn'?t|unable|not)\s+(?:be\s+)?(?:able\s+)?(?:to\s+)?(?:be\s+)?(?:join|joining|come|coming|attend|attending|make\s+it|work|working|log\s*in|be\s+present)\b/i;
const MEETING_RE = /^\W*(?:the\s+|today'?s?\s+|this\s+)*(?:call|meeting|standup|stand-up|sync|scrum|huddle|session|discussion|interview|review|demo)\b/i;

function hasLeaveIntent(text) {
  const s = String(text || "");
  if (LEAVE_RE.test(s)) return true;
  const m = ABSENCE_RE.exec(s);
  return !!m && !MEETING_RE.test(s.slice(m.index + m[0].length, m.index + m[0].length + 40));
}

function settings(cfg) {
  return {
    sources: cfg.sources || [],
    codes: cfg.codes || { AL: "Annual leave", SL: "Sick leave", UL: "Unpaid leave" },
    defaultCode: cfg.defaultCode || "AL",
    clarifyVenue: cfg.clarifyVenue || null,
    digestVenue: cfg.digestVenue || null,
    lookbackDays: cfg.lookbackDays || 7,
    schedule: cfg.schedule || {},
  };
}

const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const clarifyTitle = (name, dates) => `Leave check · ${name} · ${dates.length > 1 ? `${pretty(dates[0])} – ${pretty(dates[dates.length - 1])}` : pretty(dates[0])}`;

function calendarTable(ctx, from, to) {
  return range(from, to).map((d) => `${d} = ${weekdayName(d)}${ctx.calendar.holiday(d) ? ` (holiday: ${ctx.calendar.holiday(d)})` : ""}`).join("\n");
}

function extractionPrompt(ctx, s, batch, today) {
  const people = ctx.directory.active(today).map((p) => [p.name, p.email, ...(p.aliases || [])].filter(Boolean).join(" | ")).join("\n");
  const codes = Object.entries(s.codes).map(([k, v]) => `${k} = ${v}`).join("\n");
  const msgs = batch.map((b) => [
    `[${b.alias}] ${b.localDate} ${b.localTime} — from: ${b.m.from.name}`,
    b.about ? `(This is a reply to the bot's question about ${b.about.name}'s leave on ${b.about.dates.join(", ")} recorded as ${b.about.code}. It is about ${b.about.name}.)` : "",
    b.m.text,
  ].filter(Boolean).join("\n")).join("\n\n");
  return {
    system: "You extract leave (time off) from workplace chat messages into strict JSON. You never guess dates from weekday arithmetic — you look them up in the calendar table.",
    prompt: [
      `Today is ${today} (${weekdayName(today)}).`,
      "CALENDAR (use it for every date — 'tomorrow', 'next Monday', 'yesterday' are relative to the MESSAGE date, not today):",
      calendarTable(ctx, addDays(today, -(s.lookbackDays + 14)), addDays(today, 45)),
      "",
      "PEOPLE (name | email | aliases):", people,
      "",
      "LEAVE CODES:", codes, "CANCEL = the person says a previously announced leave is cancelled",
      "",
      "Return a JSON array, one object per leave announcement:",
      '{"m":"<alias like m3>","person":"<full name from PEOPLE; the sender unless they announce for someone else>","dates":["YYYY-MM-DD",...],"code":"<code>","half":false,"confidence":"high|low","why":"<5-10 words>"}',
      "Rules:",
      "- Only actual time off. Declining a meeting, working from home, being late, or just @mentioning someone is NOT leave.",
      "- List every working date covered; skip weekends.",
      "- Use the code the message implies (sick → sick code). If the type is unclear, use the most general code and confidence \"low\".",
      "- confidence \"low\" when the dates or the person are ambiguous.",
      "- No leave in a message → no object for it. If none at all, return [].",
      "",
      "MESSAGES:", msgs,
    ].join("\n"),
  };
}

async function ingest(ctx, cfg, { dry = false } = {}) {
  const s = settings(cfg);
  if (!ctx.llm.enabled) return { note: "no LLM configured — leave can only be recorded by hand (teampilot leave set)" };
  const today = ctx.calendar.today();
  const from = addDays(today, -s.lookbackDays);
  const processed = ctx.store.read("leave/processed.json", {});
  const clar = ctx.store.read("leave/clarifications.json", []);

  const candidates = [];
  for (const vn of s.sources) {
    const venue = ctx.venue(vn);
    const msgs = await ctx.reader.read(venue, { from, to: today, replyLookbackDays: s.lookbackDays });
    const byId = new Map(msgs.map((m) => [m.id, m]));
    for (const m of msgs) {
      if (m.from.isBot || !m.text) continue;
      const h = hash(m.text);
      if (processed[m.id] && processed[m.id].h === h) continue;
      const parent = m.parentId ? byId.get(m.parentId) : null;
      const q = parent && parent.from.isBot ? clar.find((c) => !c.resolved && parent.title.includes(c.title)) : null;
      if (!q && !hasLeaveIntent(m.text)) {
        processed[m.id] = { h, at: new Date().toISOString(), result: "no leave intent" };
        continue;
      }
      candidates.push({ m, h, venue: vn, about: q || null, localDate: ctx.reader.localDate(m.at), localTime: ctx.calendar.localTime(m.at) });
    }
  }

  const applied = [];
  for (let i = 0; i < candidates.length; i += 20) {
    const batch = candidates.slice(i, i + 20).map((c, j) => ({ ...c, alias: `m${i + j + 1}` }));
    let events;
    try {
      events = guards.parseJsonLoose(await ctx.llm.complete(extractionPrompt(ctx, s, batch, today)));
      if (!Array.isArray(events)) throw new Error("model did not return a list");
    } catch (e) {
      ctx.log.warn(`leave: extraction failed for ${batch.length} message(s): ${e.message} — they will be retried next run`);
      continue; // not marked processed → retried
    }
    for (const b of batch) processed[b.m.id] = { h: b.h, at: new Date().toISOString(), result: "no leave" };

    for (const e of events) {
      const b = batch.find((x) => x.alias === String(e.m || "").trim());
      if (!b) { ctx.log.warn(`leave: model referenced unknown message "${e.m}" — ignored`); continue; }
      const pool = ctx.directory.active(today);
      const person = b.about ? ctx.directory.get(b.about.personId)
        : ctx.directory.match({ name: e.person }, pool) || ctx.directory.match({ aadId: b.m.from.aadId, name: b.m.from.name }, pool);
      if (!person) { ctx.log.warn(`leave: "${e.person}" (from ${b.m.from.name}) is not in people.yaml — skipped`); continue; }
      const dates = [...new Set((e.dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))]
        .filter((d) => d >= addDays(b.localDate, -31) && d <= addDays(b.localDate, 120) && ctx.calendar.isWorkday(d)).sort();
      if (!dates.length) continue;
      const code = String(e.code || "").toUpperCase();
      const result = { person: person.name, dates, code, from: b.m.from.name, why: e.why, venue: b.venue };

      if (code === "CANCEL") {
        result.cleared = dry ? dates : ctx.leave.clear(person.id, dates);
        applied.push(result);
        continue;
      }
      const known = Object.prototype.hasOwnProperty.call(s.codes, code);
      const provisional = !known || e.confidence === "low";
      const finalCode = known ? code : s.defaultCode;
      if (b.about) {
        // An answer to our question: replace what we recorded provisionally.
        if (!dry) {
          ctx.leave.clear(person.id, b.about.dates);
          const c = clar.find((x) => x.id === b.about.id);
          if (c) Object.assign(c, { resolved: true, resolvedAt: new Date().toISOString(), answer: b.m.text.slice(0, 200) });
        }
      }
      result.code = finalCode;
      result.provisional = provisional && !b.about;
      if (!dry) {
        const r = ctx.leave.set(person.id, dates, { code: finalCode, half: !!e.half, source: "auto", provisional: result.provisional, ref: `${b.venue}:${b.m.id}`, note: e.why });
        result.kept = r.kept;
      }
      applied.push(result);

      if (result.provisional && s.clarifyVenue) {
        const t = clarifyTitle(person.name, dates);
        if (!clar.some((c) => c.title === t)) {
          const body = [
            `**${person.name}** — we've noted ${dates.length > 1 ? `${pretty(dates[0])} to ${pretty(dates[dates.length - 1])}` : pretty(dates[0])} as **${s.codes[finalCode]}**${e.half ? " (half day)" : ""}.`,
            "If that's not right, reply under this message with the correct dates or type — it updates automatically.",
          ].join("\n\n");
          await ctx.post({ venue: s.clarifyVenue, title: t, body, job: "leave:clarify", key: `leave:clarify:${hash(t)}`, mention: { people: [person] }, dry });
          if (!dry) clar.push({ id: hash(t), title: t, personId: person.id, name: person.name, dates, code: finalCode, askedAt: new Date().toISOString(), resolved: false });
        }
      }
    }
  }

  if (!dry) {
    ctx.store.write("leave/processed.json", processed);
    ctx.store.write("leave/clarifications.json", clar);
    ctx.store.write("leave/last-ingest.json", { at: new Date().toISOString(), candidates: candidates.length, applied: applied.length });
  }
  if (dry) for (const a of applied) console.log(`${a.provisional ? "?" : "✓"} ${a.person}: ${a.dates.join(", ")} ${a.code}${a.cleared ? " (cancel)" : ""} — ${a.why || ""} [from ${a.from}]`);
  return { note: `${candidates.length} candidate message(s), ${applied.length} leave record(s)`, applied };
}

function digestCard(ctx, s) {
  const today = ctx.calendar.today();
  const rows = ctx.leave.on(today).map((e) => ({ p: ctx.directory.get(e.personId), e })).filter((x) => x.p && ctx.directory.isActive(x.p, today));
  if (!rows.length) return null;
  return {
    title: `Out today · ${pretty(today)}`,
    body: rows.map((x) => `- ${x.p.name} — ${s.codes[x.e.code] || x.e.code}${x.e.half ? " (half day)" : ""}`).join("\n"),
  };
}

// ---------------------------------------------------------------------------

function validate(cfg, config) {
  const errors = [];
  if (!Array.isArray(cfg.sources) || !cfg.sources.length) errors.push("sources: list at least one venue to read leave messages from");
  for (const v of cfg.sources || []) check.venue(config, v, `sources(${v})`, errors, { readable: true });
  if (cfg.clarifyVenue) check.venue(config, cfg.clarifyVenue, "clarifyVenue", errors, { readable: true });
  if (cfg.digestVenue) check.venue(config, cfg.digestVenue, "digestVenue", errors);
  const s = settings(cfg);
  if (!s.codes[s.defaultCode]) errors.push(`defaultCode "${s.defaultCode}" is not one of the codes`);
  for (const k of Object.keys(cfg.schedule || {})) {
    if (!["ingest", "digest"].includes(k)) errors.push(`schedule.${k}: unknown (ingest, digest)`);
    else check.cron(cfg.schedule[k], `schedule.${k}`, errors);
  }
  if (!config.llm || (config.llm.provider || "none") === "none") errors.push("needs an LLM (llm.provider) to read leave messages; without one, use `teampilot leave set` by hand");
  return errors;
}

function jobs(ctx, cfg, { dry = false } = {}) {
  const s = settings(cfg);
  const out = [];
  if (s.schedule.ingest) out.push({ id: "leave:ingest", cron: s.schedule.ingest, catchUp: true, run: () => ingest(ctx, cfg, { dry }) });
  if (s.schedule.digest && s.digestVenue) out.push({
    id: "leave:digest", cron: s.schedule.digest, catchUp: true,
    expect: { venue: s.digestVenue, title: (d) => `Out today · ${pretty(d)}`, conditional: true },
    run: async () => {
      const c = digestCard(ctx, s);
      if (!c) return { note: "nobody is out today" };
      return ctx.post({ venue: s.digestVenue, title: c.title, body: c.body, job: "leave:digest", key: `leave:digest:${ctx.calendar.today()}`, dry });
    },
  });
  return out;
}

function dateArgs(args, ctx) {
  const from = args._[1] || ctx.calendar.today();
  const to = args._[2] || from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("dates must be YYYY-MM-DD");
  return ctx.calendar.workdaysBetween(from, to);
}

const commands = {
  ingest: {
    usage: "leave ingest [--dry]                       read the sources now (--dry prints, writes nothing)",
    async run(ctx, cfg, args) { console.log((await ingest(ctx, cfg, { dry: !!args.dry })).note); },
  },
  list: {
    usage: "leave list [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
    async run(ctx, cfg, args) {
      const s = settings(cfg);
      const from = args.from || ctx.calendar.today();
      const to = args.to || addDays(from, 13);
      for (const e of ctx.leave.between(from, to)) {
        const p = ctx.directory.get(e.personId);
        console.log(`${e.date}  ${(p ? p.name : e.personId).padEnd(28)} ${(s.codes[e.code] || e.code).padEnd(14)}${e.half ? " half" : ""}${e.provisional ? " (provisional)" : ""}${e.source === "manual" ? " (manual)" : ""}`);
      }
    },
  },
  set: {
    usage: "leave set <person-id> <from> [to] --code AL [--half]   record leave by hand (wins over automation)",
    async run(ctx, cfg, args) {
      const s = settings(cfg);
      const p = ctx.directory.get(args._[0]);
      if (!p) throw new Error(`unknown person "${args._[0]}"`);
      const code = String(args.code || s.defaultCode).toUpperCase();
      if (!s.codes[code]) throw new Error(`unknown code ${code} (${Object.keys(s.codes).join(", ")})`);
      const r = ctx.leave.set(p.id, dateArgs(args, ctx), { code, half: !!args.half, source: "manual" });
      console.log(`${p.name}: recorded ${r.written.join(", ") || "nothing"} as ${s.codes[code]}`);
    },
  },
  clear: {
    usage: "leave clear <person-id> <from> [to]       remove leave (manual entries included)",
    async run(ctx, cfg, args) {
      const p = ctx.directory.get(args._[0]);
      if (!p) throw new Error(`unknown person "${args._[0]}"`);
      console.log(`${p.name}: cleared ${ctx.leave.clear(p.id, dateArgs(args, ctx), { source: "manual" }).join(", ") || "nothing"}`);
    },
  },
  export: {
    usage: "leave export --from YYYY-MM-DD --to YYYY-MM-DD   CSV to stdout",
    async run(ctx, cfg, args) {
      const from = args.from || addDays(ctx.calendar.today(), -30);
      const to = args.to || ctx.calendar.today();
      console.log("date,person_id,name,email,code,half_day,provisional,source");
      for (const e of ctx.leave.between(from, to)) {
        const p = ctx.directory.get(e.personId) || {};
        console.log([e.date, e.personId, `"${p.name || ""}"`, p.email || "", e.code, e.half, e.provisional, e.source].join(","));
      }
    },
  },
};

module.exports = { key: "leave", title: "Leave tracking", validate, jobs, commands, ingest, settings, hasLeaveIntent, _test: { extractionPrompt, digestCard } };
