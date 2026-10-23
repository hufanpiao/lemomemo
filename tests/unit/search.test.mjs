// 职责：logic/search.js 的单元测试：标题、备注、原话都能搜；不分大小写；韩文；包括已完成和过去的日程；
//       结果顺序（待办在前、未完成在前，日程新的在前）；数量上限；高亮切分不丢字、不拼 HTML。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、logic/items.js、logic/sort.js、logic/search.js
import assert from "node:assert/strict";
import { loadApp, src, plain, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("logic/items.js"), src("logic/sort.js"), src("logic/search.js")]);
const { search, segments } = ctx.App.logic.search;
const EV = [
  { id: "e1", title: "NEOX 对片", date: "2026-10-20", time: "10:00", note: "", rawText: "" },
  { id: "e2", title: "踩点", date: "2026-10-25", time: "", note: "分镜确认", rawText: "" },
  { id: "e3", title: "내일 미팅", date: "2026-10-24", time: "15:00", note: "", rawText: "" },
];
const TD = [
  { id: "t1", title: "交 neox 竖版", done: true, doneAt: 5, note: "", rawText: "" },
  { id: "t2", title: "画分镜", done: false, note: "", rawText: "" },
  { id: "t3", title: "回邮件", done: false, note: "", rawText: "和金经理谈合同" },
];
const ids = r => plain(r).map(x => x.item.id);

test("标题、备注、原话都能搜到", () => {
  assert.deepEqual(ids(search(EV, TD, "分镜")), ["t2", "e2"]);
  assert.deepEqual(ids(search(EV, TD, "金经理")), ["t3"]);
});
test("不分大小写；包括已完成的待办和过去的日程", () => assert.deepEqual(ids(search(EV, TD, "Neox")), ["t1", "e1"]));
test("韩文按原样匹配", () => assert.deepEqual(ids(search(EV, TD, "미팅")), ["e3"]));
test("空关键词或只有空格返回空；没结果返回空", () => {
  assert.equal(search(EV, TD, "").length, 0);
  assert.equal(search(EV, TD, "   ").length, 0);
  assert.equal(search(EV, TD, "不存在的词").length, 0);
});
test("顺序：待办在前（未完成在前），日程按日期新的在前；max 限制条数", () => {
  const all = [...TD, { id: "t4", title: "neox 新版", done: false }];
  const ev = [...EV, { id: "e4", title: "NEOX 复盘", date: "2026-10-28", time: "" }];
  assert.deepEqual(ids(search(ev, all, "neox")), ["t4", "t1", "e4", "e1"]);
  assert.equal(search(ev, all, "neox", 2).length, 2);
});
test("搜索不改动传入的数组", () => {
  const td = TD.slice();
  search(EV, td, "分镜");
  assert.deepEqual(td.map(x => x.id), ["t1", "t2", "t3"]);
});
test("segments：切出命中的部分，拼回去等于原文", () => {
  const s = plain(segments("NEOX 和 neox", "neox"));
  assert.deepEqual(s, [{ text: "NEOX", hit: true }, { text: " 和 ", hit: false }, { text: "neox", hit: true }]);
  assert.equal(s.map(x => x.text).join(""), "NEOX 和 neox");
  assert.deepEqual(plain(segments("abc", "")), [{ text: "abc", hit: false }]);
  assert.deepEqual(plain(segments(null, "a")), [{ text: "", hit: false }]);
  assert.deepEqual(plain(segments("<img src=x>", "img")).map(x => x.text), ["<", "img", " src=x>"]);
});

await done("search 单元测试");
