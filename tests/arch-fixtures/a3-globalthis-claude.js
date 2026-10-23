// @fixture 路径=src/scripts/ui/bad-global-claude.js 期望=A3
// 职责：故意违规示例：绕过适配器，用 globalThis.claude 访问平台
// 依赖：无
App.ui = App.ui || {};
App.ui.badGlobalClaude = () => globalThis.claude.use("db");
