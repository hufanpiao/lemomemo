// @fixture 路径=src/scripts/data/bad-location.js 期望=A2
// 职责：故意违规示例：data 层直接刷新页面
// 依赖：无
App.data = App.data || {};
App.data.badLocation = () => location.reload();
