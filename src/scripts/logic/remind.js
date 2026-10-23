// 职责：【v3 预留，尚未实现】提醒时刻计算（纯函数）。保存条目时由 data/write.js 调用，结果写进 remindAt。
//       字段含义见 docs/05-数据字典/数据字典.md 与 docs/02-设计/修改清单-v3.md。
// 依赖：core/const.js、core/date.js
App.logic = App.logic || {};

/*
 * computeRemindAt(item, kind, now) → number | null
 *   item：整理过的条目（data/normalize.js 的输出）
 *   kind："event" | "todo"
 *   now ：当前毫秒时间戳（由调用方传入，本函数不读系统时间）
 *   返回：提醒时刻（毫秒）；不需要提醒、已完成、已删除或时刻已过时返回 null。
 *
 * 规则（v3 修改清单）：
 *   有时间的日程：remindMin = null 不提醒 / 0 准时 / 15 / 30 / 60 / 1440（提前 1 天）；默认 15。
 *                 remindAt = date + time 的时刻 − remindMin 分钟。
 *   全天日程：    remindDays = null 不提醒 / 0 当天 9:00 / 1 前一天 20:00。
 *   待办（有 due）：remindDays = null 不提醒 / 0 当天 9:00 / 1 前一天 9:00；默认 0，important 时默认 1。
 *                 done 为 true 时返回 null。
 *   任何条目：    deletedAt 有值时返回 null。
 *   snoozeAt（稍后再提醒）和 notifiedFor（已提醒去重）不在这里处理，由 ui/remind.js 和 data/write.js 负责。
 */
function computeRemindAt(item, kind, now){
  return null;   // v3 实现
}

App.logic.remind = {computeRemindAt};
