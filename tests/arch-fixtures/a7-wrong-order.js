// @fixture 路径=src/scripts/logic/too-early.js 期望=A7 位置=开头
// 职责：故意违规示例：放在 manifest 最前面，却依赖排在后面的 core/date.js
// 依赖：core/date.js
const {pad} = App.core.date;
App.logic.tooEarly = n => pad(n);
