// 职责：提醒规则（纯函数）。按条目字段算出“实际提醒时刻”，判断现在该不该提醒，给出提醒选项和标签文案。
//       页面（ui/remind.js）和 Claude 定时推送用同一套规则，“现在”一律由调用方传入，本文件不读系统时间。
//       规则依据：docs/02-设计/需求澄清-v3.md #1–#5、#28–#31，数据字典“v3 计划中的规则补充”。
// 依赖：core/const.js、core/date.js
App.logic = App.logic || {};

const C = App.core.C;
const {msAt, hm2m, addDays} = App.core.date;
const MIN = 60000;

// 条目的提醒设置（缺字段时按默认规则，需求澄清 #2）：
//   有时间的日程 → {type:"event-time", min}；全天日程 → {type:"event-allday", days}；有截止日的待办 → {type:"todo", days}
//   不提醒、没有日期、待办没截止日 → null
function setting(item, kind){
  if (!item) return null;
  if (kind === "event"){
    if (!item.date) return null;
    if (item.time){
      const v = item.remindMin === undefined ? C.REMIND_EVENT_DEFAULT_MIN : item.remindMin;
      return v === null ? null : {type:"event-time", min:v};
    }
    const d = item.remindDays === undefined ? 1 : item.remindDays;
    return d === null ? null : {type:"event-allday", days:d};
  }
  if (!item.due) return null;
  const d = item.remindDays === undefined ? (item.important ? 1 : 0) : item.remindDays;
  return d === null ? null : {type:"todo", days:d};
}

// 按规则算出的提醒时刻（毫秒），不考虑 snoozeAt
function baseAt(item, kind){
  const s = setting(item, kind);
  if (!s) return null;
  if (s.type === "event-time") return msAt(item.date, hm2m(item.time)) - s.min * MIN;
  if (s.type === "event-allday") return s.days >= 1 ? msAt(addDays(item.date, -s.days), C.REMIND_ALLDAY_PREV_MIN) : msAt(item.date, C.REMIND_DAY_MORNING_MIN);
  return s.days >= 1 ? msAt(addDays(item.due, -s.days), C.REMIND_TODO_PREV_MIN) : msAt(item.due, C.REMIND_DAY_MORNING_MIN);
}

// 实际提醒时刻 = max(按规则算出的时刻, snoozeAt)；已删除、已完成、不提醒时为 null（需求澄清 #4）
function computeRemindAt(item, kind){
  if (!item || item.deletedAt) return null;
  if (kind === "todo" && item.done) return null;
  const base = baseAt(item, kind);
  if (base == null) return null;
  return item.snoozeAt && item.snoozeAt > base ? item.snoozeAt : base;
}

// 日程的开始和结束时刻（全天日程为当天 0:00–24:00）
function eventSpan(item){
  if (!item.time) return {start: msAt(item.date, 0), end: msAt(item.date, 24 * 60)};
  const start = msAt(item.date, hm2m(item.time));
  return {start, end: start + (Number(item.durationMin) || C.DEFAULT_DURATION_MIN) * MIN};
}

// 现在该不该提醒这一条。lead：提前量（页面为 0；定时推送为 C.PUSH_LEAD_MS，宁可早到）。
// 返回 {at} 或 null。规则：
//   - 实际提醒时刻 ≤ 现在 + lead；
//   - 过了实际提醒时刻 60 分钟以上的不再提醒（#30）；
//   - notifiedFor 等于实际提醒时刻 → 已经提醒过（去重）；
//   - 日程已经结束的不提醒；提醒时刻已过但还没开始的照样提醒（#3）。
function due(item, kind, now, lead){
  const at = computeRemindAt(item, kind);
  if (at == null) return null;
  if (item.notifiedFor === at) return null;
  if (at > now + (lead || 0)) return null;
  if (now - at > C.REMIND_STALE_MS) return null;
  if (kind === "event" && now >= eventSpan(item).end) return null;
  return {at};
}

// 从全部条目里挑出现在要提醒的，按提醒时刻从早到晚排序。
// events/todos：已整理、未删除的条目；返回 [{kind, item, at}]
function dueList(events, todos, now, lead){
  const out = [];
  for (const e of events){ const d = due(e, "event", now, lead); if (d) out.push({kind:"event", item:e, at:d.at}); }
  for (const t of todos){ const d = due(t, "todo", now, lead); if (d) out.push({kind:"todo", item:t, at:d.at}); }
  return out.sort((a, b) => a.at - b.at);
}

// 改了哪些字段时要清空 snoozeAt（#28）：日期、时间、提醒选项
const SNOOZE_RESET_FIELDS = ["date", "time", "due", "remindMin", "remindDays"];
const shouldResetSnooze = (before, patch) => SNOOZE_RESET_FIELDS.some(k => k in patch && patch[k] !== before[k]);

// 弹出层里的提醒选项：[{value, label}]；value 写进 remindMin（有时间的日程）或 remindDays（其他）
function options(kind, hasTime){
  if (kind === "event" && hasTime) return C.REMIND_EVENT_OPTIONS.map(v => ({value:v, label: minLabel(v)}));
  if (kind === "event") return [{value:null, label:"不提醒"}, {value:0, label:"当天 9:00"}, {value:1, label:"前一天 20:00"}];
  return [{value:null, label:"不提醒"}, {value:0, label:"当天 9:00"}, {value:1, label:"前一天 9:00"}];
}
function minLabel(v){
  if (v === null) return "不提醒";
  if (v === 0) return "准时";
  if (v % 1440 === 0) return v / 1440 + " 天";
  if (v % 60 === 0) return v / 60 + " 小时";
  return v + " 分";
}
// 条目上铃铛标签的文字；不提醒时为 ""
function label(item, kind){
  const s = setting(item, kind);
  if (!s) return "";
  if (s.type === "event-time") return s.min === 0 ? "准时提醒" : "提前 " + minLabel(s.min);
  if (s.type === "event-allday") return s.days >= 1 ? "前一天 20:00" : "当天 9:00";
  return s.days >= 1 ? "前一天 9:00" : "当天 9:00";
}
// 当前选中的选项值（缺字段时显示默认值）
function currentValue(item, kind){
  const s = setting(item, kind);
  if (!s) return null;
  return s.type === "event-time" ? s.min : s.days;
}

App.logic.remind = {setting, baseAt, computeRemindAt, eventSpan, due, dueList, shouldResetSnooze, options, label, currentValue};
