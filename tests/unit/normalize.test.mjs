// 职责：data/normalize.js 的单元测试：类型转换、日期和时间补零、长度限制、deletedAt、未知字段保留、
//       id 一律以文档 id 为准（数据里的 id 不能覆盖）、各种坏数据都不抛错。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、data/normalize.js
import assert from "node:assert/strict";
import { loadApp, src, plain, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("data/normalize.js")]);
const N = ctx.App.data.normalize, C = ctx.App.core.C;

test("日期补零；认不出的置空", () => {
  assert.equal(N.date("2026-1-5"), "2026-01-05");
  assert.equal(N.date("2026/10/23"), "2026-10-23");
  assert.equal(N.date(" 2026-10-23 "), "2026-10-23");
  for (const bad of ["2026-13-01", "10月23日", "", null, undefined, 20261023, {}]) assert.equal(N.date(bad), "");
});
test("时间补零（含中文冒号）；认不出的置空", () => {
  assert.equal(N.time("9:5"), "09:05");
  assert.equal(N.time("14：30"), "14:30");
  for (const bad of ["25:00", "9点", "", null, 930]) assert.equal(N.time(bad), "");
});
test("日程：类型转换、默认时长、长度限制、未知字段保留", () => {
  const e = plain(N.normalizeEvent({ title: 123, date: "2026-10-3", time: "8:00", durationMin: "90", project: "x".repeat(99),
    note: null, source: "chat", remindMin: 15, createdAt: "5" }, "e1"));
  assert.equal(e.title, "123"); assert.equal(e.date, "2026-10-03"); assert.equal(e.time, "08:00");
  assert.equal(e.durationMin, 90); assert.equal(e.project.length, C.PROJECT_MAX); assert.equal(e.note, "");
  assert.equal(e.remindMin, 15); assert.equal(e.createdAt, 5); assert.equal(e.deletedAt, null); assert.equal(e.id, "e1");
  assert.equal(plain(N.normalizeEvent({ durationMin: -5 }, "x")).durationMin, 60);
  assert.equal(plain(N.normalizeEvent({ title: "长".repeat(500) }, "x")).title.length, C.TITLE_MAX);
});
test("待办：done / important 只认真正的 true，字符串 \"false\" 不算完成", () => {
  const t = plain(N.normalizeTodo({ title: "a", done: "false", important: "true", due: "2026-10-30", doneAt: "x" }, "t1"));
  assert.equal(t.done, false); assert.equal(t.important, true); assert.equal(t.due, "2026-10-30"); assert.equal(t.doneAt, 0);
  assert.equal(plain(N.normalizeTodo({ done: true }, "t")).done, true);
  assert.equal("note" in plain(N.normalizeTodo({}, "t")), false);
});
test("deletedAt：正数保留，0 / 空 / 乱写都算没删除", () => {
  assert.equal(plain(N.normalizeTodo({ deletedAt: 1700000000000 }, "t")).deletedAt, 1700000000000);
  for (const v of [0, null, "", "abc", undefined]) assert.equal(plain(N.normalizeTodo({ deletedAt: v }, "t")).deletedAt, null);
});
test("id 一律以文档 id 为准，数据里的 id 字段不能覆盖", () => {
  assert.equal(plain(N.normalizeItem("todos", Object.assign({}, { id: "evil", title: "x" }, { id: "doc-1" }))).id, "doc-1");
  assert.equal(plain(N.normalizeEvent({ id: "evil" }, "doc-2")).id, "doc-2");
});
test("缺字段、空对象、null 都不抛错", () => {
  for (const raw of [null, undefined, {}, { title: null, date: 1, time: true }]) {
    N.normalizeEvent(raw, "x"); N.normalizeTodo(raw, "y");
  }
});

await done("normalize 单元测试");
