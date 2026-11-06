"use strict";

/**
 * Adaptive Card building for Teams. A blank line in the body starts a new
 * TextBlock — Teams collapses blank lines inside one block, so people's sections
 * would otherwise run together.
 */

function adaptiveCard({ title, body, signoff, entities = [] }) {
  const blocks = [];
  if (title) blocks.push({ type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true });
  const parts = String(body || "").split(/\n[ \t]*\n+/).map((b) => b.replace(/\s+$/, "")).filter((b) => b.trim());
  for (const p of parts) blocks.push({ type: "TextBlock", text: p, wrap: true, spacing: "Medium" });
  if (signoff) blocks.push({ type: "TextBlock", text: `_${signoff}_`, isSubtle: true, wrap: true, spacing: "Medium" });
  const content = { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: blocks };
  if (entities.length) content.msteams = { entities, width: "Full" };
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content }] };
}

/** Slack incoming webhook payload (posting only; Slack mentions use <@id>). */
function slackPayload({ title, body, signoff }) {
  const md = (s) => String(s || "").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/<at>(.+?)<\/at>/g, "*$1*");
  const text = [title ? `*${md(title)}*` : "", md(body), signoff ? `_${signoff}_` : ""].filter(Boolean).join("\n\n");
  return { text };
}

/** Plain-text rendering for dry runs and the console venue. */
function plain({ title, body, signoff }) {
  return [title ? `== ${title} ==` : "", String(body || ""), signoff ? `— ${signoff}` : ""].filter(Boolean).join("\n\n");
}

module.exports = { adaptiveCard, slackPayload, plain };
