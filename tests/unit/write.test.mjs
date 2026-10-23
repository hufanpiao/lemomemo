// 职责：data/write.js 与 data/subscribe.js 的单元测试（接 mock-db 适配器，推送延迟 0）：软删除与撤销、
//       勾选失败回滚并发 error（带 retry）、10 秒超时（测试里缩短）、moveAll 走 batch、新建记入 localIds、
//       快照经 normalize 整理、项目名单不含已删除条目、data 层只发事件不碰界面。
// 依赖：tests/lib/harness.mjs、src/scripts 的 core / logic / platform/index.js / data 各文件、tests/mock/mock-db.js
import assert from "node:assert/strict";
import { loadApp, src, plain, sleep, fakeClock, test, done } from "../lib/harness.mjs";

const FILES = [
  src("core/const.js"), src("core/date.js"), src("logic/items.js"), src("logic/projects.js"), src("logic/remind.js"), src("platform/index.js"),
  src("data/bus.js"), src("data/store.js"), src("data/normalize.js"), src("data/fields.js"), src("data/log.js"), src("data/state.js"),
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
test("saveItem 新建：v2 的字段 + v3 的 note、remindAt，id 记入 localIds；编辑只用 update", async () => {
  const { App, db, clock } = await setup();
  const r = await App.data.write.saveItem("todo", null, { title: "买硬盘", date: "", important: false, project: "", raw: "买硬盘" });
  assert.equal(r.ok, true); assert.equal(App.data.state.localIds.has(r.id), true);
  assert.deepEqual(plain(db.data.todos[r.id]), { title: "买硬盘", due: "", important: false, project: "", updatedAt: clock.now(),
    createdAt: clock.now(), source: "page", rawText: "买硬盘", done: false, doneAt: 0, note: "", remindAt: null });
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

// —— v3：提醒、编辑只写改过的字段、类型互转、最近删除、运行日志 ——
const ms = (App, d, hm) => { const [h, m] = hm.split(":").map(Number); return App.core.date.msAt(d, h * 60 + m); };
test("v3 编辑只写改过的字段（PM-C②），并更新 remindAt 缓存", async () => {
  const { App, db } = await setup();
  const calls = []; const upd = db.update; db.update = (c, id, v) => { calls.push(plain(v)); return upd(c, id, v); };
  await App.data.write.saveItem("event", App.data.state.events[0], { title: "对片", date: "2026-10-23", time: "11:00", dur: "60", project: "NEOX", note: "" });
  const sent = calls[0];
  assert.deepEqual(Object.keys(sent).sort(), ["remindAt", "time", "updatedAt"]);
  assert.equal(sent.remindAt, ms(App, "2026-10-23", "10:45"), "默认提前 15 分钟");
});
test("v3 改了时间才清空 snoozeAt；只改标题时保留（#28）", async () => {
  const { App, db } = await setup();
  const e = App.data.state.events[0]; e.snoozeAt = ms(App, "2026-10-23", "09:55");
  await App.data.write.saveItem("event", e, { title: "对片改名", date: "2026-10-23", time: "10:00", dur: "60", project: "NEOX", note: "" });
  assert.equal("snoozeAt" in db.data.events.e1, false, "只改标题，不动 snoozeAt");
  await App.data.write.saveItem("event", App.data.state.events[0], { title: "对片改名", date: "2026-10-23", time: "12:00", dur: "60", project: "NEOX", note: "" });
  assert.equal(db.data.events.e1.snoozeAt, null);
});
test("v3 提醒选项写进 remindMin（有时间的日程）或 remindDays（待办、全天日程）", async () => {
  const { App, db } = await setup();
  const r1 = await App.data.write.saveItem("event", null, { title: "a", date: "2026-10-24", time: "15:00", dur: "60", project: "", note: "", remind: 30 });
  assert.equal(db.data.events[r1.id].remindMin, 30); assert.equal(db.data.events[r1.id].remindAt, ms(App, "2026-10-24", "14:30"));
  const r2 = await App.data.write.saveItem("todo", null, { title: "b", date: "2026-10-24", important: false, project: "", remind: null });
  assert.equal(db.data.todos[r2.id].remindDays, null); assert.equal(db.data.todos[r2.id].remindAt, null);
});
test("v3 知道了：写 notifiedFor；10 分钟后：写 snoozeAt = 现在 + 10 分钟", async () => {
  const { App, db, clock } = await setup();
  const t = byId(App, "t2"); const at = ms(App, "2026-10-22", "09:00");
  await App.data.write.ackReminder("todo", t, at);
  assert.equal(db.data.todos.t2.notifiedFor, at);
  await App.data.write.snoozeReminder("todo", byId(App, "t2"), at);
  assert.equal(db.data.todos.t2.snoozeAt, clock.now() + App.core.C.SNOOZE_MS);
});
test("v3 软删除清空 remindAt；恢复后重新计算", async () => {
  const { App, db } = await setup();
  await App.data.write.softDelete("events", App.data.state.events[0]);
  assert.equal(db.data.events.e1.remindAt, null); assert.ok(db.data.events.e1.deletedAt > 0);
  await App.data.write.restore("events", App.data.state.events[0]);
  assert.equal(db.data.events.e1.deletedAt, null); assert.equal(db.data.events.e1.remindAt, ms(App, "2026-10-23", "09:45"));
});
test("v3 清理 30 天前删除的条目，30 天内的保留（ADR-006）", async () => {
  const { App, db, clock } = await setup();
  db.data.todos.t1.deletedAt = clock.now() - 31 * 86400000;
  db.data.todos.t2.deletedAt = clock.now() - 29 * 86400000;
  db.update("todos", "t3", {}); await sleep(5);   // 触发一次快照，让状态拿到 deletedAt
  assert.equal(await App.data.write.purgeDeleted(), 1);
  assert.equal("t1" in db.data.todos, false); assert.equal("t2" in db.data.todos, true);
});
test("v3 编辑时把待办改成日程：新建日程，旧待办进最近删除", async () => {
  const { App, db } = await setup();
  const r = await App.data.write.convert("todo", byId(App, "t2"), { title: "导出", date: "2026-10-22", time: "15:00", dur: "60", project: "", note: "" });
  assert.equal(r.coll, "events"); assert.equal(db.data.events[r.id].time, "15:00");
  assert.ok(db.data.todos.t2.deletedAt > 0);
});
test("v3 运行日志：写入成功记 op，只记编号和字段名，不记标题", async () => {
  const { App } = await setup();
  App.data.log.init({ clock: fakeClock(loadApp([src("core/date.js")]), 2026, 10, 23), device: "dev", src: "page" });
  await App.data.write.saveItem("event", App.data.state.events[0], { title: "秘密标题", date: "2026-10-23", time: "11:00", dur: "60", project: "NEOX", note: "" });
  const entries = plain(App.data.log.peek());
  const last = entries[entries.length - 1];
  assert.equal(last.act, "update"); assert.equal(last.coll, "events"); assert.equal(last.id, "e1");
  assert.ok(last.fields.includes("time") && !last.fields.includes("updatedAt"));
  assert.equal(JSON.stringify(entries).includes("秘密标题"), false);
});
test("v3 运行日志：写入失败记 save_failed 和错误码", async () => {
  const { App } = await setup({ fail: () => "forbidden" });
  App.data.log.init({ clock: fakeClock(loadApp([src("core/date.js")]), 2026, 10, 23), device: "dev", src: "page" });
  await App.data.write.toggleDone(byId(App, "t1"), true);
  const last = plain(App.data.log.peek()).pop();
  assert.equal(last.act, "save_failed"); assert.equal(last.code, "forbidden");
});
test("v3 运行日志：flush 写进 logs/<日期>_<设备>，追加到已有记录后面，最多 500 条", async () => {
  const { App, db } = await setup();
  const clock = fakeClock(loadApp([src("core/date.js")]), 2026, 10, 23);
  App.data.log.init({ clock, device: "dev", src: "page" });
  db.data.logs = { "2026-10-23_dev": { day: "2026-10-23", device: "dev", entries: Array.from({ length: 499 }, (_, i) => ({ t: i, kind: "op", act: "create", src: "page" })) } };
  App.data.log.run("reconnect"); App.data.log.run("remind_shown");
  await App.data.log.flush();
  const doc = db.data.logs["2026-10-23_dev"];
  assert.equal(doc.entries.length, 500); assert.equal(doc.entries[499].act, "remind_shown"); assert.equal(doc.entries[0].t, 1, "最早的一条被挤掉");
});
test("v3 运行日志：清理 90 天前的日志文档（所有设备）", async () => {
  const { App, db } = await setup();
  App.data.log.init({ clock: fakeClock(loadApp([src("core/date.js")]), 2026, 10, 23), device: "dev", src: "page" });
  db.data.logs = { "2026-07-01_dev": { day: "2026-07-01" }, "2026-07-01_claude": { day: "2026-07-01" }, "2026-08-01_dev": { day: "2026-08-01" } };
  assert.equal(await App.data.log.purge(), 2);
  assert.deepEqual(Object.keys(db.data.logs), ["2026-08-01_dev"]);
});

test("v3 类型互转一次写完：写入失败时不会留下两条（代码复审建议）", async () => {
  const { App, db } = await setup({ fail: (op, coll) => (op === "add" && coll === "events" ? "network" : null) });
  const before = Object.keys(db.data.events).length;
  const r = await App.data.write.convert("todo", byId(App, "t2"), { title: "导出", date: "2026-10-22", time: "15:00", dur: "60", project: "", note: "" });
  assert.equal(r.ok, false);
  assert.equal(Object.keys(db.data.events).length, before, "没有多出日程");
  assert.equal(db.data.todos.t2.deletedAt == null, true, "旧待办没有被删");
  assert.equal(byId(App, "t2").deletedAt == null, true, "本地也回滚了");
});
test("D13 写入时截断：标题 160 字、原话 1000 字", async () => {
  const { App, db } = await setup();
  const long = "长".repeat(1200);
  const r = await App.data.write.saveItem("todo", null, { title: long, date: "", important: false, project: "", raw: long });
  assert.equal(db.data.todos[r.id].title.length, 160); assert.equal(db.data.todos[r.id].rawText.length, 1000);
});

await done("write / subscribe 单元测试（mock-db 适配器）");
