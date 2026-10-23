// @fixture 路径=src/scripts/ui/bad-bracket-store.js 期望=A4
// 职责：故意违规示例：用方括号 App.data["store"] 绕过“界面不直接写存储”的检查
// 依赖：data/store.js
App.ui = App.ui || {};
App.ui.badBracket = x => App.data["store"].update("todos", x.id, {done:true});
