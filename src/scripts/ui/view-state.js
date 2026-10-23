// 职责：界面状态：当前页（记在本机偏好）、日程页选中的日期与本周起点、待办的项目筛选、是否展开已完成、
//       勾选动画的停顿时刻 holdUntil、刚恢复条目的高亮 flash。项目筛选 projFilter 由日程页和待办页共用（不作用于今天页）。跨天时 onDayChange() 把停在“旧的今天”的选中日期和本周挪到新的今天。
// 依赖：core/date.js、platform/prefs.js
App.ui = App.ui || {};

const {mondayOf} = App.core.date;
const prefs = App.platform.prefs;

const V = {
  view: "today", selDay: "", weekStart: "", projFilter: null, showDone: false,
  holdUntil: 0, holdTimer: null,
  flash: new Set(),   // 刚从“最近删除”恢复的 id：回到原位时用 .fresh 短暂高亮
};
function init(t){
  V.view = prefs.get(prefs.KEYS.view, "today");
  V.selDay = t; V.weekStart = mondayOf(t);
}
function onDayChange(prev, day){
  if (V.selDay === prev) V.selDay = day;
  if (V.weekStart === mondayOf(prev)) V.weekStart = mondayOf(day);
}

App.ui.view = V;
App.ui.viewState = {init, onDayChange};
