"use strict";

/**
 * Builds everything a module needs for one workspace. Modules never reach for
 * globals or process.env — they get `ctx`, which is what makes one install able
 * to serve many companies or projects side by side.
 */

const fs = require("fs");
const path = require("path");
const configLib = require("./config");
const { createStore } = require("./state");
const { createLogger } = require("./log");
const { createCalendar } = require("./clock");
const { createDirectory, loadPeopleFile } = require("./people");
const { createLedger } = require("./leave-ledger");
const { createAuth } = require("./graph/auth");
const { createGraph } = require("./graph/client");
const { createReader } = require("./graph/read");
const { createDelivery } = require("./chat/deliver");
const { createLlm } = require("./llm");

function loadHolidays(file) {
  const doc = configLib.readYaml(file, false);
  if (!doc) return [];
  const list = Array.isArray(doc) ? doc : doc.holidays || [];
  return list.map((h) => ({ date: String(h.date), name: h.name || "Holiday", note: h.note || null }));
}

function createContext(name, { quiet = false } = {}) {
  const config = configLib.load(name);
  const secret = (key) => (key ? config.secrets[key] || process.env[key] || "" : "");
  const store = createStore(path.join(config.dir, "state"));
  const log = createLogger({ dir: path.join(config.dir, "logs"), timezone: config.workspace.timezone, quiet });
  const holidays = loadHolidays(config.workspace.holidaysFile);
  const calendar = createCalendar({ timezone: config.workspace.timezone, workdays: config.workspace.workdays, holidays });
  const people = fs.existsSync(config.workspace.peopleFile) ? loadPeopleFile(config.workspace.peopleFile) : [];
  const directory = createDirectory(people, store);
  const leave = createLedger(store);

  const g = config.identity.graph;
  const auth = createAuth({ cachePath: g.cachePath, clientId: g.clientId, tenant: g.tenant, account: g.account, label: "bot" });
  const fallbackAuth = g.fallback
    ? createAuth({ cachePath: g.fallback.cachePath, clientId: g.clientId, tenant: g.tenant, account: g.fallback.account, label: "fallback" })
    : null;
  const graph = createGraph({ auth, fallbackAuth, log });
  const reader = createReader({ graph, timezone: config.workspace.timezone });
  const delivery = createDelivery({ config, secret, store, directory, leave, calendar, log });
  const llm = createLlm(config.llm, secret, log);

  return {
    name, config, secret, store, log, calendar, holidays, directory, leave,
    auth, fallbackAuth, graph, reader, delivery, llm,
    venue: (n) => delivery.venue(n),
    post: (msg) => delivery.post(msg),
  };
}

module.exports = { createContext, loadHolidays };
