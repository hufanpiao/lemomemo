// 职责：data/archive.js 的单元测试（接 mock-db）：最近删除列表的内容和顺序；导出备份包含 events、todos、logs 全部数据
//       和已删除条目（带 deletedAt，需求澄清 #19），logs 读不到时仍能导出；运行记录只取最近 N 天、只留时间/动作/集合/编号。
// 依赖：tests/lib/harness.mjs、src/scripts 的 core、logic、platform/index.js、data 各文件、tests/mock/mock-db.js
import assert from "node:assert/strict";
import { loadApp, src, plain, sleep, fakeClock, test, done } from "../lib/harness.mjs";

const FILES = [
  src("core/const.js"), src("core/date.js"), src("logic/items.js"), src("logic/projects.js"), src("logic/remind.js"), src("platform/index.js"),
  src("data/bus.js"), src("data/store.js"), src("data/normalize.js"), src("data/fields.js"), src("data/state.js"), src("data/log.js"),
  src("data/write.js"), src("data/subscribe.js"), src("data/archive.js"), "tests/mock/mock-db.js",
];
const DAY = 86400000;
const NOW = new Date(2026, 9, 23, 12).getTime();
async function setup(seed){
  const ctx = loadApp(FILES), App = ctx.App;
  const clock = fakeClock(ctx, 2026, 10, 23, 12, 0);
  App.data.write.init(clock);
  App.data.log.init({ clock, device: "d-test", src: "page" });
  const db = App.platform.storage["mock-db"]({ seed, delay: 0 });
  App.data.store.use(db);
  await App.data.subscribe.start(); await sleep(5);
  return { App, db, clock };
}
const SEED = () => ({
  events: { e1: { title: "对片", date: "2026-10-23", time: "10:00" }, e2: { title: "旧会", date: "2026-10-01", time: "", deletedAt: NOW - 3 * DAY, x: 1 } },
  todos: { t1: { title: "交片", done: false }, t2: { title: "删掉的", done: false, deletedAt: NOW - DAY, rawText: "原话" } },
  logs: {
    "2026-10-23_d-a": { day: "2026-10-23", device: "d-a", entries: [{ t: NOW - 1000, kind: "op", act: "create", coll: "todos", id: "t1", src: "page" }] },
    "2026-10-18_d-b": { day: "2026-10-18", device: "d-b", entries: [{ t: NOW - 5 * DAY, kind: "run", act: "timeout", code: "timeout", src: "page" }] },
    "2026-10-10_d-a": { day: "2026-10-10", device: "d-a", entries: [{ t: NOW - 13 * DAY, kind: "op", act: "delete", coll: "events", id: "e9" }] },
  },
});

test("trash：只列已删除的日程和待办，按删除时间新到旧", async () => {
  const { App } = await setup(SEED());
  const r = plain(App.data.archive.trash());
  assert.deepEqual(r.map(x => [x.coll, x.kind, x.item.id]), [["todos", "todo", "t2"], ["events", "event", "e2"]]);
});
test("trash：软删除后立刻出现，恢复后消失", async () => {
  const { App } = await setup(SEED());
  await App.data.write.softDelete("todos", App.data.state.todos.find(x => x.id === "t1"));
  assert.equal(App.data.archive.trash()[0].item.id, "t1");
  await App.data.write.restore("todos", App.data.state.todos.find(x => x.id === "t1"));
  assert.ok(!App.data.archive.trash().some(x => x.item.id === "t1"));
});
test("backup：events、todos、logs 全部导出，已删除条目带 deletedAt，原始字段原样保留", async () => {
  const { App } = await setup(SEED());
  const b = plain(await App.data.archive.backup(NOW));
  assert.equal(b.app, "planner"); assert.equal(b.exportedAt, NOW);
  assert.deepEqual(b.counts, { events: 2, todos: 2, logs: 3 });
  const e2 = b.events.find(x => x.id === "e2");
  assert.equal(e2.deletedAt, NOW - 3 * DAY); assert.equal(e2.x, 1);
  assert.equal(b.todos.find(x => x.id === "t2").rawText, "原话");
});
test("backup：logs 读不到时仍导出日程和待办，并记 logsError", async () => {
  const { App, db } = await setup(SEED());
  const list = db.list;
  db.list = c => c === "logs" ? Promise.reject(App.platform.storeError("network")) : list(c);
  const b = plain(await App.data.archive.backup(NOW));
  assert.deepEqual(b.logs, []); assert.equal(b.logsError, "network"); assert.equal(b.counts.events, 2);
});
test("recentLogs：只取最近 7 天，新到旧，只留时间、动作、集合、编号", async () => {
  const { App } = await setup(SEED());
  const r = plain(await App.data.archive.recentLogs("2026-10-23", 7));
  assert.ok(r.length >= 2, "只读到 " + r.length + " 条");
  assert.ok(r.every(x => Object.keys(x).sort().join() === "act,coll,id,kind,t"));
  assert.ok(!r.some(x => x.id === "e9"), "13 天前的不该出现");
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].t >= r[i].t);
  assert.ok(r.some(x => x.act === "timeout" && x.kind === "run"));
});

await done("archive 单元测试（mock-db 适配器）");
