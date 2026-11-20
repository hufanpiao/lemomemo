// 换页头像诊断（swap pin）：只在深度诊断打开时由 run-log.ts 按需下载（11-20 全 app 改善报告第四节；首屏预算只剩几十字节，不放进首屏前就下载的 run-log 包）
// 页签互切时右上角头像（负责人 11-18“头像怎么也还是会消失”，motion/page-swap.ts 的 data-swap-pin）：换页画完时记一行状态。
// • box=1：新页还没出来、钉住的副本还在（canvas/img 是副本里画布还是图片）；box=0：新页已经出来、副本拿掉了
// • op：新页自己那个头像算上祖先的透明度（11-19 起新页头像不淡入，应一直是 1；小于 1 就是又被淡入带着走了）
// 原来在 App.tsx 每次换页都逐层算不透明度（正式版也算）；行的写法不变

/** 两帧以后（新页画完）记一行；没注入帧回调时用 0 ms 计时器 */
export function noteSwapPin(doc: Document, add: (line: string) => void, frame?: (cb: () => void) => void): void {
  const run = (): void => {
    const box = doc.querySelector('[data-tab-pin]');
    const me = doc.querySelector('main [data-swap-pin]');
    let op = me ? 1 : 0;
    for (let e = me; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity) || 0;
    if (box || me) add(`app swap pin box=${box ? 1 : 0} canvas=${box?.querySelectorAll('canvas').length ?? 0} img=${box?.querySelectorAll('img').length ?? 0} op=${op.toFixed(2)}`);
  };
  if (frame) frame(() => frame(run));
  else setTimeout(run, 0);
}
