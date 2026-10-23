// 职责：把弹出层表单的值整理成要写入存储的日程 / 待办记录（字段和顺序与 v2 一致），
//       新建时补上 createdAt、source、rawText 和待办的 done/doneAt。纯函数，只被 data/write.js 使用。
// 依赖：core/const.js
App.data = App.data || {};

const C = App.core.C;

// v：{title, date, time, dur, project, note}
function eventFields(v, now){
  return {title:v.title, date:v.date, time:v.time || "", durationMin:Number(v.dur)||C.DEFAULT_DURATION_MIN, project:v.project, note:v.note, updatedAt:now};
}
// v：{title, date, important, project}
function todoFields(v, now){
  return {title:v.title, due:v.date || "", important:v.important, project:v.project, updatedAt:now};
}
function asNew(data, coll, now, raw){
  Object.assign(data, {createdAt:now, source:"page", rawText:raw});
  if (coll === "todos") Object.assign(data, {done:false, doneAt:0});
  return data;
}

App.data.fields = {eventFields, todoFields, asNew};
