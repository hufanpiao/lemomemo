// @fixture 路径=src/scripts/ui/bad-session.js 期望=A3
// 职责：故意违规示例：界面直接用 sessionStorage（应该用 platform/prefs.js）
// 依赖：无
App.ui = App.ui || {};
App.ui.badSession = () => sessionStorage.getItem("x");
