// 职责：运行环境的时间来源与定时器，注入给 core/clock.js：now() 当前毫秒、after(ms, fn) 延时一次（返回句柄）、
//       cancel(句柄) 取消、onVisible(fn) 页面切回前台、onHidden(fn) 切到后台或关闭。测试里用假的 env 替换，就能固定“现在”。
// 依赖：platform/index.js
App.platform = App.platform || {};

App.platform.env = {
  now: () => Date.now(),
  after: (ms, fn) => setTimeout(fn, ms),
  cancel: h => clearTimeout(h),
  onVisible(fn){
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") fn(); });
  },
  // v3：页面切到后台或关闭（用来立即写运行日志）
  onHidden(fn){
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") fn(); });
    addEventListener("pagehide", fn);
  },
};
