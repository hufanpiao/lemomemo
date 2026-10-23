// @fixture 路径=src/scripts/ui/load-early.js 期望=A7
// 职责：故意违规示例：加载时就用了 logic/items.js，却写在“运行时调用”里（manifest 顺序再对也不该这样写）
// 依赖：无
// 运行时调用：logic/items.js
App.ui = App.ui || {};
const isLive = App.logic.items.isLive;   // 文件加载时就执行
App.ui.loadEarly = x => isLive(x);
