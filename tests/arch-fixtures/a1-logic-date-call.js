// @fixture 路径=src/scripts/logic/bad-date-call.js 期望=A1
// 职责：故意违规示例：logic 里用 Date() 取当前时间字符串
// 依赖：无
App.logic = App.logic || {};
App.logic.badDateCall = () => Date().slice(0, 10);
