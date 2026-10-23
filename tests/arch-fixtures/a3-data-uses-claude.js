// @fixture 路径=src/scripts/data/bad-claude.js 期望=A3
// 职责：故意违规示例：data 层绕过适配器直接用 window.claude
// 依赖：无
App.data.badClaude = async () => (await window.claude.use("db")).collection("todos");
