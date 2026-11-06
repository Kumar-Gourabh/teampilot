"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cron = require("../src/core/cron");
const { createCalendar } = require("../src/core/clock");
const { createDirectory, sameName } = require("../src/core/people");
const { createStore } = require("../src/core/state");
const { createLedger } = require("../src/core/leave-ledger");
const { decorate } = require("../src/core/chat/mentions");
const guards = require("../src/core/llm/guards");
const { stripHtml, normalise } = require("../src/core/graph/read");
const { hasLeaveIntent } = require("../src/modules/leave");
const env = require("../src/core/env");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tp-test-"));

test("cron: slots on a day, day-of-week and steps", () => {
  assert.deepStrictEqual(cron.slotsOn("30 17 * * 1-5", "2026-11-04"), [17 * 60 + 30]);
  assert.deepStrictEqual(cron.slotsOn("30 17 * * 1-5", "2026-11-07"), []); // Saturday
  assert.strictEqual(cron.slotsOn("*/15 10-11 * * 4", "2026-11-05").length, 8);
  assert.ok(cron.validate("0 25 * * *"));
  assert.strictEqual(cron.validate("0 9 * * 1-5"), null);
});

test("calendar: holidays, periods, workdays", () => {
  const cal = createCalendar({ timezone: "UTC", holidays: [{ date: "2026-11-06", name: "Founders Day" }] });
  assert.strictEqual(cal.isWorkday("2026-11-06"), false);
  assert.strictEqual(cal.isWorkday("2026-11-07"), false);
  assert.deepStrictEqual(cal.periodContaining("2026-11-04", "friday"), { start: "2026-10-31", end: "2026-11-06" });
  assert.strictEqual(cal.previousWorkday("2026-11-09"), "2026-11-05");
});

test("people: tolerant matching that refuses to guess", () => {
  const dir = createDirectory([
    { id: "a", name: "Alex Morgan", aliases: ["Morgan, Alex"] },
    { id: "b", name: "Alex Chen" },
    { id: "c", name: "Priya Raman", departedOn: "2026-10-31" },
  ]);
  assert.strictEqual(dir.match({ name: "Morgan, Alex" }).id, "a");
  assert.strictEqual(dir.match({ name: "alex morgan" }).id, "a");
  assert.strictEqual(dir.match({ name: "Alex" }), null); // two Alexes
  assert.strictEqual(dir.isActive(dir.get("c"), "2026-10-31"), true); // last day still counts
  assert.strictEqual(dir.isActive(dir.get("c"), "2026-11-01"), false);
  assert.ok(sameName("Raman, Priya", "Priya Raman"));
});

test("mentions: never tag leavers, people on leave, never-tag, or twice", () => {
  const store = createStore(tmp());
  const people = [
    { id: "a", name: "Alex Morgan", email: "a@x.com" },
    { id: "b", name: "Priya Raman", email: "p@x.com" },
    { id: "c", name: "Sam Okafor", email: "s@x.com", departedOn: "2026-10-01" },
    { id: "d", name: "Jordan Lee", email: "j@x.com", neverTag: true },
  ];
  const dir = createDirectory(people, store);
  const leave = createLedger(store);
  leave.set("b", ["2026-11-04"], { code: "AL" });
  const body = "**Alex Morgan** did X\n**Priya Raman** did Y\n**Sam Okafor** did Z\n**Jordan Lee** did W\n**Alex** again";
  const r = decorate(body, { people: dir.all(), cc: [dir.get("a"), dir.get("d")], date: "2026-11-04", directory: dir, leave });
  assert.deepStrictEqual(r.tagged, ["a"]);
  assert.strictEqual(r.entities.length, 1);
  assert.match(r.body, /<at>Alex Morgan<\/at> did X/);
  assert.match(r.body, /\*\*Priya Raman\*\*/);
  const reasons = Object.fromEntries(r.untagged.map((u) => [u.personId, u.reason]));
  assert.strictEqual(reasons.b, "on leave today");
  assert.strictEqual(reasons.c, "has left");
  assert.strictEqual(reasons.d, "marked never-tag");
  assert.doesNotMatch(r.body, /cc:/); // Alex already tagged, Jordan never-tag
});

test("leave ledger: automation never overwrites a manual correction", () => {
  const leave = createLedger(createStore(tmp()));
  leave.set("a", ["2026-11-04"], { code: "SL", source: "manual" });
  const r = leave.set("a", ["2026-11-04", "2026-11-05"], { code: "AL", source: "auto" });
  assert.deepStrictEqual(r.written, ["2026-11-05"]);
  assert.strictEqual(leave.get("a", "2026-11-04").code, "SL");
  assert.deepStrictEqual(leave.clear("a", ["2026-11-04"]), []);
  leave.set("a", ["2026-11-06"], { code: "AL", half: true });
  assert.strictEqual(leave.isOff("a", "2026-11-06"), false); // half day still works
});

test("guards: preamble, invented people, links", () => {
  assert.strictEqual(guards.stripPreamble("Here is the summary:\n\n**Alex** — done\n\nLet me know if you need more."), "**Alex** — done");
  const { text, dropped } = guards.keepOnlyPeople("**Alex Morgan**\n✅ Done: X\n\n**Ghost Person** — nothing logged", ["Alex Morgan"]);
  assert.deepStrictEqual(dropped, ["Ghost Person"]);
  assert.doesNotMatch(text, /Ghost/);
  assert.deepStrictEqual(guards.lostLinks("see https://x.io/a and https://x.io/b", "see https://x.io/a"), ["https://x.io/b"]);
  assert.deepStrictEqual(guards.parseJsonLoose('Sure!\n```json\n[{"m":"m1"}]\n```'), [{ m: "m1" }]);
});

test("leave intent gate", () => {
  assert.ok(hasLeaveIntent("I'm on leave tomorrow"));
  assert.ok(hasLeaveIntent("feeling unwell, taking the day"));
  assert.ok(hasLeaveIntent("I will not be able to join today, urgent work at home"));
  assert.ok(!hasLeaveIntent("I can't join the standup, clashing call"));
  assert.ok(!hasLeaveIntent("@Alex Morgan please review"));
});

test("graph read: quotes dropped, card text read", () => {
  assert.strictEqual(stripHtml("<blockquote>their words</blockquote><p>my update</p>"), "my update");
  const m = normalise({
    id: "1", createdDateTime: "2026-11-04T10:00:00Z", from: { application: { displayName: "Workflows" } },
    body: { contentType: "html", content: "<attachment></attachment>" },
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: JSON.stringify({ body: [{ type: "TextBlock", text: "Platform standup · Wed 4 Nov" }, { type: "TextBlock", text: "hello" }] }) }],
  });
  assert.strictEqual(m.from.isBot, true);
  assert.strictEqual(m.title, "Platform standup · Wed 4 Nov");
});

test("env: parses quotes and comments, ignores junk", () => {
  assert.deepStrictEqual(env.parse('A=1\n# c\nB="x y"\nexport C=z # note\nbad line'), { A: "1", B: "x y", C: "z" });
});
