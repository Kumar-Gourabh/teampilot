"use strict";

/**
 * Load and validate a workspace. Validation is strict and specific — a typo in a
 * venue name or a cron field is reported by `teampilot doctor` before it can
 * silently skip a post on a working day.
 */

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const paths = require("./paths");
const env = require("./env");
const cron = require("./cron");
const { KINDS } = require("./chat/deliver");

function readYaml(file, required = true) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Missing ${file}`);
    return null;
  }
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (e) {
    throw new Error(`${path.basename(file)} is not valid YAML: ${e.message}`);
  }
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

function load(name) {
  const dir = paths.workspaceDir(name);
  const raw = readYaml(path.join(dir, "workspace.yaml"));
  const secrets = env.load(path.join(dir, ".env"));
  const ws = raw.workspace || {};
  const graph = (raw.identity && raw.identity.graph) || {};
  const resolveIn = (p, fallback) => path.resolve(dir, p || fallback);

  const config = {
    name,
    dir,
    workspace: {
      name: ws.name || name,
      timezone: ws.timezone || "UTC",
      workdays: ws.workdays || ["monday", "tuesday", "wednesday", "thursday", "friday"],
      signoff: ws.signoff === undefined ? "TeamPilot" : ws.signoff,
      uptime: ws.uptime || null,
      catchUpMinutes: ws.catchUpMinutes === undefined ? 180 : Number(ws.catchUpMinutes),
      holidaysFile: resolveIn(ws.holidaysFile, "holidays.yaml"),
      peopleFile: resolveIn(ws.peopleFile, "people.yaml"),
    },
    identity: {
      graph: {
        enabled: graph.enabled !== false,
        clientId: graph.clientId || null,
        tenant: graph.tenant || "common",
        account: graph.account || null,
        cachePath: resolveIn(graph.cachePath, "secrets/graph-cache.json"),
        fallback: graph.fallback ? {
          account: graph.fallback.account || null,
          cachePath: resolveIn(graph.fallback.cachePath, "secrets/graph-cache-fallback.json"),
        } : null,
      },
    },
    llm: raw.llm || { provider: "none" },
    venues: {},
    modules: raw.modules || {},
    secrets,
  };
  for (const [vn, v] of Object.entries(raw.venues || {})) config.venues[vn] = { kind: "teams-workflow", ...v };
  return config;
}

/** Returns a list of human-readable problems; empty means valid. */
function validate(config, modules) {
  const errors = [];
  const w = config.workspace;
  if (!validTimezone(w.timezone)) errors.push(`workspace.timezone "${w.timezone}" is not a valid IANA timezone (e.g. Europe/London, America/New_York, Asia/Singapore)`);
  for (const d of w.workdays) {
    if (!["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].includes(String(d).toLowerCase())) errors.push(`workspace.workdays: unknown day "${d}"`);
  }
  if (w.uptime && (!/^\d{2}:\d{2}$/.test(w.uptime.from || "") || !/^\d{2}:\d{2}$/.test(w.uptime.to || ""))) errors.push("workspace.uptime needs from/to as HH:MM");

  for (const [name, v] of Object.entries(config.venues)) {
    if (!KINDS.includes(v.kind)) errors.push(`venues.${name}.kind "${v.kind}" must be one of ${KINDS.join(", ")}`);
    if (v.kind !== "console" && !v.webhook) errors.push(`venues.${name}: "webhook" (the name of a secret in .env) is required`);
    if (v.webhook && !/^[A-Z_][A-Z0-9_]*$/.test(v.webhook)) errors.push(`venues.${name}.webhook should be the NAME of a .env secret (e.g. WEBHOOK_STANDUP), not the URL itself`);
    if (v.chatId && (v.teamId || v.channelId)) errors.push(`venues.${name}: give either chatId or teamId+channelId, not both`);
    if (!!v.teamId !== !!v.channelId) errors.push(`venues.${name}: teamId and channelId go together`);
  }

  const llm = config.llm || {};
  if (!["anthropic", "openai-compatible", "none"].includes(llm.provider || "none")) errors.push(`llm.provider "${llm.provider}" must be anthropic, openai-compatible or none`);
  if (llm.provider === "openai-compatible" && (!llm.baseUrl || !llm.model)) errors.push("llm: openai-compatible needs baseUrl and model");

  for (const [key, mod] of Object.entries(modules)) {
    const cfg = config.modules[key];
    if (!cfg || cfg.enabled === false) continue;
    for (const e of mod.validate(cfg, config)) errors.push(`modules.${key}: ${e}`);
  }
  return errors;
}

/** Shared helpers modules use in their validate(). */
const check = {
  venue(config, name, where, errors, { readable = false } = {}) {
    if (!name) return errors.push(`${where}: a venue is required`);
    const v = config.venues[name];
    if (!v) return errors.push(`${where}: venue "${name}" is not defined under venues:`);
    if (readable && !v.chatId && !v.teamId) errors.push(`${where}: venue "${name}" must be readable (give it chatId or teamId+channelId) because replies are read from it`);
  },
  cron(expr, where, errors) {
    for (const e of [].concat(expr || [])) {
      const err = cron.validate(e);
      if (err) errors.push(`${where}: ${err}`);
    }
  },
};

module.exports = { load, validate, check, readYaml };
