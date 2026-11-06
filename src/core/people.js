"use strict";

/**
 * The people directory — the single source of truth for who exists, who has
 * left, and how a Teams display name maps back to a person.
 *
 * Design notes:
 *  - Leavers are DEACTIVATED (departedOn = last working day), never deleted, so
 *    history stays and every module filters them the same way. A half-done
 *    offboarding (one bot's list updated, another's not) can't happen when there
 *    is only one list.
 *  - Display names drift ("Doe, Jane", "Jane D", glued given names). Matching is
 *    tolerant but refuses to guess between two candidates.
 *  - Teams user ids are harvested from people's own replies and remembered, so
 *    anyone who has replied once can be @mentioned without an email list.
 */

const fs = require("fs");
const YAML = require("yaml");

const tokens = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/\([^)]*\)/g, " ").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

/** "Doe, Jane" -> "Jane Doe". */
function unflip(name) {
  const m = String(name || "").match(/^\s*([^,]+),\s*([^,]+)\s*$/);
  return m ? `${m[2]} ${m[1]}` : String(name || "");
}

/** Same person if every word of the shorter name appears in the longer one. */
function sameName(a, b) {
  const ta = tokens(unflip(a)), tb = tokens(unflip(b));
  if (!ta.length || !tb.length) return false;
  const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return s.every((w) => l.includes(w));
}

function loadPeopleFile(file) {
  const doc = YAML.parse(fs.readFileSync(file, "utf8")) || {};
  return Array.isArray(doc) ? doc : doc.people || [];
}

function validatePeople(list) {
  const errors = [];
  const ids = new Set();
  list.forEach((p, i) => {
    const where = `people[${i}]`;
    if (!p || typeof p !== "object") return errors.push(`${where}: not an object`);
    if (!p.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(p.id)) errors.push(`${where}: "id" is required (letters, numbers, . _ -)`);
    if (ids.has(p.id)) errors.push(`${where}: duplicate id "${p.id}"`);
    ids.add(p.id);
    if (!p.name) errors.push(`${where} (${p.id}): "name" is required`);
    if (p.email && !/^[^@\s]+@[^@\s]+$/.test(p.email)) errors.push(`${where} (${p.id}): email looks wrong`);
    if (p.departedOn && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.departedOn))) errors.push(`${where} (${p.id}): departedOn must be YYYY-MM-DD`);
  });
  return errors;
}

/**
 * @param {object[]} list    people.yaml entries
 * @param {object}   [store] state store, for harvested Teams ids
 */
function createDirectory(list, store) {
  const people = list.map((p) => ({
    aliases: [],
    teams: [],
    ...p,
    departedOn: p.departedOn ? String(p.departedOn) : null,
    email: p.email ? String(p.email).toLowerCase() : null,
  }));
  const byId = new Map(people.map((p) => [p.id, p]));
  const harvested = () => (store ? store.read("people/teams-ids.json", {}) : {});

  const dir = {
    all: () => people.slice(),
    get: (id) => byId.get(id) || null,
    /** Still with us on `date` (the last working day still counts). */
    isActive: (p, date) => !p.departedOn || date <= p.departedOn,
    active: (date) => people.filter((p) => dir.isActive(p, date)),
    inTeam: (team, date) => people.filter((p) => (p.teams || []).includes(team) && (!date || dir.isActive(p, date))),
    resolveIds(ids, date) {
      const out = [];
      for (const id of ids || []) {
        const p = byId.get(id);
        if (!p) throw new Error(`Unknown person id "${id}" (not in people.yaml)`);
        if (!date || dir.isActive(p, date)) out.push(p);
      }
      return out;
    },

    /**
     * Find the person behind a Teams sender. Tries the stable things first
     * (Teams user id, email), then names. Returns null rather than guess.
     */
    match({ aadId, email, name } = {}, pool = people) {
      if (aadId) {
        const ids = harvested();
        const hit = pool.find((p) => p.aadId === aadId || ids[p.id] === aadId);
        if (hit) return hit;
      }
      if (email) {
        const e = String(email).toLowerCase();
        const hit = pool.find((p) => p.email === e);
        if (hit) return hit;
      }
      if (!name) return null;
      const exact = pool.filter((p) => [p.name, ...(p.aliases || [])].some((n) => tokens(unflip(n)).join(" ") === tokens(unflip(name)).join(" ")));
      if (exact.length === 1) return exact[0];
      const loose = pool.filter((p) => [p.name, ...(p.aliases || [])].some((n) => sameName(n, name)));
      return loose.length === 1 ? loose[0] : null;
    },

    /** Remember Teams ids seen on people's own messages. */
    harvest(pairs) {
      if (!store || !pairs || !pairs.length) return;
      store.update("people/teams-ids.json", {}, (ids) => {
        for (const { personId, aadId } of pairs) if (personId && aadId) ids[personId] = aadId;
        return ids;
      });
    },

    /** What an Adaptive Card mention entity needs: a Teams id, else an email. */
    mentionId(p) {
      return p.aadId || harvested()[p.id] || p.email || null;
    },
  };
  return dir;
}

module.exports = { createDirectory, loadPeopleFile, validatePeople, sameName, tokens, unflip };
