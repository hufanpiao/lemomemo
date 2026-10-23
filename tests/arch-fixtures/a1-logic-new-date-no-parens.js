// @fixture 路径=src/scripts/logic/bad-new-date.js 期望=A1
// 职责：故意违规示例：logic 里用不带括号的 new Date 取当前时间
// 依赖：无
App.logic = App.logic || {};
App.logic.badNewDate = () => (new Date).getHours();
