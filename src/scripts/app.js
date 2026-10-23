// 启动入口：选定存储适配器（全项目唯一一处配置）、绑定各模块事件、首屏渲染、连接数据、每分钟刷新。
// 依赖：platform/*、data/*、ui/*（build/manifest.json 保证它最后拼接）。
// App.BUILD 由 build.py 在包头写入：发布版为 {storage:"claude-db"}，测试页为 {storage:"mock-db"}。

// —— 存储适配器配置 ——
// 可选值：App.platform.storage 里注册过的名字。"claude-db"（claude.ai）、"mock-db"（测试页）；
// 以后独立服务器版加 "rest" 适配器后在这里切换。
const STORAGE = (App.BUILD && App.BUILD.storage) || "claude-db";
App.data.store.use(App.platform.storage[STORAGE]());

// 事件绑定（顺序与 v2 一致）
App.ui.todos.init();
App.ui.toast.init();
App.data.write.init();
App.ui.sheet.init();
App.ui.nav.init();
App.ui.schedule.init();
App.ui.nav.initNet();

App.ui.nav.go(App.data.state.view); App.ui.render();

App.data.subscribe.start();

// 每分钟刷新时间轴与倒计时
setInterval(() => { if (App.core.dom.$("sheet").hidden) App.ui.render(); }, 60000);
