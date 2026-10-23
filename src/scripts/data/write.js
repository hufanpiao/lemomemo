// 职责：全部写入的唯一入口：saveItem 新建 / 编辑（编辑只写改过的字段）、convert 日程和待办互转、toggleDone 勾选、
//       reschedule 改期、moveAll 全部改到今天、softDelete 软删除、restore 恢复、purgeDeleted 清理 30 天前删除的、
//       ackReminder“知道了”、snoozeReminder“10 分钟后”。先改本地、发 "change"，再写存储；写入 10 秒没回应或失败
//       就回滚本地，发 "error" {code, retry}，retry 会把整个操作重做一遍。
//       每次写入都顺带更新提醒时刻的缓存 remindAt（logic/remind.js；页面实际以实时推算为准），并记运行日志（data/log.js）。
//       不碰界面，提示文案由界面根据事件决定。时钟由 init(clock) 注入，本文件不读全局时钟。
// 依赖：core/const.js、logic/remind.js、platform/index.js、data/bus.js、data/store.js、data/state.js、data/fields.js、data/log.js
App.data = App.data || {};

const C = App.core.C;
const R = App.logic.remind;
const emit = App.data.emit, store = App.data.store, S = App.data.state, F = App.data.fields, log = App.data.log;
let clock = null;   // {now(), today()}，由 init 注入
function init(c){ clock = c; }
const now = () => clock.now();
const today = () => clock.today();
const collOf = kind => kind === "event" ? "events" : "todos";
const kindOf = coll => coll === "events" ? "event" : "todo";
const DAY_MS = 86400000;
// 快照会整体替换数组；按 id 找到当前那份对象，避免改到旧对象
const live = (coll, x) => S[coll].find(y => y.id === x.id) || x;
// 合并后的条目重新算提醒时刻缓存
const remindAtOf = (kind, merged) => R.computeRemindAt(merged, kind);

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
    const code = (e && e.code) || "network";
    log.run(code === "timeout" ? "timeout" : "save_failed", code);
    if (rollback) rollback();
    emit("error", {code, retry: redo || (() => run(op, rollback, redo))});
    emit("change");
    return false;
  }
}

