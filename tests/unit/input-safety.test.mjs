// 职责：输入安全的单元测试（安全复审低级意见、QA D11）：一句话最多处理 300 字、连续空白合并，超长输入不会拖慢解析；
//       没有标题的条目整理后显示“（无标题）”。
// 依赖：tests/lib/harness.mjs、src/scripts/core/*.js、src/scripts/logic/*.js、src/scripts/data/normalize.js
import assert from "node:assert/strict";
import { loadApp, src, plain, test, done } from "../lib/harness.mjs";

const ctx = loadApp(["core/const.js", "core/date.js", "logic/projects.js", "logic/parse-text.js", "logic/parse-date-zh.js", "logic/parse-date-ko.js",
  "logic/parse-time.js", "logic/parse-marks.js", "logic/parse-quick.js", "data/normalize.js"].map(src));
const parse = s => plain(ctx.App.logic.parseQuick(s, "2026-10-23", ["NEOX"]));

test("超长输入只处理前 300 字", () => {
  const r = parse("明天下午3点 " + "开会".repeat(1000));
  assert.ok(r.title.length <= 300); assert.equal(r.time, "15:00");
});
test("一万个空格加文字：100 毫秒内解析完（防正则回溯）", () => {
  const t0 = Date.now(); parse(" ".repeat(10000) + "明天 交稿" + " ".repeat(10000) + "x"); assert.ok(Date.now() - t0 < 100);
});
test("连续空白合并成一个", () => assert.equal(parse("买   硬盘").title, "买 硬盘"));
test("没有标题的条目整理后显示（无标题）", () => {
  assert.equal(plain(ctx.App.data.normalize.normalizeEvent({ date: "2026-10-23", time: "15:00" }, "e")).title, "（无标题）");
  assert.equal(plain(ctx.App.data.normalize.normalizeTodo({ title: "   " }, "t")).title, "（无标题）");
});

await done("输入安全");
