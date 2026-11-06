"use strict";

const fs = require("fs");
const path = require("path");

function createLogger({ dir, timezone, quiet = false }) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  function write(level, msg) {
    const stamp = new Date().toLocaleString("sv-SE", { timeZone: timezone, hour12: false });
    const line = `[${stamp}] ${level.padEnd(5)} ${msg}`;
    if (!quiet || level !== "INFO") (level === "ERROR" ? console.error : console.log)(line);
    if (dir) {
      try {
        fs.appendFileSync(path.join(dir, `teampilot-${stamp.slice(0, 7)}.log`), line + "\n");
      } catch { /* log dir not writable — console still has it */ }
    }
  }
  return {
    info: (m) => write("INFO", m),
    warn: (m) => write("WARN", m),
    error: (m) => write("ERROR", m),
  };
}

module.exports = { createLogger };
