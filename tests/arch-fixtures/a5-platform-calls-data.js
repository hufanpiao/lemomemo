// @fixture 路径=src/scripts/platform/bad-up.js 期望=A5
// 职责：故意违规示例：platform 反过来调用 data 层
// 依赖：platform/index.js
App.platform.badUp = () => App.data.emit("change");
