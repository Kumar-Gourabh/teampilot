"use strict";

const { createContext } = require("./core/context");
const { createScheduler } = require("./core/scheduler");
const configLib = require("./core/config");

const MODULES = {
  standup: require("./modules/standup"),
  timesheet: require("./modules/timesheet"),
  leave: require("./modules/leave"),
  weeklyReport: require("./modules/weekly-report"),
  supervisor: require("./modules/supervisor"),
};

/** Module key as written on the command line ("weekly-report") → config key. */
function moduleByCli(name) {
  const key = Object.keys(MODULES).find((k) => k.toLowerCase() === String(name).replace(/-/g, "").toLowerCase());
  return key ? { key, mod: MODULES[key] } : null;
}

function enabledModules(config) {
  return Object.keys(MODULES).filter((k) => config.modules[k] && config.modules[k].enabled !== false);
}

function createRuntime(name, { dry = false, quiet = false } = {}) {
  const ctx = createContext(name, { quiet });
  const errors = configLib.validate(ctx.config, MODULES);
  const scheduler = createScheduler(ctx);
  const jobs = [];
  const enabled = enabledModules(ctx.config);
  if (!errors.length) {
    for (const k of enabled.filter((x) => !MODULES[x].needsAllJobs)) jobs.push(...MODULES[k].jobs(ctx, ctx.config.modules[k], { dry }));
    for (const k of enabled.filter((x) => MODULES[x].needsAllJobs)) {
      jobs.push(...MODULES[k].jobs(ctx, ctx.config.modules[k], { dry, allJobs: jobs.slice(), scheduler }));
    }
    for (const j of jobs) scheduler.add(j);
  }
  return { ctx, scheduler, jobs, errors, enabled, MODULES };
}

module.exports = { createRuntime, MODULES, moduleByCli, enabledModules };
