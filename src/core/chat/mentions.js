"use strict";

/**
 * Turn bolded names in a card into real Teams @mentions — safely.
 *
 * Convention: a card names a person as **Full Name** (or a unique first name).
 * Only those become <at> tags; everything else is left alone.
 *
 * Guards, each one preventing a mistake people notice immediately:
 *  - never tag someone who has left (departedOn before today)
 *  - never tag someone on leave today
 *  - never tag anyone marked neverTag in people.yaml
 *  - never tag the same person twice in one card
 *  - an ambiguous first name (two "Alex"es) is never tagged on its own
 *  - an unresolvable name stays bold — no broken <at> text ever reaches Teams
 * Every name that was NOT tagged is reported back with the reason, so the
 * supervisor can audit it.
 */

const { tokens } = require("../people");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {string} body
 * @param {object} o
 * @param {object[]} o.people     who may be tagged (already the right pool for this card)
 * @param {object[]} [o.cc]       people to tag on a trailing "cc:" line
 * @param {string}   o.date       today, for departure/leave guards
 * @param {object}   o.directory  people directory (mentionId, isActive)
 * @param {object}   [o.leave]    leave ledger
 */
function decorate(body, { people, cc = [], date, directory, leave }) {
  const text = String(body || "");
  const entities = [];
  const tagged = [];
  const untagged = [];

  const blocked = (p) => {
    if (!directory.isActive(p, date)) return "has left";
    if (p.neverTag) return "marked never-tag";
    if (leave && leave.isOff(p.id, date)) return "on leave today";
    if (!directory.mentionId(p)) return "no Teams id or email yet";
    return null;
  };

  const firstCount = {};
  for (const p of people) {
    const f = tokens(p.name)[0];
    if (f) firstCount[f] = (firstCount[f] || 0) + 1;
  }

  let out = text;
  for (const p of people) {
    const aliases = [p.name, ...(p.aliases || [])];
    const first = String(p.name).split(/\s+/)[0];
    if (firstCount[first.toLowerCase()] === 1) aliases.push(first);
    const uniq = [...new Set(aliases.filter(Boolean))].sort((a, b) => b.length - a.length);
    const re = new RegExp(`\\*\\*\\s*(${uniq.map(esc).join("|")})\\s*\\*\\*`, "gi");
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const reason = blocked(p);
    if (reason) {
      untagged.push({ personId: p.id, name: p.name, reason });
      continue;
    }
    out = out.replace(re, () => `<at>${p.name}</at>`);
    entities.push({ type: "mention", text: `<at>${p.name}</at>`, mentioned: { id: directory.mentionId(p), name: p.name } });
    tagged.push(p.id);
  }

  const ccNames = [];
  for (const p of cc) {
    if (tagged.includes(p.id)) continue;
    const reason = blocked(p);
    if (reason) {
      untagged.push({ personId: p.id, name: p.name, reason, cc: true });
      continue;
    }
    ccNames.push(`<at>${p.name}</at>`);
    entities.push({ type: "mention", text: `<at>${p.name}</at>`, mentioned: { id: directory.mentionId(p), name: p.name } });
    tagged.push(p.id);
  }
  if (ccNames.length) out = `${out.replace(/\s+$/, "")}\n\ncc: ${ccNames.join(" · ")}`;

  return { body: out, entities, tagged, untagged };
}

module.exports = { decorate };
