"use strict";

/**
 * Microsoft Graph sign-in (delegated, device code).
 *
 * Two doors, kept apart on purpose so a scheduled job can never hang on a login
 * prompt:
 *   login()        interactive, run once by a person: `teampilot login <ws>`
 *   tokenSilent()  refresh-token only; throws if nobody has signed in
 *
 * Design notes:
 *  - A cache can hold several accounts. Pin the bot identity with `account`, and
 *    otherwise try each one, so one revoked grant can't blind every job.
 *  - "AADSTS50173"/"invalid_grant" means the grant was revoked (usually a password
 *    reset) — the fix is a fresh login, and the error says so.
 */

const fs = require("fs");
const path = require("path");

// Microsoft's own public client (the Graph CLI app): works in most tenants with no
// app registration. A product deployment should register its own app and set
// identity.graph.clientId — see docs/SETUP-MICROSOFT-365.md.
const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

const READ_SCOPES = [
  "User.Read",
  "User.ReadBasic.All",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
  "Chat.Read",
];

class GraphAuthError extends Error {}

function createAuth({ cachePath, clientId, tenant, account, label = "bot" }) {
  let pca = null;
  const plugin = {
    beforeCacheAccess: async (ctx) => {
      try { ctx.tokenCache.deserialize(fs.readFileSync(cachePath, "utf8")); } catch { /* first run */ }
    },
    afterCacheAccess: async (ctx) => {
      if (!ctx.cacheHasChanged) return;
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, ctx.tokenCache.serialize(), { mode: 0o600 });
    },
  };
  function app() {
    if (pca) return pca;
    const { PublicClientApplication } = require("@azure/msal-node");
    pca = new PublicClientApplication({
      auth: { clientId: clientId || DEFAULT_CLIENT_ID, authority: `https://login.microsoftonline.com/${tenant || "common"}` },
      cache: { cachePlugin: plugin },
    });
    return pca;
  }

  async function accounts() {
    const all = await app().getTokenCache().getAllAccounts();
    const want = String(account || "").toLowerCase();
    if (!want) return all;
    const hit = all.filter((a) => String(a.username || "").toLowerCase() === want);
    return hit.length ? hit : all;
  }

  return {
    label,
    cachePath,
    async login(onMessage = (m) => console.log(m)) {
      const r = await app().acquireTokenByDeviceCode({ scopes: READ_SCOPES, deviceCodeCallback: (i) => onMessage(i.message) });
      if (!r || !r.accessToken) throw new GraphAuthError("Sign-in returned no token.");
      return { username: r.account && r.account.username };
    },
    async tokenSilent() {
      const list = await accounts();
      if (!list.length) throw new GraphAuthError(`Not signed in (${label}). Run: teampilot login <workspace>${label === "fallback" ? " --fallback" : ""}`);
      let last = null;
      for (const acct of list) {
        try {
          const r = await app().acquireTokenSilent({ account: acct, scopes: READ_SCOPES });
          if (r && r.accessToken) return r.accessToken;
        } catch (e) { last = e; }
      }
      const revoked = last && /AADSTS50173|AADSTS700082|invalid_grant/i.test(last.message || "");
      throw new GraphAuthError(revoked
        ? `The ${label} sign-in was revoked (password or session reset). Sign in again: teampilot login <workspace>`
        : `Silent token refresh failed for ${list.map((a) => a.username).join(", ")}: ${last ? last.message : "unknown"}`);
    },
    async whoAmI() {
      const list = await accounts();
      return list.map((a) => a.username);
    },
  };
}

module.exports = { createAuth, GraphAuthError, READ_SCOPES, DEFAULT_CLIENT_ID };
