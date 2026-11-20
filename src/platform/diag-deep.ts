// 深度诊断开关（11-20 全 app 改善报告第四节：一直开着的临时诊断改成出问题时才开；做法照 platform/speech.ts 的 Live speech 诊断开关）
// 默认关。设置 › 关于的诊断区“Deep diag”按钮打开，只管这次打开 app（sessionStorage，杀掉重开回到关），读不到当关。
// 打开后运行日志（platform/run-log.ts）多记两项为单个问题临时加的、开销大的量法：
// • 切回前台第 2 帧：全页逐个读计算样式，数有几层背景模糊（vis-frames 的 blur=；关着时写 blur=-）—— 负责人 11-18 回前台白屏
// • 每次换页画完：页签头像那一块在不在、页面里头像逐层算出来的不透明度（swap pin 行）—— 负责人 11-18“头像怎么也还是会消失”
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
