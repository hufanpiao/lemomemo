// 职责：启动入口：选定存储适配器（全项目唯一一处配置）、创建统一时钟、绑定各模块事件、首屏渲染、连接数据、启动时钟。
//       App.BUILD 由 build.py 在包头写入：发布版为 {storage:"claude-db"}，测试页为 {storage:"mock-db"}。
// 依赖：core/clock.js、platform/index.js、platform/env.js、platform/prefs.js、platform/claude-db.js、data/bus.js、data/store.js、data/log.js、data/write.js、data/subscribe.js、
//       ui/view-state.js、ui/render.js、ui/today.js、ui/schedule.js、ui/todos.js、ui/sheet.js、ui/nav.js、ui/remind.js、ui/theme.js、
//       platform/download.js、ui/search.js、ui/trash.js、ui/backup.js

// —— 存储适配器配置 ——
// 可选值：App.platform.storage 里注册过的名字。"claude-db"（claude.ai）、"mock-db"（测试页）；
// 以后独立服务器版加 "rest" 适配器后在这里切换。
const STORAGE = (App.BUILD && App.BUILD.storage) || "claude-db";
App.data.store.use(App.platform.storage[STORAGE]());
// —— 下载适配器配置 ——（"claude"：claude.ai 的 downloads 能力；"mock"：测试页的模拟实现）
App.platform.download.use((App.BUILD && App.BUILD.download) || "claude");

// —— 统一时钟（全页面只有这一个“现在”）——
App.clock = App.core.clock.create(App.platform.env);
App.data.write.init(App.clock);
App.data.log.init({clock: App.clock, device: App.platform.prefs.deviceId(), src: "page"});   // 运行日志（ADR-010）
App.platform.env.onHidden(() => App.data.log.flush());
App.ui.viewState.init(App.clock.today());

// —— 事件绑定 ——
App.ui.render.init();          // 数据事件 → 重绘 / 提示
App.ui.todos.init();
App.ui.sheet.init();
App.ui.nav.init();
App.ui.schedule.init();
App.ui.nav.initNet();
App.ui.theme.init();           // 深浅色（ADR-008）
App.ui.search.init();          // 待办页搜索
App.ui.trash.init();           // 最近删除
App.ui.backup.init();          // 导出备份、运行记录
App.ui.remind.init();          // v3 预留

App.clock.on("daychange", ({prev, day}) => { App.ui.viewState.onDayChange(prev, day); App.ui.render(); });
App.clock.on("tick", () => { if (App.ui.sheet.isClosed()) App.ui.render(); });

// —— 首屏与数据 ——
App.ui.nav.go(App.ui.view.view); App.ui.render();
App.data.subscribe.start();
// 每天最多一次：清理 30 天前删除的条目和 90 天前的日志（等两个集合都加载完再做）
App.data.on("loaded", () => {
  const P = App.platform.prefs, day = App.clock.today();
  if (P.get(P.KEYS.purged, "") === day) return;
  P.set(P.KEYS.purged, day);
  App.data.write.purgeDeleted(); App.data.log.purge();
});
App.clock.start();
