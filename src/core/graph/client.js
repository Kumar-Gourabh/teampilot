"use strict";

/**
 * Read-only Graph client. TeamPilot never writes to Teams through Graph — posts
 * go through webhooks — so a misbehaving job can't edit or delete anything.
 *
 * - Retries 429/503/504 honouring Retry-After.
 * - Optional fallback identity: when the bot account gets 403/404 on a Teams
 *   read (it isn't a member of that chat), retry once as a second, read-only
 *   identity. Never primary, never for anything but GET.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GraphError extends Error {
  constructor(status, path, message) {
    super(`Graph ${status} ${path}: ${message}`);
    this.status = status;
    this.path = path;
  }
}

function createGraph({ auth, fallbackAuth = null, log }) {
  async function get(pathOrUrl, { retries = 3 } = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    let token = await auth.tokenSilent();
    let usedFallback = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      if ([429, 503, 504].includes(res.status) && attempt < retries) {
        await sleep((Number(res.headers.get("retry-after")) || attempt + 1) * 1000);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      const short = url.replace(GRAPH, "").split("?")[0];
      if ([403, 404].includes(res.status) && fallbackAuth && !usedFallback && /\/(chats|teams)\//.test(short)) {
        try {
          token = await fallbackAuth.tokenSilent();
          usedFallback = true;
          if (log) log.info(`graph: ${short} refused for the bot (${res.status}); retrying as the read-only fallback identity`);
          continue;
        } catch { /* no fallback sign-in — report the original error */ }
      }
      throw new GraphError(res.status, short, body.error ? `${body.error.code}: ${body.error.message}` : res.statusText);
    }
  }

  async function all(path, maxPages = 10) {
    let out = [];
    let next = path;
    for (let page = 0; next && page < maxPages; page++) {
      const j = await get(next);
      out = out.concat(j.value || []);
      next = j["@odata.nextLink"];
    }
    return out;
  }

  return { get, all, GRAPH };
}

module.exports = { createGraph, GraphError, GRAPH };
