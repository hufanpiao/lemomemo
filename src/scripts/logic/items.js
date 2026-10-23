// 职责：条目的通用判断（纯函数）：日程时长与起止分钟、待办是否“今天完成”、是否过期没做、条目是否已软删除。
//       各处重复的判断都从这里取，改规则只改一处。
// 依赖：core/const.js、core/date.js
App.logic = App.logic || {};

const C = App.core.C;
const {ymd, hm2m} = App.core.date;

const durationOf = e => Number(e.durationMin) || C.DEFAULT_DURATION_MIN;
const startMin = e => hm2m(e.time);
const endMin = e => hm2m(e.time) + durationOf(e);
// 已完成且完成时间落在 t 那天
const isDoneOn = (x, t) => !!(x.done && x.doneAt && ymd(new Date(x.doneAt)) === t);
// 没完成、有截止日且截止日早于 t
const isLate = (x, t) => !!(!x.done && x.due && x.due < t);
// 没有被软删除（deletedAt 为空）
const isLive = x => !x.deletedAt;

App.logic.items = {durationOf, startMin, endMin, isDoneOn, isLate, isLive};
