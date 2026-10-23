// 职责：运行日志（ADR-010）。op() 记操作、run() 记运行状况，先在内存里攒着，每 LOG_FLUSH_MS 或页面切到后台时
//       写进存储的 logs 集合：每台设备每天一条文档，id 为 "<YYYY-MM-DD>_<设备号>"，最多 LOG_MAX_ENTRIES 条。
//       purge() 每天最多一次，清掉 LOG_KEEP_DAYS 天以前的日志文档。**只记编号、字段名和错误码，不记任何内容。**
//       日志写入失败不影响正常功能：静默丢弃，不发 error 事件。
// 依赖：core/const.js、core/date.js、data/store.js
App.data = App.data || {};

const C = App.core.C;
const {addDays} = App.core.date;
const store = App.data.store;
const ACTS_WITH_FIELDS = ["update"];

let clock = null, device = "unknown", src = "page", timer = null;
let pending = [];             // 还没写进存储的
const days = {};              // 本次打开页面后已写过的那一天：{day: entries 数组}

// opts：{clock, device, src}
function init(opts){
  clock = opts.clock; device = String(opts.device || "unknown").slice(0, 40); src = opts.src || "page";
}
function push(e){
  if (!clock) return;
  e.t = clock.now(); e.src = src;
  pending.push(e);
  if (timer == null) timer = setTimeout(() => { timer = null; flush(); }, C.LOG_FLUSH_MS);
}
// 操作：act 如 create / update / done / undone / reschedule / delete / restore / purge；fields 只在 update 时记
function op(act, coll, id, fields){
  const e = {kind:"op", act, coll, id: id == null ? undefined : String(id)};
  if (fields && ACTS_WITH_FIELDS.includes(act)) e.fields = fields.filter(f => f !== "updatedAt").slice(0, 20);
  push(clean(e));
}
// 运行：act 如 save_failed / timeout / disconnect / reconnect / remind_shown / remind_ack / remind_snooze；code 为中性错误码
function run(act, code, extra){
  push(clean(Object.assign({kind:"run", act, code}, extra && {coll: extra.coll, id: extra.id == null ? undefined : String(extra.id)})));
}
const clean = e => { for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; return e; };

// 把攒着的写进存储；按“发生那天”分组，每组读出当天文档（本次第一次写时）后追加
async function flush(){
  if (!pending.length || !store.connected) return;
  const batch = pending; pending = [];
  const byDay = {};
  for (const e of batch){ const d = App.core.date.todayOf(e.t); (byDay[d] = byDay[d] || []).push(e); }
  for (const [day, list] of Object.entries(byDay)){
    const id = day + "_" + device;
    try {
      if (!days[day]){
        const old = await store.get("logs", id);
        days[day] = old && Array.isArray(old.entries) ? old.entries.slice() : [];
      }
      days[day] = days[day].concat(list).slice(-C.LOG_MAX_ENTRIES);
      await store.add("logs", id, {day, device, entries: days[day], updatedAt: clock.now()});
    } catch(e){ /* 日志失败不影响功能，丢弃 */ }
  }
}
// 删除 LOG_KEEP_DAYS 天以前的日志文档（所有设备的，包括 claude / task）；返回删掉的文档数
async function purge(){
  if (!store.connected || !clock) return 0;
  const cutoff = addDays(clock.today(), -C.LOG_KEEP_DAYS);
  let n = 0;
  try {
    for (const doc of await store.list("logs")){
      const day = typeof doc.day === "string" ? doc.day : String(doc.id).slice(0, 10);
      if (day < cutoff){ await store.remove("logs", doc.id); n++; }
    }
  } catch(e){ /* 同上 */ }
  return n;
}
// 测试用：看攒着的条目
const peek = () => pending.slice();

App.data.log = {init, op, run, flush, purge, peek};
