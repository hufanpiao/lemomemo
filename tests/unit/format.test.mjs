// 职责：logic/format.js 的单元测试：relDay 相对日期（今天 / 明天 / 后天 / 昨天 / 其他日期，跨月跨年）、
//       dueText 截止文案（晚了 / 今天 / 明天 / 7 天内 / 更远）、startsText 倒计时文案。“今天”由参数传入。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、logic/format.js
import assert from "node:assert/strict";
import { loadApp, src, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("logic/format.js")]);
const F = ctx.App.logic.format;
const T = "2026-10-23";   // 周五

test("relDay：今天、明天、后天、昨天带星期", () => {
  assert.equal(F.relDay(T, T), "今天 周五");
  assert.equal(F.relDay("2026-10-24", T), "明天 周六");
  assert.equal(F.relDay("2026-10-25", T), "后天 周日");
  assert.equal(F.relDay("2026-10-22", T), "昨天 周四");
});
test("relDay：其他日期显示几月几日，跨月跨年也对", () => {
  assert.equal(F.relDay("2026-10-21", T), "10月21日 周三");   // 前天不说“前天”
  assert.equal(F.relDay("2026-10-26", T), "10月26日 周一");
  assert.equal(F.relDay("2026-11-01", "2026-10-31"), "明天 周日");
  assert.equal(F.relDay("2027-01-01", "2026-12-31"), "明天 周五");
  assert.equal(F.relDay("2027-01-05", T), "1月5日 周二");
});
test("relDay：“今天”由参数决定，同一天换个基准结果不同", () => {
  assert.equal(F.relDay("2026-10-24", "2026-10-24"), "今天 周六");
  assert.equal(F.relDay("2026-10-24", "2026-10-25"), "昨天 周六");
});
test("dueText：过期、今天、明天", () => {
  assert.equal(F.dueText("2026-10-22", T), "晚了 1 天");
  assert.equal(F.dueText("2026-09-23", T), "晚了 30 天");
  assert.equal(F.dueText(T, T), "今天截止");
  assert.equal(F.dueText("2026-10-24", T), "明天截止");
});
test("dueText：2–7 天显示还剩几天，8 天起显示日期", () => {
  assert.equal(F.dueText("2026-10-25", T), "还剩 2 天");
  assert.equal(F.dueText("2026-10-30", T), "还剩 7 天");
  assert.equal(F.dueText("2026-10-31", T), "10月31日 截止");
  assert.equal(F.dueText("2027-02-01", T), "2月1日 截止");
});
test("startsText：分钟、整点小时、小时加分钟、已开始", () => {
  assert.equal(F.startsText(1, 0), "1 分钟后开始");
  assert.equal(F.startsText(59, 0), "59 分钟后开始");
  assert.equal(F.startsText(60, 0), "1 小时 后开始");          // v2 原样：整点时中间多一个空格
  assert.equal(F.startsText(125, 0), "2 小时 5 分钟后开始");
  assert.equal(F.startsText(0, 10 * 60), "进行中，10:00 结束");  // 正好开始算进行中
  assert.equal(F.startsText(-30, 19 * 60 + 30), "进行中，19:30 结束");
  assert.equal(F.startsText(-30, 24 * 60 + 15), "进行中，00:15 结束");   // 跨夜结束
});

await done("format 单元测试");
