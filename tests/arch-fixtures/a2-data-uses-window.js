// @fixture 路径=src/scripts/data/bad-window.js 期望=A2
// 职责：故意违规示例：data 层直接用 window
// 依赖：无
App.data = App.data || {};
App.data.badWindow = () => window.innerWidth;
