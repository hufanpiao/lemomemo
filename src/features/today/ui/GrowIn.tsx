// 晚到的一块不把页面一下子往下推（设计复审 提醒接线今天页待办 第二轮 J1；用在今天页顶部“错过 N 条提醒”那一行）：
// • 第一次画出来之前就有内容：直接画（首屏就有，不动）
// • 画出来以后才有、或者内容没了：外层高度从现在的值过渡到新高度（--dur-ui、--ease-out）；减少动态效果时直接到位
// • 手指正按在屏幕上，或者刚抬起不到约 600 ms：先不动，等手离开、静下来再变（手指正要落下的那一行不会突然挪开）；
//   窗口失焦（blur）、切到后台或切回来（visibilitychange）时“按着”的计数清零，抬起丢了也不会一直卡住
// • 页面已经往下滚过（scrollY > 0）：直接到位，同时把滚动位置补上同样的高度，眼前的内容不动。补多少按变完后实际挪了多少量：
//   Chromium 的滚动锚定自己会补（量出来是 0，不重复补；J1 验收第一次跑出来补了两次），Safari 等没有滚动锚定的由这里补
// • 高度还没到位（在等、在变）时裁掉溢出（overflow: hidden），不盖到下面；到位以后放开（data-settled），里面按钮的焦点框不被裁
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { prefersReducedMotion } from '../../../motion/index.ts';
import styles from './TodayPage.module.css';

/** 抬手以后静下来多久才动 */
export const GROW_QUIET_MS = 600;

// 指针按着没有、最后一次抬起是什么时候：整页一份，第一次用到时挂监听
const pointer = { down: 0, lastUp: Number.NEGATIVE_INFINITY, listening: false };
function listenPointer(): void {
  if (pointer.listening || typeof window === 'undefined') return;
  pointer.listening = true;
  window.addEventListener('pointerdown', () => (pointer.down += 1), { capture: true, passive: true });
  const up = (): void => {
    pointer.down = Math.max(0, pointer.down - 1);
    pointer.lastUp = performance.now();
  };
  window.addEventListener('pointerup', up, { capture: true, passive: true });
  window.addEventListener('pointercancel', up, { capture: true, passive: true });
  // 按着时切走窗口、切到后台：抬起可能收不到，计数会一直卡在“按着”、这一块永远不动；切走时清零
  const reset = (): void => void (pointer.down = 0);
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', reset);
}
/** 还要等多久才能动（0 = 现在就能动）；按着时每 100 ms 再看一次 */
function waitLeft(): number {
  if (pointer.down > 0) return 100;
  const left = GROW_QUIET_MS - (performance.now() - pointer.lastUp);
  return left > 0 ? Math.ceil(left) : 0;
}
/** 测试用：复位指针状态 */
export function resetGrowPointerForTest(): void {
  pointer.down = 0;
  pointer.lastUp = Number.NEGATIVE_INFINITY;
}

export function GrowIn({ children, testId }: { children: ReactNode; testId?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const painted = useRef(false);

  // useEffect 在第一次画到屏幕上以后才跑：这之前到的内容直接画（首屏就有）
  useEffect(() => {
    painted.current = true;
  }, []);

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    // 没有 ResizeObserver（很老的浏览器、jsdom）：不量、不过渡，高度跟着内容走
    if (typeof ResizeObserver === 'undefined') {
      o.style.height = 'auto';
      o.dataset['settled'] = '';
      return;
    }
    listenPointer();
    let shown = 0;
    let wait: ReturnType<typeof setTimeout> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const done = (): void => {
      if (settle !== null) clearTimeout(settle);
      settle = null;
      if (i.offsetHeight === shown) o.dataset['settled'] = '';
    };
    const apply = (): void => {
      wait = null;
      const h = i.offsetHeight;
      if (h === shown) return;
      delete o.dataset['settled'];
      if (painted.current) {
        const left = waitLeft();
        if (left > 0) {
          wait = setTimeout(apply, left);
          return;
        }
      }
      const scrolled = window.scrollY > 0;
      const animate = painted.current && !scrolled && !prefersReducedMotion();
      if (animate) {
        if (settle !== null) clearTimeout(settle);
        // transitionend 可能不来（标签页在后台、高度没变）：最多等两倍时长
        settle = setTimeout(done, 500);
      }
      o.dataset['anim'] = animate ? 'on' : 'off';
      // 补滚动：先记下这一块的下沿在屏幕上的位置，变完再量一次，挪了多少补多少。
      // 有滚动锚定的浏览器（Chromium）自己已经补上了，量出来是 0，不再重复补；没有的（比如 Safari）由这里补
      const keep = scrolled && painted.current;
      const before = keep ? o.getBoundingClientRect().bottom : 0;
      if (animate) o.style.height = `${h}px`;
      else {
        // 瞬间到位：临时关掉过渡，读一次布局让它生效，再恢复
        o.style.transition = 'none';
        o.style.height = `${h}px`;
        void o.offsetHeight;
        o.style.transition = '';
      }
      if (keep) {
        const moved = o.getBoundingClientRect().bottom - before;
        if (moved !== 0) window.scrollBy(0, moved);
      }
      shown = h;
      if (!animate) done();
    };
    const ro = new ResizeObserver(() => {
      if (wait === null) apply();
    });
    ro.observe(i);
    const ended = (e: TransitionEvent): void => {
      if (e.target === o) done();
    };
    o.addEventListener('transitionend', ended);
    apply();
    return () => {
      ro.disconnect();
      o.removeEventListener('transitionend', ended);
      if (wait !== null) clearTimeout(wait);
      if (settle !== null) clearTimeout(settle);
    };
  }, []);

  return (
    <div ref={outer} className={styles.grow} data-testid={testId}>
      <div ref={inner} className={styles.missed}>
        {children}
      </div>
    </div>
  );
}
