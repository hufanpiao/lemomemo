// 职责：运行环境的时间来源与定时器，注入给 core/clock.js：now() 当前毫秒、every(ms, fn) 定时、
//       onVisible(fn) 页面切回前台。测试里用假的 env 替换，就能固定“现在”。
// 依赖：platform/index.js
App.platform = App.platform || {};

App.platform.env = {
  now: () => Date.now(),
  every: (ms, fn) => setInterval(fn, ms),
  onVisible(fn){
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") fn(); });
  },
};
