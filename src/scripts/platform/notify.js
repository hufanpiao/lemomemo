// 职责：【v3 预留，尚未实现】提示音与推送的平台接口。ui/remind.js 只调用这里，不直接碰浏览器通知或 claude.ai 能力。
// 依赖：platform/index.js
App.platform = App.platform || {};

/*
 * chime(): boolean
 *   页面开着时到点响一声提示音（Web Audio 合成，不加载外部文件）。浏览器不允许自动播放时返回 false。
 * pushSupported(): boolean
 *   当前平台能否在页面关闭时推送。claude.ai 版：false（改由 Claude 定时任务推送，见 ADR-005）；
 *   独立服务器 PWA 版：Service Worker + Web Push 可用时为 true。
 * requestPermission(): Promise<"granted" | "denied" | "unsupported">
 * push({title, body, at}): Promise<boolean>
 *   推送文字要脱敏：只写“10:00 1 项日程（NEOX）”这类时间加项目简称，不带完整标题、备注和地点（安全审查）。
 */
App.platform.notify = {
  chime: () => false,
  pushSupported: () => false,
  requestPermission: async () => "unsupported",
  push: async () => false,
};
