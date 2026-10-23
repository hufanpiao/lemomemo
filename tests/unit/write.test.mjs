// 职责：data/write.js 与 data/subscribe.js 的单元测试（接 mock-db 适配器，推送延迟 0）：软删除与撤销、
//       勾选失败回滚并发 error（带 retry）、10 秒超时（测试里缩短）、moveAll 走 batch、新建记入 localIds、
//       快照经 normalize 整理、项目名单不含已删除条目、data 层只发事件不碰界面。
// 依赖：tests/lib/harness.mjs、src/scripts 的 core / logic / platform/index.js / data 各文件、tests/mock/mock-db.js
import assert from "node:assert/strict";
import { loadApp, src, plain, sleep, fakeClock, test, done } from "../lib/harness.mjs";

const FILES = [
  src("core/const.js"), src("core/date.js"), src("logic/items.js"), src("logic/projects.js"), src("platform/index.js"),
  src("data/bus.js"), src("data/store.js"), src("data/normalize.js"), src("data/fields.js"), src("data/state.js"),
  src("data/write.js"), src("data/subscribe.js"), "tests/mock/mock-db.js",
];
const SEED = () => ({
  events: { e1: { title: "对片", date: "2026-10-23", time: "10:00", project: "NEOX" } },
  todos: {
    t1: { title: "交成片", done: false, due: "2026-10-21", project: "Alpha", createdAt: 1 },
    t2: { title: "导出", done: false, due: "2026-10-22", createdAt: 2 },
    t3: { title: "坏数据", done: "false", due: "2026-10-3", id: "evil", createdAt: 3 },
  },
});

// 建一套独立的 App：mock-db 适配器 + 注入的假时钟；返回 {App, db, events, clock}
async function setup(opts = {}) {
  const ctx = loadApp(FILES);
  const App = ctx.App;
  const clock = fakeClock(ctx, 2026, 10, 23, 12, 0);
  App.data.write.init(clock);   // 不设全局 App.clock，证明写入层只用注入的时钟
  const db = App.platform.storage["mock-db"](Object.assign({ seed: SEED(), delay: 0 }, opts));
  App.data.store.use(db);
  const events = [];
  for (const t of ["change", "error", "notice"]) App.data.on(t, p => events.push([t, p]));
  await App.data.subscribe.start();
  await sleep(5);
  return { App, db, events, clock };
}
const byId = (App, id) => App.data.state.todos.find(x => x.id === id);

