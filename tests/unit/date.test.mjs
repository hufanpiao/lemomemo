// 职责：core/date.js 与 core/clock.js 的单元测试：日期加减（跨月、跨年、闰年）、相差天数、本周一、时间互转、
//       毫秒换日期，以及时钟的 tick / wake / 跨天事件（用假的 env 驱动）。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、core/clock.js
import assert from "node:assert/strict";
import { loadApp, src, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("core/clock.js")]);
const D = ctx.App.core.date;

test("pad / ymd / parse 互逆", () => {
  assert.equal(D.pad(5), "05");
  assert.equal(D.ymd(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(D.ymd(D.parse("2026-10-23")), "2026-10-23");
});
test("addDays 跨月、跨年、闰年", () => {
  assert.equal(D.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(D.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(D.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(D.addDays("2026-03-01", -1), "2026-02-28");
});
test("dayDiff", () => {
  assert.equal(D.dayDiff("2026-10-25", "2026-10-23"), 2);
  assert.equal(D.dayDiff("2026-10-21", "2026-10-23"), -2);
  assert.equal(D.dayDiff("2027-01-01", "2026-12-31"), 1);
});
test("mondayOf：周日算上一周", () => {
  assert.equal(D.mondayOf("2026-10-23"), "2026-10-19");   // 周五
  assert.equal(D.mondayOf("2026-10-25"), "2026-10-19");   // 周日
  assert.equal(D.mondayOf("2026-10-19"), "2026-10-19");   // 周一
});
test("hm2m / m2hm / md", () => {
  assert.equal(D.hm2m("14:30"), 870);
  assert.equal(D.m2hm(870), "14:30");
  assert.equal(D.m2hm(24 * 60 + 30), "00:30");
  assert.equal(D.md("2026-01-05"), "1月5日");
});
test("todayOf / minOfDay / hourOf 按本地时间", () => {
  const ms = new Date(2026, 9, 23, 18, 5).getTime();
  assert.equal(D.todayOf(ms), "2026-10-23");
  assert.equal(D.minOfDay(ms), 18 * 60 + 5);
  assert.equal(D.hourOf(ms), 18);
});

function fakeEnv(ms) {
  const env = { t: ms, tick: null, wake: null };
  env.now = () => env.t;
  env.every = (_, fn) => { env.tick = fn; };
  env.onVisible = fn => { env.wake = fn; };
  return env;
}
test("时钟：每次 tick 发 tick，跨过零点先发 daychange", () => {
  const env = fakeEnv(new Date(2026, 9, 23, 23, 59).getTime());
  const clock = ctx.App.core.clock.create(env), got = [];
  clock.on("tick", () => got.push("tick"));
  clock.on("daychange", e => got.push("day:" + e.prev + ">" + e.day));
  clock.start();
  env.tick();
  env.t += 2 * 60000; env.tick();
  assert.deepEqual(got, ["tick", "day:2026-10-23>2026-10-24", "tick"]);
  assert.equal(clock.today(), "2026-10-24");
  assert.equal(clock.nowMin(), 1);
});
test("时钟：切回前台发 wake，日期变了也发 daychange", () => {
  const env = fakeEnv(new Date(2026, 9, 23, 22, 0).getTime());
  const clock = ctx.App.core.clock.create(env), got = [];
  clock.on("wake", () => got.push("wake"));
  clock.on("daychange", () => got.push("day"));
  clock.start();
  env.wake();
  env.t += 10 * 3600e3; env.wake();
  assert.deepEqual(got, ["wake", "day", "wake"]);
});

await done("date / clock 单元测试");
