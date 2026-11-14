// 吞掉下一次点按（审查“吞点按五套”合成这一套）：手势做完以后浏览器还会补一下 click，这一下不能当成点按。
// 用的地方：换页守卫（index.ts guardTaps 吞掉按下后晚到的那一下）、翻页（swipe-pager.ts 滑过之后）、
// kit 左滑行（SwipeRow 滑完松手、点行面收起）、按住“＋”（plus 的 hold-input 进了录音以后松手）
// • 在 window 的捕获阶段拦：比 React 挂在根节点上的 click、document 上的捕获监听都先到，吞掉就到不了下面的 onClick
// • 只吞 ms 以内、落在 within 里的第一下（within 不给就是落在哪儿都吞）；落在别处的照常、也不作废（按住“＋”松手后马上点提示条上的按钮）
// • 新的一次按下（pointerdown）或这次触摸被浏览器收走（pointercancel，变成了滚动）就作废：上一下的 click 不会再来了，
//   不能把这一次正常点按的 click 当成晚到的那一下吞掉（代码审查 S12）。在按下的监听里挂上的，不会被这一次按下自己作废
//   （window 的捕获监听在派发这一次按下时已经轮过了）
// • 时限常量在 tokens.ts 的 TAP_SWALLOW_MS；now 只给测试注入假钟
// 纯 TS，不引 React

export interface SwallowClickOptions {
  /** 只吞落在这个节点里的 click；不给（null）就是落在哪儿都吞 */
  within?: Node | null;
  /** 时限（毫秒）：过了就不吞、摘掉监听 */
  ms: number;
  /** 钟（测试注入）；默认 performance.now */
  now?: () => number;
}

/** 吞掉下一次点按；返回作废函数（重复调用没事） */
export function swallowNextClick({ within = null, ms, now = () => performance.now() }: SwallowClickOptions): () => void {
  const until = now() + ms;
  const onClick = (e: Event): void => {
    if (now() >= until) {
      off();
      return;
    }
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
  };
  const timer = setTimeout(off, ms);
  window.addEventListener('click', onClick, true);
  window.addEventListener('pointerdown', off, true);
  window.addEventListener('pointercancel', off, true);
  return off;
}
