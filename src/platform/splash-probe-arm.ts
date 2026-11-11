// 启动画面颜色诊断的开关（R-371 后续，负责人 11-11“启动的时候下面那一块灰色去掉不行吗”；台账 Q-2）：只在非正式版里有。
// 诊断页（VhProbe）的“Splash colors next launch”开关在本机存储放 ARM_KEY；下次冷启动 main.tsx 读到就动态加载 splash-probe.ts
// 涂色、印数（只跑一次，开始涂就把开关清掉，再下一次冷启动像素和平时一样）。本文件不带样式，诊断页静态引用它；涂色的代码和样式在 splash-probe.ts 分包里。
// 键名、分包名登记在 build/check_no_probe.mjs 的 PROBE_MARKERS（正式包不能带）
export const ARM_KEY = 'lemo-sp-color';

export function splashProbeArmed(store: Storage = localStorage): boolean {
  try {
    return store.getItem(ARM_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSplashProbeArmed(on: boolean, store: Storage = localStorage): void {
  try {
    if (on) store.setItem(ARM_KEY, '1');
    else store.removeItem(ARM_KEY);
  } catch {
    // 本机存储用不了：开关不生效，诊断页照样显示 OFF
  }
}
