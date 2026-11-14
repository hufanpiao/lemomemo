// 吞掉下一次点按（审查“吞点按五套”合成这一套）：手势做完以后浏览器还会补一下 click，这一下不能当成点按。
// 用的地方：换页守卫（index.ts guardTaps 吞掉按下后晚到的那一下）、横向拖动（hdrag.ts：月历翻页、kit 左滑行滑完松手、点行面收起）、
// 按住“＋”（plus 的 hold-input 进了录音以后松手）
// • 在 window 的捕获阶段拦：比 React 挂在根节点上的 click、document 上的捕获监听都先到，吞掉就到不了下面的 onClick
// • 只吞落在 within 里的第一下（within 不给就是落在哪儿都吞）；落在别处的照常、也不作废（按住“＋”松手后马上点提示条上的按钮）
// • 新的一次按下（pointerdown）、按了键盘（keydown），或这次触摸被浏览器收走（pointercancel，变成了滚动）就作废：上一下的 click 不会再来了，
//   不能把这一次正常点按的 click 当成晚到的那一下吞掉（代码审查 S12）。在按下的监听里挂上的，不会被这一次按下自己作废
//   （window 的捕获监听在派发这一次按下时已经轮过了）
// • 键盘的 click（焦点在按钮上按回车、空格）前面一定有 keydown，所以不会被吞（R-420 审查第 12 条：左滑完马上在行面按回车照常打开）。
//   不按 e.detail === 0 认键盘：页面里派发的 MouseEvent（e2e 模拟手指，例如 b2-vt-taps.spec.ts）detail 也是 0，会被当成键盘放过去
// • 时限 ms 只管“一直等不到 click 时监听挂多久”（默认 tokens.ts 的 TAP_SWALLOW_MS），到点由 setTimeout 摘掉
// 纯 TS，不引 React
import { TAP_SWALLOW_MS } from './tokens.ts';

export interface SwallowClickOptions {
  /** 只吞落在这个节点里的 click；不给（null）就是落在哪儿都吞 */
  within?: Node | null;
  /** 时限（毫秒）：到了就摘掉监听；默认 TAP_SWALLOW_MS */
  ms?: number;
}

/** 吞掉下一次点按；返回作废函数（重复调用没事） */
export function swallowNextClick({ within = null, ms = TAP_SWALLOW_MS }: SwallowClickOptions): () => void {
  const onClick = (e: Event): void => {
    if (within && !(e.target instanceof Node && within.contains(e.target))) return;
    off();
    e.preventDefault();
    e.stopPropagation();
  };
  const off = (): void => {
    clearTimeout(timer);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('pointerdown', off, true);
    window.removeEventListener('pointercancel', off, true);
    window.removeEventListener('keydown', off, true);
  };
  const timer = setTimeout(off, ms);
  window.addEventListener('click', onClick, true);
  window.addEventListener('pointerdown', off, true);
  window.addEventListener('pointercancel', off, true);
  window.addEventListener('keydown', off, true);
  return off;
}
