"use strict";

/**
 * Read a venue (a Teams channel or a chat) into plain, normalised messages.
 *
 * Design notes:
 *  - Bot cards posted through a webhook carry their text in the Adaptive Card
 *    attachment, not in body.content — both are read.
 *  - Quoted replies (<blockquote>) are dropped so one person's words are never
 *    attributed to the person who quoted them.
 *  - Replies under OLDER roots matter (people answer yesterday's thread); a range
 *    read walks roots back `replyLookbackDays` and reads their replies too.
 */

const clock = require("../clock");

function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/gi, "'").replace(/&quot;|&ldquo;|&rdquo;/gi, '"');
}

function stripHtml(html) {
  if (!html) return "";
  return decodeEntities(String(html)
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " ")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\r/g, "")
    .split("\n").map((s) => s.trim()).filter(Boolean).join("\n").trim();
}

function cardTexts(attachments) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "TextBlock" && node.text) out.push(String(node.text));
    for (const k of ["body", "items", "columns", "facts"]) if (node[k]) walk(node[k]);
  };
  for (const a of attachments || []) {
    if (!a || !a.content) continue;
    try { walk(typeof a.content === "string" ? JSON.parse(a.content) : a.content); } catch { /* not a card */ }
  }
  return out;
}

function normalise(m, parentId = null) {
  const user = m.from && m.from.user;
  const blocks = cardTexts(m.attachments);
  const bodyText = m.body && m.body.contentType === "html" ? stripHtml(m.body.content) : String((m.body && m.body.content) || "").trim();
  const cardText = blocks.join("\n\n");
  return {
    id: m.id,
    parentId: parentId || m.replyToId || null,
    at: m.createdDateTime,
    modifiedAt: m.lastModifiedDateTime || m.createdDateTime,
    deleted: !!m.deletedDateTime,
    from: user ? { aadId: user.id, name: user.displayName, isBot: false } : { aadId: null, name: (m.from && m.from.application && m.from.application.displayName) || "bot", isBot: true },
    text: [bodyText, cardText].filter(Boolean).join("\n\n").replace(/<\/?at[^>]*>/g, ""),
    title: blocks[0] || m.subject || "",
    isCard: blocks.length > 0,
    hasImage: /<img\b/i.test((m.body && m.body.content) || "") || (m.attachments || []).some((a) => /image/i.test(a.contentType || "")),
    reactions: (m.reactions || []).map((r) => ({ type: r.reactionType, aadId: r.user && r.user.user && r.user.user.id })),
    mentions: (m.mentions || []).map((x) => ({ aadId: x.mentioned && x.mentioned.user && x.mentioned.user.id, name: (x.mentioned && x.mentioned.user && x.mentioned.user.displayName) || x.mentionText })),
  };
}

function createReader({ graph, timezone }) {
  const localDate = (iso) => clock.parts(new Date(iso), timezone).date;

  /** Roots in a channel created in [from, to], newest-first paging that stops early. */
  async function channelRoots(teamId, channelId, from, to) {
    let url = `/teams/${teamId}/channels/${channelId}/messages?$top=50`;
    const out = [];
    for (let page = 0; url && page < 20; page++) {
      const j = await graph.get(url);
      const batch = j.value || [];
      for (const m of batch) {
        const d = localDate(m.createdDateTime);
        if (d >= from && d <= to) out.push(m);
      }
      const oldest = batch[batch.length - 1];
      if (!oldest || localDate(oldest.createdDateTime) < from) break;
      url = j["@odata.nextLink"];
    }
    return out;
  }

  async function chatMessages(chatId, from, to) {
    let url = `/chats/${chatId}/messages?$top=50`;
    const out = [];
    for (let page = 0; url && page < 20; page++) {
      const j = await graph.get(url);
      const batch = j.value || [];
      for (const m of batch) {
        const d = localDate(m.createdDateTime);
        if (d >= from && d <= to) out.push(m);
      }
      const oldest = batch[batch.length - 1];
      if (!oldest || localDate(oldest.createdDateTime) < from) break;
      url = j["@odata.nextLink"];
    }
    return out;
  }

  /**
   * Every message in a venue whose own date is in [from, to]. For channels, roots
   * up to `replyLookbackDays` before `from` are scanned for late replies.
   */
  async function read(venue, { from, to = from, replyLookbackDays = 0, withReplies = true } = {}) {
    if (venue.chatId) {
      return (await chatMessages(venue.chatId, from, to)).filter((m) => m.messageType === "message" || !m.messageType).map((m) => normalise(m));
    }
    if (!venue.teamId || !venue.channelId) throw new Error(`venue "${venue.name}" has no teamId/channelId or chatId to read from`);
    const rootFrom = clock.addDays(from, -replyLookbackDays);
    const roots = await channelRoots(venue.teamId, venue.channelId, rootFrom, to);
    const out = [];
    for (const r of roots) {
      if (localDate(r.createdDateTime) >= from) out.push(normalise(r));
      if (!withReplies) continue;
      const replies = await graph.all(`/teams/${venue.teamId}/channels/${venue.channelId}/messages/${r.id}/replies?$top=50`, 5);
      for (const rep of replies) {
        const d = localDate(rep.createdDateTime);
        if (d >= from && d <= to) out.push(normalise(rep, r.id));
      }
    }
    return out.filter((m) => !m.deleted).sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Replies to one known root (channel) — chats have no threads, so all later messages. */
  async function thread(venue, rootId) {
    if (venue.chatId) throw new Error("chats have no reply threads; use read()");
    const replies = await graph.all(`/teams/${venue.teamId}/channels/${venue.channelId}/messages/${rootId}/replies?$top=50`, 5);
    return replies.map((r) => normalise(r, rootId)).filter((m) => !m.deleted).sort((a, b) => a.at.localeCompare(b.at));
  }

  async function message(venue, id) {
    const m = venue.chatId
      ? await graph.get(`/chats/${venue.chatId}/messages/${id}`)
      : await graph.get(`/teams/${venue.teamId}/channels/${venue.channelId}/messages/${id}`);
    return normalise(m);
  }

  async function discover() {
    const teams = await graph.all("/me/joinedTeams");
    const out = { teams: [], chats: [] };
    for (const t of teams) {
      const channels = await graph.all(`/teams/${t.id}/channels`).catch(() => []);
      out.teams.push({ name: t.displayName, teamId: t.id, channels: channels.map((c) => ({ name: c.displayName, channelId: c.id })) });
    }
    const chats = await graph.all("/me/chats?$top=50", 4).catch(() => []);
    out.chats = chats.map((c) => ({ chatId: c.id, topic: c.topic || "(no topic)", type: c.chatType }));
    return out;
  }

  return { read, thread, message, discover, localDate };
}

module.exports = { createReader, stripHtml, cardTexts, normalise };
