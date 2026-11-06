"use strict";

/**
 * Just enough cron to answer "when does this fire today?" — the scheduler needs
 * it for boot catch-up and dead-slot warnings, the supervisor for "was this post
 * due yet?". Standard 5 fields: minute hour day-of-month month day-of-week.
 */

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(spec, [lo, hi]) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const [base, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let a = lo, b = hi;
    if (base !== "*") {
      const [x, y] = base.split("-").map(Number);
      if (!Number.isInteger(x)) throw new Error(`bad cron field "${spec}"`);
      a = x;
      b = y === undefined ? (stepRaw ? hi : x) : y;
    }
    if (!Number.isInteger(step) || step < 1 || a < lo || b > hi || a > b) throw new Error(`bad cron field "${spec}"`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

function parse(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron "${expr}" must have 5 fields (min hour dom month dow)`);
  const [min, hour, dom, mon, dow] = f.map((s, i) => field(s, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  return { min, hour, dom, mon, dow, domAny: f[2] === "*", dowAny: f[4] === "*" };
}

function dayMatches(c, iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (!c.mon.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk; // standard cron: either restricted field may match
}

/** Minutes-after-midnight at which `expr` fires on `iso` (sorted, maybe empty). */
function slotsOn(expr, iso) {
  const c = typeof expr === "string" ? parse(expr) : expr;
  if (!dayMatches(c, iso)) return [];
  const out = [];
  for (const h of [...c.hour].sort((a, b) => a - b)) for (const m of [...c.min].sort((a, b) => a - b)) out.push(h * 60 + m);
  return out;
}

function validate(expr) {
  try { parse(expr); return null; } catch (e) { return e.message; }
}

module.exports = { parse, slotsOn, validate };
