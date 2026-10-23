// @fixture 路径=src/scripts/ui/undeclared.js 期望=A9
// 职责：故意违规示例：用了 logic/items.js 的函数，文件头却没声明
// 依赖：无
App.ui.undeclared = x => App.logic.items.isLive(x);