test("订阅：快照经 normalize 整理（类型、补零、id 以文档 id 为准）", async () => {
  const { App } = await setup();
  const t3 = plain(byId(App, "t3"));
  assert.equal(t3.id, "t3"); assert.equal(t3.done, false); assert.equal(t3.due, "2026-10-03");
  assert.equal(App.data.ready(), true);
});
test("软删除：本地立刻隐藏，存储里写 deletedAt；撤销后恢复并清空 deletedAt", async () => {
  const { App, db, clock } = await setup();
  const w = App.data.write;
  assert.equal(await w.softDelete("todos", byId(App, "t1")), true);
  assert.equal(App.data.visTd().some(x => x.id === "t1"), false);
  assert.equal(db.data.todos.t1.deletedAt, clock.now());
  await sleep(5);   // 快照回来后仍然隐藏
  assert.equal(App.data.visTd().some(x => x.id === "t1"), false);
  assert.equal(App.data.state.todos.some(x => x.id === "t1"), true, "软删除不会真的删掉");
  assert.equal(await w.restore("todos", byId(App, "t1")), true);
  assert.equal(db.data.todos.t1.deletedAt, null);
  await sleep(5);
  assert.equal(App.data.visTd().some(x => x.id === "t1"), true);
});
test("撤销拿着旧对象也有效（快照已替换数组）", async () => {
  const { App, db } = await setup();
  const old = byId(App, "t2");
  await App.data.write.softDelete("todos", old);
  await sleep(5);
  assert.notEqual(byId(App, "t2"), old, "快照应已替换为新对象");
  await App.data.write.restore("todos", old);
  assert.equal(App.data.visTd().some(x => x.id === "t2"), true);
  assert.equal(db.data.todos.t2.deletedAt, null);
});
test("项目名单不含已删除条目的项目", async () => {
  const { App } = await setup();
  assert.equal(plain(App.data.projects()).includes("Alpha"), true);
  await App.data.write.softDelete("todos", byId(App, "t1"));
  assert.equal(plain(App.data.projects()).includes("Alpha"), false);
});
test("勾选失败：回滚本地，发 error（中性错误码 + retry），retry 成功后生效", async () => {
  let failing = true;
  const { App, db, events } = await setup({ fail: () => failing ? "forbidden" : null });
  const x = byId(App, "t2");
  assert.equal(await App.data.write.toggleDone(x, true), false);
  assert.equal(byId(App, "t2").done, false, "应已回滚");
  const err = events.find(e => e[0] === "error");
  assert.ok(err, "应发出 error 事件"); assert.equal(err[1].code, "forbidden");
  failing = false;
  assert.equal(await err[1].retry(), true);
  assert.equal(db.data.todos.t2.done, true);
  assert.equal(byId(App, "t2").done, true);
});
test("写入超时：超过 WRITE_TIMEOUT_MS 没回应算失败，错误码 timeout", async () => {
  const { App, events } = await setup({ hang: true });
  App.core.C.WRITE_TIMEOUT_MS = 30;
  const t0 = Date.now();
  assert.equal(await App.data.write.reschedule(byId(App, "t2"), "2026-10-24"), false);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(byId(App, "t2").due, "2026-10-22", "应已回滚");
  assert.equal(events.find(e => e[0] === "error")[1].code, "timeout");
});
test("moveAll 走 batch：全部改到今天", async () => {
  const { App, db } = await setup();
  const late = App.data.visTd().filter(x => x.due && x.due < "2026-10-23");
  assert.equal(await App.data.write.moveAll(late), true);
  for (const id of ["t1", "t2", "t3"]) assert.equal(db.data.todos[id].due, "2026-10-23");
});
test("store.batch：适配器没有 batch 时逐条写", async () => {
  const { App, db } = await setup();
  const calls = [];
  App.data.store.use({ update: async (c, id, d) => { calls.push(id); Object.assign(db.data[c][id], d); } });
  await App.data.store.batch([{ op: "update", coll: "todos", id: "t1", data: { due: "x" } }, { op: "update", coll: "todos", id: "t2", data: { due: "y" } }]);
  assert.deepEqual(plain(calls), ["t1", "t2"]);
});
test("saveItem 新建：字段与 v2 一致，id 记入 localIds；编辑只用 update", async () => {
  const { App, db, clock } = await setup();
  const r = await App.data.write.saveItem("todo", null, { title: "买硬盘", date: "", important: false, project: "", raw: "买硬盘" });
  assert.equal(r.ok, true); assert.equal(App.data.state.localIds.has(r.id), true);
  assert.deepEqual(plain(db.data.todos[r.id]), { title: "买硬盘", due: "", important: false, project: "", updatedAt: clock.now(),
    createdAt: clock.now(), source: "page", rawText: "买硬盘", done: false, doneAt: 0 });
  const e = await App.data.write.saveItem("event", App.data.state.events[0], { title: "对片2", date: "2026-10-24", time: "", dur: "90", project: "NEOX", note: "" });
  assert.equal(e.ok, true); assert.equal(db.data.events.e1.title, "对片2"); assert.equal(db.data.events.e1.durationMin, 90);
});
test("连接不上：发 notice unavailable（带平台提示），并标记加载完成", async () => {
  const ctx = loadApp(FILES);
  ctx.App.data.write.init(fakeClock(ctx, 2026, 10, 23));
  ctx.App.data.store.use({ connect: async () => false, unavailableHint: () => ({ title: "T", text: "X" }) });
  const got = [];
  ctx.App.data.on("notice", n => got.push(plain(n)));
  await ctx.App.data.subscribe.start();
  assert.deepEqual(got, [{ type: "unavailable", hint: { title: "T", text: "X" } }]);
  assert.equal(ctx.App.data.ready(), true);
});
test("订阅断线：两个集合一起断只提示一次 lost，自动重新订阅，全部恢复后提示一次 reconnected", async () => {
  const ctx = loadApp(FILES);
  ctx.App.data.write.init(fakeClock(ctx, 2026, 10, 23));
  ctx.App.core.C.RECONNECT_MS = [5];
  let subs = 0;
  ctx.App.data.store.use({
    connect: async () => true,
    subscribe(c, onData, onError) { subs++; setTimeout(() => subs <= 4 ? onError(new Error("x")) : onData({ items: [], changes: () => [] }), 0); return () => {}; },
  });
  const got = [];
  ctx.App.data.on("notice", n => got.push(n.type));
  await ctx.App.data.subscribe.start();
  await sleep(80);
  assert.ok(subs >= 5, "应已重新订阅，实际 " + subs + " 次");
  assert.deepEqual(plain(got), ["lost", "reconnected"]);
});

await done("write / subscribe 单元测试（mock-db 适配器）");
