// @fixture 路径=src/scripts/data/bad-navigator.js 期望=A2
// 职责：故意违规示例：data 层自己读网络状态（应由界面或 platform 提供）
// 依赖：无
App.data = App.data || {};
App.data.badNavigator = () => navigator.onLine;
