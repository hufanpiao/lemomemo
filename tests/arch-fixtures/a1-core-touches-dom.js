// @fixture 路径=src/scripts/core/bad-dom.js 期望=A1
// 职责：故意违规示例：core 里碰页面
// 依赖：无
App.core.badDom = id => document.getElementById(id);
