// 深度诊断的两项量法：只在深度诊断打开时（diag-deep.ts）由 run-log.ts 按需下载（不放进首屏前就下载的 run-log 包）

/**
 * 切回前台数模糊层（vis-frames 行的 blur=）：对全页每个元素算一次样式，所以平时不数（写 blur=-）
 */
export function countBlur(doc: Document): number {
  let n = 0;
  for (const el of doc.querySelectorAll<HTMLElement>('body *')) {
    const cs = getComputedStyle(el);
    const bf = cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter');
    if (bf !== '' && bf !== 'none') n++;
  }
  return n;
}

/**
 * 换页头像诊断（swap pin 行）：页签互切时右上角头像（motion/page-swap.ts 的 data-swap-pin），
 * 换页后两帧（新页画完）记一行状态；没注入帧回调时用 0 ms 计时器
 * • box=1：新页还没出来、钉住的副本还在（canvas/img 是副本里画布还是图片）；box=0：新页已经出来、副本拿掉了
 * • op：新页自己那个头像算上祖先的透明度（新页头像不淡入，应一直是 1；小于 1 就是又被淡入带着走了）
 */
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
