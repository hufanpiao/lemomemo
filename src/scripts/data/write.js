// 职责：全部写入的唯一入口：saveItem 新建 / 编辑、toggleDone 勾选、reschedule 改期、moveAll 全部改到今天、
//       softDelete 软删除（写 deletedAt）、restore 恢复（清空 deletedAt）。先改本地、发 "change"，再写存储；
//       写入 10 秒没回应或失败就回滚本地，发 "error" {code, retry}，retry 会把整个操作重做一遍。
//       以后的 remindAt 计算也在这里统一接入（logic/remind.js）。不碰界面，提示文案由界面根据事件决定。
//       时钟由 init(clock) 注入（app.js 传入统一时钟，测试传入假时钟），本文件不读全局时钟。
// 依赖：core/const.js、platform/index.js、data/bus.js、data/store.js、data/state.js、data/fields.js
App.data = App.data || {};

const C = App.core.C;
const emit = App.data.emit, store = App.data.store, S = App.data.state, F = App.data.fields;
let clock = null;   // {now(), today()}，由 init 注入
function init(c){ clock = c; }
const now = () => clock.now();
const today = () => clock.today();
const collOf = kind => kind === "event" ? "events" : "todos";
// 快照会整体替换数组；按 id 找到当前那份对象，避免改到旧对象
const live = (coll, x) => S[coll].find(y => y.id === x.id) || x;

function withTimeout(p, ms){
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(App.platform.storeError("timeout")), ms);
    Promise.resolve(p).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
// op：执行存储写入并返回 Promise；rollback：失败时恢复本地；redo：“重试”时重做整个操作（缺省只重写存储）
async function run(op, rollback, redo){
  try { await withTimeout(op(), C.WRITE_TIMEOUT_MS); return true; }
  catch(e){
    if (rollback) rollback();
    emit("error", {code: (e && e.code) || "network", retry: redo || (() => run(op, rollback, redo))});
    emit("change");
    return false;
  }
}

// kind："event" | "todo"；item：要编辑的条目，新建时为 null；
// v：表单值 {title, date, time, dur, project, note, important, raw}。返回 {ok, coll, id, data}
async function saveItem(kind, item, v){
  const coll = collOf(kind), t = now();
  const data = kind === "event" ? F.eventFields(v, t) : F.todoFields(v, t);
  if (item){
    const id = item.id;
    return {ok: await run(() => store.update(coll, id, data)), coll, id, data};
  }
  F.asNew(data, coll, t, v.raw || "");
  const id = store.newId(coll);
  S.localIds.add(id);
  return {ok: await run(() => store.add(coll, id, data)), coll, id, data};
}
function toggleDone(x, done){
  x = live("todos", x);
  const prev = {done:x.done, doneAt:x.doneAt};
  x.done = done; x.doneAt = done ? now() : 0;
  emit("change");
  return run(() => store.update("todos", x.id, {done, doneAt:x.doneAt, updatedAt:now()}),
    () => { x.done = prev.done; x.doneAt = prev.doneAt; }, () => toggleDone(x, done));
}
function reschedule(x, d){
  x = live("todos", x);
  const prev = x.due; x.due = d;
  emit("change");
  return run(() => store.update("todos", x.id, {due:d, updatedAt:now()}), () => { x.due = prev; }, () => reschedule(x, d));
}
function moveAll(list){
  const t = today();
  list = list.map(x => live("todos", x));
  const prev = list.map(x => x.due);
  list.forEach(x => x.due = t);
  emit("change");
  const ts = now();
  return run(() => store.batch(list.map(x => ({op:"update", coll:"todos", id:x.id, data:{due:t, updatedAt:ts}}))),
    () => list.forEach((x, i) => x.due = prev[i]), () => moveAll(list));
}
// coll："events" | "todos"
function softDelete(coll, item){
  const x = live(coll, item), prev = x.deletedAt;
  x.deletedAt = now();
  emit("change");
  return run(() => store.update(coll, x.id, {deletedAt:x.deletedAt, updatedAt:now()}), () => { x.deletedAt = prev; }, () => softDelete(coll, x));
}
function restore(coll, item){
  const x = live(coll, item), prev = x.deletedAt;
  x.deletedAt = null;
  emit("change");
  return run(() => store.update(coll, x.id, {deletedAt:null, updatedAt:now()}), () => { x.deletedAt = prev; }, () => restore(coll, x));
}

App.data.write = {init, saveItem, toggleDone, reschedule, moveAll, softDelete, restore, collOf};
