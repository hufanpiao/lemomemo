// 平台能力入口：所有依赖运行环境（claude.ai / 以后的独立服务器 PWA）的能力都注册在 App.platform 下，
// UI 代码不直接调用 window.claude 等平台接口。目前只有 storage（存储适配器）。
// 依赖：无。
App.platform = App.platform || {};
App.platform.storage = App.platform.storage || {};   // 存储适配器工厂：{"claude-db": fn, "mock-db": fn, ...}

/*
 * 以后计划加的平台能力（这次不实现，只约定位置和形状）：
 *   App.platform.download = { saveFile(name, blob) }
 *     claude.ai：走发布平台提供的文件下载能力；独立服务器：<a download> + URL.createObjectURL。
 *   App.platform.notify = { requestPermission(), schedule({id, at, title, body}), cancel(id) }
 *     claude.ai：平台提醒能力（若有）；独立服务器：Service Worker + Web Push（需后端推送服务）。
 */
