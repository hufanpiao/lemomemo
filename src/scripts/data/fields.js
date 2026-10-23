// 职责：把弹出层表单的值整理成要写入存储的日程 / 待办记录，新建时补上 createdAt、source、rawText 和待办的 done/doneAt；
//       编辑时 diff() 只留下真正改过的字段（避免把另一台设备期间的修改覆盖掉，PM-C②）。
//       v3：提醒选项 remind（undefined＝没动过，按默认规则；null＝不提醒；数字＝选项值）写进 remindMin 或 remindDays；
//       待办也有 note。纯函数，只被 data/write.js 使用。
// 依赖：core/const.js
App.data = App.data || {};

const C = App.core.C;

// 有时间的日程用 remindMin，全天日程和待办用 remindDays
function remindPatch(kind, hasTime, remind){
  if (remind === undefined) return {};
  return kind === "event" && hasTime ? {remindMin: remind} : {remindDays: remind};
}
// v：{title, date, time, dur, project, note, remind}
function eventFields(v, now){
  const time = v.time || "";
  return Object.assign({title:String(v.title).slice(0, C.TITLE_MAX), date:v.date, time, durationMin:Number(v.dur)||C.DEFAULT_DURATION_MIN,
    project:v.project, note:v.note || ""}, remindPatch("event", !!time, v.remind), {updatedAt:now});
}
// v：{title, date, important, project, note, remind}
function todoFields(v, now){
  return Object.assign({title:String(v.title).slice(0, C.TITLE_MAX), due:v.date || "", important:!!v.important, project:v.project, note:v.note || ""},
    remindPatch("todo", false, v.remind), {updatedAt:now});
}
function asNew(data, coll, now, raw){
  Object.assign(data, {createdAt:now, source:"page", rawText:String(raw || "").slice(0, C.RAW_MAX)});
  if (coll === "todos") Object.assign(data, {done:false, doneAt:0});
  return data;
}
// 只保留和 before 不同的字段；updatedAt 总是保留
function diff(before, data){
  const out = {};
  for (const k of Object.keys(data)) if (k === "updatedAt" || data[k] !== before[k]) out[k] = data[k];
  return out;
}

App.data.fields = {eventFields, todoFields, asNew, diff, remindPatch};
