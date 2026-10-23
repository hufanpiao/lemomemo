// 职责：logic/sort.js、logic/items.js、logic/format.js 的单元测试：pickNext 挑“下一件事”、待办排序、
//       “今天完成”和“没赶上”的判断、相对日期与倒计时文案。“今天”固定为 2026-10-23（周五）。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、logic/items.js、logic/sort.js、logic/format.js
import assert from "node:assert/strict";
import { loadApp, src, plain, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("logic/items.js"), src("logic/sort.js"), src("logic/format.js")]);
const { pickNext, sortTodos, byTime } = ctx.App.logic.sort;
const I = ctx.App.logic.items, F = ctx.App.logic.format;
const T = "2026-10-23";
const at = (h, m = 0) => h * 60 + m;
const ids = list => plain(list).map(x => x.id);

const EV = [
  { id: "a", date: T, time: "09:00", durationMin: 60 },
  { id: "b", date: T, time: "14:00" },                       // 没写时长按 60
  { id: "c", date: T, time: "" },                            // 全天，不参与
  { id: "d", date: "2026-10-24", time: "08:00" },            // 明天，不参与
];
const TD = [
  { id: "t1", done: false, due: "2026-10-30", createdAt: 1 },
  { id: "t2", done: false, due: "2026-10-25", important: true, createdAt: 2 },
  { id: "t3", done: true, due: "2026-10-20", important: true, createdAt: 3 },
];

test("pickNext：取今天还没结束的第一个定时日程", () => {
  const n = pickNext(EV, TD, T, at(9, 30));
  assert.equal(n.kind, "event"); assert.equal(n.item.id, "a"); assert.equal(n.start, at(9)); assert.equal(n.end, at(10));
});
test("pickNext：前一个结束了就取下一个（没写时长按 60 分钟）", () => {
  const n = pickNext(EV, TD, T, at(10));
  assert.equal(n.item.id, "b"); assert.equal(n.end, at(15));
});
test("pickNext：今天日程都结束后取最该做的待办（重要优先，再按截止日）", () => {
  const n = pickNext(EV, TD, T, at(15));
  assert.equal(n.kind, "todo"); assert.equal(n.item.id, "t2");
});
test("pickNext：什么都没有返回 null", () => assert.equal(pickNext([], [{ id: "x", done: true }], T, 0), null));
test("sortTodos：未完成在前；重要在前；截止早的在前；没截止日的最后；同截止按创建先后", () => {
  const list = [
    { id: "no-due", done: false, createdAt: 1 },
    { id: "late-due", done: false, due: "2026-11-01", createdAt: 2 },
    { id: "early-due", done: false, due: "2026-10-24", createdAt: 3 },
    { id: "same-due-later", done: false, due: "2026-10-24", createdAt: 4 },
    { id: "imp", done: false, important: true, createdAt: 5 },
    { id: "done-old", done: true, doneAt: 100 },
    { id: "done-new", done: true, doneAt: 200 },
  ];
  assert.deepEqual(ids(sortTodos(list)), ["imp", "early-due", "same-due-later", "late-due", "no-due", "done-new", "done-old"]);
});
test("byTime：按日期再按时间，全天排在当天最前", () => {
  const list = [{ id: 1, date: T, time: "10:00" }, { id: 2, date: T, time: "" }, { id: 3, date: "2026-10-22", time: "23:00" }];
  assert.deepEqual(plain(list.sort(byTime)).map(x => x.id), [3, 2, 1]);
});
test("items：durationOf / endMin / isDoneOn / isLate / isLive", () => {
  assert.equal(I.durationOf({ durationMin: "90" }), 90);
  assert.equal(I.durationOf({}), 60);
  assert.equal(I.endMin({ time: "23:30", durationMin: 60 }), 24 * 60 + 30);
  const doneAt = new Date(2026, 9, 23, 8).getTime();
  assert.equal(I.isDoneOn({ done: true, doneAt }, T), true);
  assert.equal(I.isDoneOn({ done: true, doneAt }, "2026-10-24"), false);
  assert.equal(I.isDoneOn({ done: false, doneAt }, T), false);
  assert.equal(I.isLate({ done: false, due: "2026-10-22" }, T), true);
  assert.equal(I.isLate({ done: false, due: T }, T), false);
  assert.equal(I.isLate({ done: true, due: "2026-10-22" }, T), false);
  assert.equal(I.isLive({ deletedAt: null }), true);
  assert.equal(I.isLive({ deletedAt: 123 }), false);
});
test("format：relDay / dueText / startsText", () => {
  assert.equal(F.relDay(T, T), "今天 周五");
  assert.equal(F.relDay("2026-10-24", T), "明天 周六");
  assert.equal(F.relDay("2026-10-22", T), "昨天 周四");
  assert.equal(F.relDay("2026-10-30", T), "10月30日 周五");
  assert.equal(F.dueText("2026-10-21", T), "晚了 2 天");
  assert.equal(F.dueText(T, T), "今天截止");
  assert.equal(F.dueText("2026-10-28", T), "还剩 5 天");
  assert.equal(F.dueText("2026-11-30", T), "11月30日 截止");
  assert.equal(F.startsText(80, 0), "1 小时 20 分钟后开始");
  assert.equal(F.startsText(60, 0), "1 小时 后开始");      // v2 原样：整点时中间多一个空格
  assert.equal(F.startsText(5, 0), "5 分钟后开始");
  assert.equal(F.startsText(-3, at(19, 30)), "进行中，19:30 结束");
});

await done("sort / items / format 单元测试");
