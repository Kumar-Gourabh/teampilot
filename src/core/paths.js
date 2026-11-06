"use strict";

/**
 * Where TeamPilot keeps things.
 *
 * Code and data live apart so an upgrade never touches a customer's config or
 * history:
 *   <install dir>/                 the code (this repo / the npm package)
 *   $TEAMPILOT_HOME/workspaces/<w>/ one folder per company or project
 *       workspace.yaml   what runs, when, and where it posts
 *       people.yaml      the people directory
 *       holidays.yaml    non-working days
 *       .env             secrets (webhook URLs, API keys) — never committed
 *       secrets/         token caches written by `teampilot login`
 *       state/           runtime state (what was posted, who replied, leave ledger)
 *       logs/
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");

function home() {
  return path.resolve(process.env.TEAMPILOT_HOME || path.join(os.homedir(), ".teampilot"));
}

function workspacesDir() {
  return path.join(home(), "workspaces");
}

function workspaceDir(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(String(name || ""))) {
    throw new Error(`Invalid workspace name "${name}". Use letters, numbers, - and _.`);
  }
  return path.join(workspacesDir(), name);
}

function listWorkspaces() {
  try {
    return fs.readdirSync(workspacesDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(workspacesDir(), d.name, "workspace.yaml")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { ROOT, home, workspacesDir, workspaceDir, listWorkspaces, ensureDir };
