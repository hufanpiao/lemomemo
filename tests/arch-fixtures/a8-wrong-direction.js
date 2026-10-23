// @fixture 路径=src/scripts/logic/bad-direction.js 期望=A8
// 职责：故意违规示例：logic 在文件头声明依赖 ui 层
// 依赖：ui/dom.js
App.logic.badDirection = () => 1;
