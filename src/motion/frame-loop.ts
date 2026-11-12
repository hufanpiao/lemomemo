// 每帧跑一次的循环（B3 FA-3：录音面板的计时、声波）。requestAnimationFrame 按 A25 只准写在 src/motion/。
// 外面经 components.ts 那个出口引（0.31 第 6 条只准引三个出口）。不从 motion/index.ts 出：index.ts 在首屏入口里，录音那一块从它引，
// rollup 会把 motion 的几个模块拆成单独的块挂进首屏（实测首屏多约 400 B）；也不从 gestures.ts 出：日历和录音两块都引它，
// rollup 会给日历多拆一个 gestures 共用块（实测首屏多约 60 B）。components.ts 录音面板本来就在引（Appear），不多出块
/** 每帧调一次 cb，直到调返回的停止函数 */
export function eachFrame(cb: () => void): () => void {
  let id = 0;
  const tick = (): void => {
    cb();
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}
