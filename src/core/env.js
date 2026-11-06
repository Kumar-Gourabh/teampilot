"use strict";

/**
 * Minimal .env reader. Secrets are kept in a per-workspace map rather than
 * pushed into process.env, so two workspaces can never read each other's keys.
 */

const fs = require("fs");

function parse(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

function load(file) {
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

module.exports = { parse, load };
