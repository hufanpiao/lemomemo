// 职责：只读的汇总数据（不写入）：trash() 最近删除列表（日程和待办，按删除时间新到旧）；
//       backup(now) 导出备份用的完整数据（从存储直接读 events、todos、logs，含已删除条目和 deletedAt，需求澄清 #19）；
//       recentLogs(today, days) 运行记录：最近几天所有设备的日志条目，只保留时间、动作、集合、编号（ADR-010）。
// 依赖：core/const.js、core/date.js、data/store.js、data/state.js、data/log.js
App.data = App.data || {};

const C = App.core.C;
const {addDays} = App.core.date;
const store = App.data.store, S = App.data.state;

function trash(){
  const all = S.events.filter(x => x.deletedAt).map(item => ({coll:"events", kind:"event", item}))
    .concat(S.todos.filter(x => x.deletedAt).map(item => ({coll:"todos", kind:"todo", item})));
  return all.sort((a, b) => b.item.deletedAt - a.item.deletedAt);
}
// 导出备份：数据库里有什么就导出什么（不经过页面的字段整理）。logs 读不到时导出为空数组并带 logsError
// 读日志前先把内存里攒着的写进去，导出和“运行记录”才包含刚刚的操作
const flushLogs = async () => { try { await App.data.log.flush(); } catch(e){} };
async function backup(now){
  await flushLogs();
  const [events, todos] = await Promise.all([store.list("events"), store.list("todos")]);
  let logs = [], logsError;
  try { logs = await store.list("logs"); } catch(e){ logsError = (e && e.code) || "network"; }
  const out = {app:"planner", format:1, exportedAt:now, counts:{events:events.length, todos:todos.length, logs:logs.length}, events, todos, logs};
  if (logsError) out.logsError = logsError;
  return out;
}
// 运行记录：[{t, act, coll, id, kind}]，新到旧，最多 LOG_VIEW_MAX 条
async function recentLogs(today, days){
  await flushLogs();
  const from = addDays(today, -(days - 1));
  const out = [];
  for (const doc of await store.list("logs")){
    const day = typeof doc.day === "string" ? doc.day : String(doc.id).slice(0, 10);
    if (day < from || !Array.isArray(doc.entries)) continue;
    for (const e of doc.entries){
      if (!e || typeof e.t !== "number") continue;
      out.push({t:e.t, act:String(e.act || ""), coll: e.coll ? String(e.coll) : "", id: e.id == null ? "" : String(e.id), kind: e.kind === "run" ? "run" : "op"});
    }
  }
  return out.sort((a, b) => b.t - a.t).slice(0, C.LOG_VIEW_MAX);
}

App.data.archive = {trash, backup, recentLogs};
