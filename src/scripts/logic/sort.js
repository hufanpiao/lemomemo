// 职责：排序与挑选（纯函数）：日程按日期+时间排序、待办排序（未完成在前、重要在前、截止早的在前），
//       pickNext() 挑“下一件事”：今天还没结束的第一个定时日程，没有就取最该做的未完成待办。
// 依赖：core/const.js、logic/items.js
App.logic = App.logic || {};

const C = App.core.C;
const {startMin, endMin} = App.logic.items;

const byTime = (a,b) => (a.date+(a.time||"00:00")).localeCompare(b.date+(b.time||"00:00"));
function sortTodos(list){
  list.sort((a,b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (a.done) return (b.doneAt||0)-(a.doneAt||0);
    if (!!a.important !== !!b.important) return a.important ? -1 : 1;
    const x = a.due || C.NO_DUE, y = b.due || C.NO_DUE;
    return x === y ? (a.createdAt||0)-(b.createdAt||0) : x.localeCompare(y);
  });
  return list;
}
// events/todos：可见条目；t：今天 "YYYY-MM-DD"；nm：现在是当天第几分钟
function pickNext(events, todos, t, nm){
  const evs = events.filter(e => e.date === t && e.time).sort((a,b) => a.time.localeCompare(b.time));
  for (const e of evs){
    const s = startMin(e), end = endMin(e);
    if (end > nm) return {kind:"event", item:e, start:s, end};
  }
  const open = todos.filter(x => !x.done);
  open.sort((a,b) => (b.important?1:0)-(a.important?1:0) || (a.due||C.NO_DUE).localeCompare(b.due||C.NO_DUE) || (a.createdAt||0)-(b.createdAt||0));
  return open[0] ? {kind:"todo", item:open[0]} : null;
}

App.logic.sort = {byTime, sortTodos, pickNext};
