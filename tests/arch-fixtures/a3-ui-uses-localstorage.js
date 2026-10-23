// @fixture 路径=src/scripts/ui/bad-prefs.js 期望=A3
// 职责：故意违规示例：界面直接读写 localStorage（应该用 platform/prefs.js）
// 依赖：无
App.ui.badPrefs = () => localStorage.getItem("pv-view");
