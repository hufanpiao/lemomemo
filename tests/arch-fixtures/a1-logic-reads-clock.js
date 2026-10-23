// @fixture 路径=src/scripts/logic/bad-now.js 期望=A1
// 职责：故意违规示例：logic 里自己读系统时间（应该由参数传入“现在”）
// 依赖：core/date.js
const {todayOf} = App.core.date;
App.logic.badNow = () => todayOf(Date.now());
