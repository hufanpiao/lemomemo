// 职责：core/date.js 与 core/clock.js 的单元测试：日期加减（跨月、跨年、闰年）、相差天数、本周一、时间互转、
//       毫秒换日期，以及时钟的整分钟对齐、tick / wake / 跨天事件（用假的 env 驱动）。
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

// 假 env：after() 只记下最近一次安排；fire() 把时间拨到那一刻并执行
function fakeEnv(ms) {
  const env = { t: ms, pending: null, wake: null, cancelled: 0 };
  env.now = () => env.t;
  env.after = (delay, fn) => { env.pending = { at: env.t + delay, fn }; return env.pending; };
  env.cancel = h => { if (env.pending === h) { env.pending = null; env.cancelled++; } };
  env.onVisible = fn => { env.wake = fn; };
  env.fire = () => { const p = env.pending; env.pending = null; env.t = p.at; p.fn(); };
  return env;
}
const local = (h, mi, s = 0, msec = 0, d = 23) => new Date(2026, 9, d, h, mi, s, msec).getTime();

test("时钟对齐：tick 安排在下一个整分钟后 1 秒内", () => {
  for (const start of [local(9, 30, 0, 0), local(9, 30, 17, 450), local(9, 30, 59, 999)]) {
    const env = fakeEnv(start), clock = ctx.App.core.clock.create(env);
    clock.start();
    const at = env.pending.at, boundary = local(9, 31);
    assert.ok(at >= boundary && at < boundary + 1000, "从 " + new Date(start).toISOString() + " 起，安排在 " + (at - boundary) + " ms");
  }
});
test("时钟对齐：连续 tick 不累积偏差（每次都落在整分钟后 1 秒内），即使某次晚触发", () => {
  const env = fakeEnv(local(10, 0, 42, 300)), clock = ctx.App.core.clock.create(env);
  let ticks = 0;
  clock.on("tick", () => ticks++);
  clock.start();
  for (let k = 0; k < 5; k++) {
    if (k === 2) env.pending.at += 700;   // 模拟浏览器晚了 0.7 秒才执行
    env.fire();
    const off = env.t % 60000;
    assert.ok(off < 1000, "第 " + (k + 1) + " 次 tick 在整分钟后 " + off + " ms");
  }
  assert.equal(ticks, 5);
  assert.ok(env.pending.at % 60000 < 1000, "第 3 次晚了之后，下一次重新对齐");
});
test("时钟：跨过零点先发 daychange 再发 tick", () => {
  const env = fakeEnv(local(23, 59, 30)), clock = ctx.App.core.clock.create(env), got = [];
  clock.on("tick", () => got.push("tick"));
  clock.on("daychange", e => got.push("day:" + e.prev + ">" + e.day));
  clock.start();
  env.fire();
  assert.deepEqual(got, ["day:2026-10-23>2026-10-24", "tick"]);
  assert.equal(clock.today(), "2026-10-24");
  assert.equal(clock.nowMin(), 0);
});
test("时钟：切回前台发 wake，日期变了也发 daychange，并重新对齐", () => {
  const env = fakeEnv(local(22, 0, 10)), clock = ctx.App.core.clock.create(env), got = [];
  clock.on("wake", () => got.push("wake"));
  clock.on("daychange", () => got.push("day"));
  clock.start();
  env.wake();
  env.t += 10 * 3600e3 + 12345; env.wake();
  assert.deepEqual(got, ["wake", "day", "wake"]);
  assert.ok(env.cancelled >= 2, "旧的安排被取消");
  assert.ok(env.pending.at % 60000 < 1000 && env.pending.at > env.t);
});

await done("date / clock 单元测试");
