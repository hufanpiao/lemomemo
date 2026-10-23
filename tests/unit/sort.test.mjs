// 职责：logic/sort.js 的单元测试：pickNext 挑“下一件事”、待办排序、日程按时间排序。“今天”固定为 2026-10-23（周五）。
//       logic/items.js、logic/format.js 的测试分别在 items.test.mjs、format.test.mjs。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、logic/items.js、logic/sort.js
import assert from "node:assert/strict";
import { loadApp, src, plain, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("logic/items.js"), src("logic/sort.js")]);
const { pickNext, sortTodos, byTime } = ctx.App.logic.sort;
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
await done("sort 单元测试");
