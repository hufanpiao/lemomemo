// @fixture 路径=src/scripts/ui/bad-idb.js 期望=A3
// 职责：故意违规示例：界面直接用 indexedDB
// 依赖：无
App.ui = App.ui || {};
App.ui.badIdb = () => indexedDB.open("planner");
