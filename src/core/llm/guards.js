"use strict";

/**
 * Code-level guards for LLM output. Prompts ask nicely; these enforce. Each one
 * exists because a model did the thing the prompt told it not to.
 */

const { sameName } = require("../people");

/** Drop "Here is the card:"-style lead-ins, sign-offs and stray fences/rules. */
function stripPreamble(text) {
  let lines = String(text || "").split("\n").filter((l) => !/^\s*(-{3,}|\*{3,}|_{3,}|`{3,}\w*)\s*$/.test(l));
  const lead = /^(sure|okay|ok|certainly|here(?:'s| is| are)?|below is|this is|i'?ll|i have|i've)\b/i;
  while (lines.length && (!lines[0].trim() || lead.test(lines[0].trim()) || /:\s*$/.test(lines[0].trim()) && !/\*\*/.test(lines[0]))) lines.shift();
  const tail = /^(let me know|hope this|feel free|i hope|if you('d)? (like|want|need))/i;
  while (lines.length && (!lines[lines.length - 1].trim() || tail.test(lines[lines.length - 1].trim()))) lines.pop();
  return lines.join("\n").trim();
}

/** The person a line is "about": its leading **Name**, if any. */
function leadName(line) {
  const m = String(line).trim().replace(/^[-*•]\s+/, "").match(/^\*\*([^*]+)\*\*/);
  return m ? m[1].trim().replace(/[\s,:—–-]+$/, "") : null;
}

/**
 * Keep a person-led line only if that person is in `allowed`. Stops invented
 * roster lines ("**Sam** — nothing logged" for someone who isn't on the team) and
 * claims about people who sent no update.
 */
function keepOnlyPeople(text, allowedNames) {
  const dropped = [];
  // A dropped person's detail lines go with them (up to the next blank line or the
  // next person) — otherwise they'd read as the previous person's work.
  let skipping = false;
  const kept = String(text || "").split("\n").filter((line) => {
    const who = leadName(line);
    if (who) {
      skipping = !allowedNames.some((n) => sameName(n, who));
      if (skipping) dropped.push(who);
      return !skipping;
    }
    if (!line.trim()) skipping = false;
    return !skipping;
  });
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), dropped };
}

/** Remove whole paragraphs that address a person who must not be asked (on leave). */
function dropParagraphsAbout(text, names) {
  if (!names.length) return { text, dropped: [] };
  const dropped = [];
  const paras = String(text || "").split(/\n[ \t]*\n/).filter((p) => {
    const who = leadName(p);
    if (who && names.some((n) => sameName(n, who))) { dropped.push(who); return false; }
    return true;
  });
  return { text: paras.join("\n\n"), dropped };
}

/** Parse JSON out of a model reply that may wrap it in prose or fences. */
function parseJsonLoose(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = Math.min(...["[", "{"].map((c) => s.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) throw new Error("no JSON in model reply");
  const open = s[start], close = open === "[" ? "]" : "}";
  const end = s.lastIndexOf(close);
  return JSON.parse(s.slice(start, end + 1));
}

/** Links in the source must survive into the output; returns the ones that didn't. */
function lostLinks(source, output) {
  const urls = String(source || "").match(/https?:\/\/[^\s)>\]]+/g) || [];
  return [...new Set(urls)].filter((u) => !String(output || "").includes(u));
}

module.exports = { stripPreamble, leadName, keepOnlyPeople, dropParagraphsAbout, parseJsonLoose, lostLinks };
