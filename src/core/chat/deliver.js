"use strict";

/**
 * Posting. Every card goes through here, which gives every module the same
 * guarantees:
 *  - Idempotent: a post with a `key` already sent today is skipped, so a restart,
 *    a boot catch-up or a retry can never double-post.
 *  - Dry runs print exactly what would post and touch nothing.
 *  - Every real post is written to the posts ledger (title, body before
 *    decoration, who was tagged and who was deliberately not) — the supervisor
 *    audits from it.
 *  - A webhook answering 202 only means "accepted". The supervisor checks that
 *    the card actually appeared in the venue.
 */

const cards = require("./cards");
const mentions = require("./mentions");

const KINDS = ["teams-workflow", "teams-connector", "slack", "console"];

function createDelivery({ config, secret, store, directory, leave, calendar, log }) {
  const signoff = config.workspace.signoff;

  function venue(name) {
    const v = config.venues[name];
    if (!v) throw new Error(`Unknown venue "${name}" (define it under venues: in workspace.yaml)`);
    return { name, ...v };
  }

  const ledgerFile = (date) => `posts/${date}.jsonl`;
  const postsOn = (date) => store.readLines(ledgerFile(date));

  /**
   * @param {object} msg  { venue, title, body, job, key?, mention?: {people, cc}, meta?, dry? }
   * @returns {Promise<{posted:boolean, skipped?:string, record?:object}>}
   */
  async function post(msg) {
    const date = calendar.today();
    const v = venue(msg.venue);
    if (msg.key && !msg.dry && postsOn(date).some((p) => p.key === msg.key && p.venue === v.name)) {
      log.info(`skip ${msg.key}: already posted to ${v.name} today`);
      return { posted: false, skipped: "already posted today" };
    }

    let body = String(msg.body || "").trim();
    let entities = [];
    let tagged = [];
    let untagged = [];
    if (v.kind === "teams-workflow" && msg.mention) {
      const d = mentions.decorate(body, { ...msg.mention, date, directory, leave });
      ({ entities, tagged, untagged } = d);
      body = d.body;
    } else if (msg.mention && msg.mention.cc && msg.mention.cc.length) {
      body = `${body}\n\ncc: ${msg.mention.cc.map((p) => `**${p.name}**`).join(" · ")}`;
    }

    const record = {
      at: new Date().toISOString(), date, job: msg.job, key: msg.key || null, venue: v.name, title: msg.title || "",
      body: String(msg.body || "").trim(), tagged, untagged, meta: msg.meta || {},
    };

    if (msg.dry || v.kind === "console") {
      const lines = [`\n----- ${msg.dry ? "DRY RUN" : "console"} → ${v.name} (${msg.job}) -----`, cards.plain({ title: msg.title, body, signoff })];
      if (tagged.length) lines.push(`[would tag: ${tagged.map((id) => (directory.get(id) || {}).name || id).join(", ")}]`);
      if (untagged.length) lines.push(`[not tagged: ${untagged.map((u) => `${u.name} (${u.reason})`).join(", ")}]`);
      console.log(lines.join("\n") + "\n");
      if (!msg.dry) store.append(ledgerFile(date), record);
      return { posted: !msg.dry, record };
    }

    const url = secret(v.webhook);
    if (!url) throw new Error(`venue "${v.name}": secret ${v.webhook} is not set in the workspace .env`);
    const payload = v.kind === "slack" ? cards.slackPayload({ title: msg.title, body, signoff }) : cards.adaptiveCard({ title: msg.title, body, signoff, entities });
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`webhook for ${v.name} answered ${res.status}: ${text.slice(0, 300)}`);
    }
    store.append(ledgerFile(date), record);
    log.info(`posted ${msg.job} → ${v.name}${tagged.length ? ` (tagged ${tagged.length})` : ""}`);
    return { posted: true, record };
  }

  return { post, venue, postsOn, KINDS };
}

module.exports = { createDelivery, KINDS };
