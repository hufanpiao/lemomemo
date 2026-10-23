// @fixture 路径=src/scripts/logic/bad-perf.js 期望=A1
// 职责：故意违规示例：logic 里用 performance.now 计时
// 依赖：无
App.logic = App.logic || {};
App.logic.badPerf = () => performance.now();
