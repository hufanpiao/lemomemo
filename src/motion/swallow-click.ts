// 吞点按：手势做完、换页刚开始时浏览器补来的点按不能当成点按。
// 整个 app 只有这里的两种原语，别处不再自己写“吞”的监听和标记：
// • swallowNextClick：吞掉下一下 click（手势做完以后补来的那一下）。
//   用的地方：换页守卫（page-swap.ts guardTaps 吞掉按下后晚到的那一下）、横向拖动（hdrag.ts：月历翻页、kit 左滑行滑完松手、点行面收起）、
//   上下拖动收起（drag-collapse.ts 拖完松手）、长按出菜单（long-press.ts 菜单出来以后松手）、长按拖动排序松手（long-press-drag.ts）、
//   提醒横幅上滑收起（features/reminders RemindHost）、按住“＋”（plus 的 hold-input 进了录音以后松手）
// • guardWindow：一段时间以内（或一直到放开）落在指定范围里的几种事件都吞。
//   用的地方：换页后 FADE_GUARD_MS（page-swap.ts guardTaps）、整页推页等新页那段（page-swap.ts holdScreen）、
//   勾选圈抬手切换以后 CHECK_CLICK_SWALLOW_MS（kit CheckCircle：吞法自己定，eat 传进来）
// 认键盘只有一种认法：键盘的 click（焦点在按钮上按回车、空格）前面一定有 keydown，所以看有没有 keydown。
//   不按 e.detail === 0 认键盘：页面里派发的 MouseEvent（e2e 模拟手指，例如 b2-vt-taps.spec.ts）detail 也是 0，会被当成键盘放过去
// 各处的毫秒数都在 tokens.ts（TAP_SWALLOW_MS、FADE_GUARD_MS、CHECK_CLICK_SWALLOW_MS），每个数为什么不同写在那里
// 纯 TS，不引 React
import { TAP_SWALLOW_MS } from './tokens.ts';

export interface SwallowClickOptions {
  /** 只吞落在这个节点里的 click；不给（null）就是落在哪儿都吞 */
  within?: Node | null;
  /** 时限（毫秒）：到了就摘掉监听；默认 TAP_SWALLOW_MS */
  ms?: number;
}

/**
 * 吞掉下一次点按；返回作废函数（重复调用没事）。
 * • 在 window 的捕获阶段拦：比 React 挂在根节点上的 click、document 上的捕获监听都先到，吞掉就到不了下面的 onClick
 * • 只吞落在 within 里的第一下；落在别处的照常、也不作废（按住“＋”松手后马上点提示条上的按钮）
 * • 新的一次按下（pointerdown）、按了键盘（keydown），或这次触摸被浏览器收走（pointercancel，变成了滚动）就作废：上一下的 click 不会再来了，
 *   不能把这一次正常点按的 click 当成晚到的那一下吞掉。在按下的监听里挂上的，不会被这一次按下自己作废
 *   （window 的捕获监听在派发这一次按下时已经轮过了）
 * • 时限 ms 只管“一直等不到 click 时监听挂多久”，到点由 setTimeout 摘掉
 */
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

export type GuardEvent = 'pointerdown' | 'pointerup' | 'click';

export interface GuardWindowOptions {
  /** 吞多久（毫秒，从调用时算）；null 是一直吞到调返回的函数 */
  ms: number | null;
  /** 吞哪几种事件 */
  types: readonly GuardEvent[];
  /** 监听挂在哪（捕获阶段）；默认 document */
  on?: EventTarget;
  /** 只吞落在哪里的：给节点就看 contains；给函数就从事件找（找不到返回 null 就不吞）；不给是落在哪儿都吞 */
  within?: Node | ((e: Event) => Node | null) | null;
  /**
   * 'keydown'：窗口里按过键盘，紧跟着的那一下 click 放过（键盘的 click 前面一定有 keydown；新的一次按下把这个标记作废，
   * types 里没有 pointerdown 时也另听 pointerdown，只用来作废标记、不吞）。
   * 不给：键盘的 click 也照样吞（勾选圈：抬手切换以后 800 ms 内来的 click 都是系统补发的，不分键盘）
   */
  keyboard?: 'keydown';
  /** 吞的那一下怎么处理（hit 是 within 找到的节点，within 不给时是 null）；默认 preventDefault + stopPropagation */
  eat?: (e: Event, hit: Node | null) => void;
}

const stopIt = (e: Event): void => {
  e.preventDefault();
  e.stopPropagation();
};

/**
 * 一段时间以内吞点按；返回放开的函数（重复调用没事）。
 * 到时由 setTimeout 摘掉监听；计时器被拖晚了，过了时限才来的事件也不吞（当场摘掉）
 */
export function guardWindow({ ms, types, on = document, within = null, keyboard, eat = stopIt }: GuardWindowOptions): () => void {
  const t0 = performance.now();
  let keyed = false;
  let dead = false;
  // 范围统一成一个函数：落在范围里返回交给 eat 的节点（不限范围时是 null），不在范围里返回 undefined（不吞）
  const hitOf = (e: Event): Node | null | undefined =>
    typeof within === 'function' ? (within(e) ?? undefined) : within === null || (e.target instanceof Node && within.contains(e.target)) ? within : undefined;
  // 认键盘时 pointerdown 一律要听（作废 keyed 标记）；不在 types 里的只作废、不吞
  const listen: readonly GuardEvent[] = keyboard && !types.includes('pointerdown') ? [...types, 'pointerdown'] : types;
  const onEvent = (e: Event): void => {
    if (ms !== null && performance.now() - t0 >= ms) return void stop();
    if (keyboard && e.type === 'pointerdown') keyed = false;
    if (!types.includes(e.type as GuardEvent)) return;
    if (keyboard && e.type === 'click' && keyed) {
      keyed = false;
      return;
    }
    const hit = hitOf(e);
    if (hit !== undefined) eat(e, hit);
  };
  const onKey = (): void => {
    keyed = true;
  };
  const timer = ms === null ? undefined : setTimeout(() => stop(), ms);
  const stop = (): void => {
    if (dead) return;
    dead = true;
    clearTimeout(timer);
    for (const t of listen) on.removeEventListener(t, onEvent, true);
    if (keyboard) on.removeEventListener('keydown', onKey, true);
  };
  for (const t of listen) on.addEventListener(t, onEvent, true);
  if (keyboard) on.addEventListener('keydown', onKey, true);
  return stop;
}
