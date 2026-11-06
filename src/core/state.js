"use strict";

/**
 * JSON state store. Every write is atomic (temp file + rename) so a crash or a
 * host shutdown mid-write never leaves half a file behind.
 */

const fs = require("fs");
const path = require("path");

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const full = (rel) => {
    const p = path.resolve(dir, rel);
    if (!p.startsWith(path.resolve(dir))) throw new Error(`state path escapes the store: ${rel}`);
    return p;
  };

  function read(rel, fallback) {
    try {
      return JSON.parse(fs.readFileSync(full(rel), "utf8"));
    } catch {
      return typeof fallback === "function" ? fallback() : fallback;
    }
  }

  function write(rel, value) {
    const p = full(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(tmp, p);
    return value;
  }

  function update(rel, fallback, fn) {
    const cur = read(rel, fallback);
    const next = fn(cur);
    return write(rel, next === undefined ? cur : next);
  }

  function append(rel, record) {
    const p = full(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(record) + "\n");
  }

  function readLines(rel) {
    try {
      return fs.readFileSync(full(rel), "utf8").split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  return { dir, read, write, update, append, readLines, path: full };
}

module.exports = { createStore };
