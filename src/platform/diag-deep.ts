// 深度诊断开关：开销大的诊断只在出问题时才开。
// 默认关。设置 › 关于的诊断区“Deep diag”按钮打开，只管这次打开 app（sessionStorage），读不到当关。
// 打开后运行日志（run-log.ts）多记两项开销大的量法：
// • 切回前台第 2 帧：全页逐个读计算样式，数有几层背景模糊（vis-frames 的 blur=；关着时写 blur=-）
// • 每次换页画完：页签头像那一块在不在、头像逐层算出来的不透明度（swap pin 行）
// 全局运行日志本身照常一直开，不受这个开关影响
const KEY = 'lemo-diag-deep';

export function deepDiagOn(store: Storage | undefined = globalThis.sessionStorage): boolean {
  try {
    return store?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDeepDiagOn(on: boolean, store: Storage | undefined = globalThis.sessionStorage): void {
  try {
    if (on) store?.setItem(KEY, '1');
    else store?.removeItem(KEY);
  } catch {
    /* 存不了：照旧关着 */
  }
}
