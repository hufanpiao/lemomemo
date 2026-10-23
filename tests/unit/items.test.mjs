// 职责：logic/items.js 的单元测试：日程时长（缺省、字符串、非法值）、起止分钟（含跨夜）、待办是否“某天完成”、
//       是否“没赶上”、是否已软删除。全部是纯函数，“今天”由参数传入，固定为 2026-10-23。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、logic/items.js
import assert from "node:assert/strict";
import { loadApp, src, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("logic/items.js")]);
const I = ctx.App.logic.items;
const T = "2026-10-23";
const ms = (d, h, mi = 0) => new Date(2026, 9, d, h, mi).getTime();

test("durationOf：数字、字符串数字照用；缺省、0、非法值按 60 分钟", () => {
  assert.equal(I.durationOf({ durationMin: 90 }), 90);
  assert.equal(I.durationOf({ durationMin: "45" }), 45);
  for (const v of [undefined, null, 0, "", "abc", NaN]) assert.equal(I.durationOf({ durationMin: v }), 60, String(v));
});
test("startMin / endMin：按 HH:MM 换算，结束时间可以跨过 24 点", () => {
  assert.equal(I.startMin({ time: "00:00" }), 0);
  assert.equal(I.startMin({ time: "14:30" }), 870);
  assert.equal(I.endMin({ time: "14:30", durationMin: 90 }), 960);
  assert.equal(I.endMin({ time: "23:30" }), 24 * 60 + 30);
});
test("isDoneOn：已完成且完成时间落在那一天才算", () => {
  assert.equal(I.isDoneOn({ done: true, doneAt: ms(23, 0, 1) }, T), true);
  assert.equal(I.isDoneOn({ done: true, doneAt: ms(23, 23, 59) }, T), true);
  assert.equal(I.isDoneOn({ done: true, doneAt: ms(22, 23, 59) }, T), false);   // 昨天完成
  assert.equal(I.isDoneOn({ done: true, doneAt: 0 }, T), false);               // 没有完成时间
  assert.equal(I.isDoneOn({ done: false, doneAt: ms(23, 9) }, T), false);       // 已取消完成
  assert.equal(typeof I.isDoneOn({ done: true }, T), "boolean");
});
test("isLate：没完成、有截止日、截止日早于今天", () => {
  assert.equal(I.isLate({ done: false, due: "2026-10-22" }, T), true);
  assert.equal(I.isLate({ done: false, due: "2025-12-31" }, T), true);
  assert.equal(I.isLate({ done: false, due: T }, T), false);          // 今天截止不算晚
  assert.equal(I.isLate({ done: false, due: "2026-10-24" }, T), false);
  assert.equal(I.isLate({ done: false, due: "" }, T), false);         // 没截止日
  assert.equal(I.isLate({ done: true, due: "2026-10-01" }, T), false); // 已完成
  assert.equal(typeof I.isLate({ done: false }, T), "boolean");
});
test("isLive：deletedAt 为空才算在用", () => {
  for (const v of [undefined, null, 0]) assert.equal(I.isLive({ deletedAt: v }), true, String(v));
  assert.equal(I.isLive({ deletedAt: ms(20, 8) }), false);
});

await done("items 单元测试");
