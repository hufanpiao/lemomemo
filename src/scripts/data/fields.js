// 字段整理：把弹出层表单的值整理成要写入存储的日程 / 待办记录（字段和顺序与 v2 一致），
// 新建时补上 createdAt、source、rawText 和待办的 done/doneAt。纯函数。
// 依赖：无。
App.data = App.data || {};

function eventFields(v, now){
  return {title:v.title, date:v.date, time:v.time || "", durationMin:Number(v.dur)||60, project:v.project, note:v.note, updatedAt:now};
}
function todoFields(v, now){
  return {title:v.title, due:v.date || "", important:v.important, project:v.project, updatedAt:now};
}
function asNew(data, coll, now, raw){
  Object.assign(data, {createdAt:now, source:"page", rawText:raw});
  if (coll === "todos") Object.assign(data, {done:false, doneAt:0});
  return data;
}

App.data.fields = {eventFields, todoFields, asNew};