// kind："event" | "todo"；item：要编辑的条目，新建时为 null；
// v：表单值 {title, date, time, dur, project, note, important, remind, raw}。返回 {ok, coll, id, data}
async function saveItem(kind, item, v){
  const coll = collOf(kind), t = now();
  let data = kind === "event" ? F.eventFields(v, t) : F.todoFields(v, t);
  if (item){
    const id = item.id, before = live(coll, item);
    data = F.diff(before, data);
    if (before.snoozeAt && R.shouldResetSnooze(before, data)) data.snoozeAt = null;
    const at = remindAtOf(kind, Object.assign({}, before, data));
    if (at !== before.remindAt) data.remindAt = at;
    const ok = await run(() => store.update(coll, id, data));
    if (ok) log.op("update", coll, id, Object.keys(data));
    return {ok, coll, id, data};
  }
  F.asNew(data, coll, t, v.raw || "");
  data.remindAt = remindAtOf(kind, data);
  const id = store.newId(coll);
  S.localIds.add(id);
  const ok = await run(() => store.add(coll, id, data));
  if (ok) log.op("create", coll, id);
  return {ok, coll, id, data};
}
// 编辑时切换类型：新建另一类，旧的软删除（可以在“最近删除”里找回）。返回 {ok, coll, id}
async function convert(fromKind, item, v){
  const res = await saveItem(fromKind === "event" ? "todo" : "event", null, Object.assign({}, v, {raw: item.rawText || ""}));
  if (res.ok) await softDelete(collOf(fromKind), item);
  return res;
}
function toggleDone(x, done){
  x = live("todos", x);
  const prev = {done:x.done, doneAt:x.doneAt};
  x.done = done; x.doneAt = done ? now() : 0;
  emit("change");
  const patch = {done, doneAt:x.doneAt, remindAt: remindAtOf("todo", x), updatedAt:now()};
  return run(() => store.update("todos", x.id, patch).then(() => log.op(done ? "done" : "undone", "todos", x.id)),
    () => { x.done = prev.done; x.doneAt = prev.doneAt; }, () => toggleDone(x, done));
}
function reschedule(x, d){
  x = live("todos", x);
  const prev = {due:x.due, snoozeAt:x.snoozeAt};
  x.due = d; x.snoozeAt = null;
  emit("change");
  const patch = {due:d, snoozeAt:null, remindAt: remindAtOf("todo", x), updatedAt:now()};
  return run(() => store.update("todos", x.id, patch).then(() => log.op("reschedule", "todos", x.id)),
    () => { x.due = prev.due; x.snoozeAt = prev.snoozeAt; }, () => reschedule(x, d));
}
function moveAll(list){
  const t = today();
  list = list.map(x => live("todos", x));
  const prev = list.map(x => [x.due, x.snoozeAt]);
  list.forEach(x => { x.due = t; x.snoozeAt = null; });
  emit("change");
  const ts = now();
  return run(() => store.batch(list.map(x => ({op:"update", coll:"todos", id:x.id, data:{due:t, snoozeAt:null, remindAt: remindAtOf("todo", x), updatedAt:ts}})))
      .then(() => list.forEach(x => log.op("reschedule", "todos", x.id))),
    () => list.forEach((x, i) => { x.due = prev[i][0]; x.snoozeAt = prev[i][1]; }), () => moveAll(list));
}
// coll："events" | "todos"
function softDelete(coll, item){
  const x = live(coll, item), prev = x.deletedAt;
  x.deletedAt = now();
  emit("change");
  return run(() => store.update(coll, x.id, {deletedAt:x.deletedAt, remindAt:null, updatedAt:now()}).then(() => log.op("delete", coll, x.id)),
    () => { x.deletedAt = prev; }, () => softDelete(coll, x));
}
function restore(coll, item){
  const x = live(coll, item), prev = x.deletedAt;
  x.deletedAt = null;
  emit("change");
  const patch = {deletedAt:null, remindAt: remindAtOf(kindOf(coll), x), updatedAt:now()};
  return run(() => store.update(coll, x.id, patch).then(() => log.op("restore", coll, x.id)),
    () => { x.deletedAt = prev; }, () => restore(coll, x));
}
// 彻底删除 30 天前软删除的条目（ADR-006、需求澄清 #18）。由界面每天最多调用一次；失败不打扰用户。返回删除条数
async function purgeDeleted(){
  const cutoff = now() - C.TRASH_KEEP_DAYS * DAY_MS;
  let n = 0;
  for (const coll of ["events", "todos"]){
    for (const x of S[coll].filter(y => y.deletedAt && y.deletedAt < cutoff)){
      try { await store.remove(coll, x.id); log.op("purge", coll, x.id); n++; } catch(e){ /* 下次再清 */ }
    }
  }
  return n;
}
// “知道了”：记下已经提醒过的那个时刻（notifiedFor），其他设备据此收起提醒（需求澄清 #7）
function ackReminder(kind, item, at){
  const coll = collOf(kind), x = live(coll, item), prev = x.notifiedFor;
  x.notifiedFor = at;
  emit("change");
  return run(() => store.update(coll, x.id, {notifiedFor:at, updatedAt:now()}).then(() => log.run("remind_ack", null, {coll, id:x.id})),
    () => { x.notifiedFor = prev; }, () => ackReminder(kind, x, at));
}
// “10 分钟后”：这次算已提醒，snoozeAt 设为现在 + 10 分钟，到时再提醒一次（需求澄清 #4）
function snoozeReminder(kind, item, at){
  const coll = collOf(kind), x = live(coll, item), prev = [x.notifiedFor, x.snoozeAt];
  x.notifiedFor = at; x.snoozeAt = now() + C.SNOOZE_MS;
  emit("change");
  const patch = {notifiedFor:at, snoozeAt:x.snoozeAt, remindAt:x.snoozeAt, updatedAt:now()};
  return run(() => store.update(coll, x.id, patch).then(() => log.run("remind_snooze", null, {coll, id:x.id})),
    () => { x.notifiedFor = prev[0]; x.snoozeAt = prev[1]; }, () => snoozeReminder(kind, x, at));
}

App.data.write = {init, saveItem, convert, toggleDone, reschedule, moveAll, softDelete, restore, purgeDeleted, ackReminder, snoozeReminder, collOf, kindOf};
