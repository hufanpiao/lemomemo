// 门面换成动画实现的守卫（R-354 做法 A，方案第 2 节“到了以后什么时候换”）：
// 已经静态挂着的列表（今天页冷启动）要换成 motion 实现，换法是整个列表子树重挂一次（DOM 一样，画面上看不出来），
// 但重挂会丢掉焦点和行内的临时状态，所以三件事都满足才换，不满足就隔 SWAP_RETRY_MS 再看：
//   1. 焦点不在这个列表里；2. 没有按住不放的指针；3. 不在 useHoldView 停一拍的期间
// 只依赖 react，进首屏（很小）
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { motionImpl, subscribeMotionImpl, type MotionImpl } from './features.ts';

/** 守卫不满足时隔多久再看（ms） */
export const SWAP_RETRY_MS = 120;
/** whenSafe 传了 keep 时，等满这么久以后焦点那一条放宽（只在 keep 说要留住时才接着等），免得焦点一直在页里就永远换不上 */
export const SWAP_PATIENCE_MS = 3000;

const down = new Set<number>();
let watching = false;
let holds = 0;
/** useSwapWhenSafe 下载到的模块（按 load 函数记） */
const loaded = new Map<() => Promise<unknown>, { m: unknown }>();

/** 开始记按住的指针（第一个静态列表挂上时调；装一次，不拆：很便宜） */
export function watchPointers(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  const up = (e: PointerEvent) => down.delete(e.pointerId);
  document.addEventListener('pointerdown', (e) => down.add(e.pointerId), true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  // 切走窗口时可能收不到 pointerup：清空，免得一直推迟
  window.addEventListener('blur', () => down.clear());
}

/** useHoldView 停一拍开始、结束时调 */
export function holdBegin(): () => void {
  holds += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds -= 1;
  };
}

/** 现在能不能把这个列表换成动画实现；keep 传了时，焦点在列表里也能换，除非 keep 说这个焦点要留住 */
export function canSwap(list: Element | null, keep?: (focused: Element) => boolean): boolean {
  if (down.size > 0 || holds > 0) return false;
  const a = typeof document === 'undefined' ? null : document.activeElement;
  if (!(list && a && list.contains(a))) return true;
  return keep !== undefined && !keep(a);
}

/**
 * 能换的时候调 fn：马上看一次，不满足隔 SWAP_RETRY_MS 再看；返回取消。门面换实现（Appear、AppearList）和整页换排法（useSwapWhenSafe）共用。
 * keep：等满 SWAP_PATIENCE_MS 以后焦点那一条放宽成“keep 说要留住的才等”（整页换排法传“能打字的元素”）；不传就一直等焦点移出
 */
export function whenSafe(el: () => Element | null, fn: () => void, keep?: (focused: Element) => boolean): () => void {
  const t0 = Date.now();
  let t: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const attempt = (): void => {
    if (done) return;
    if (canSwap(el(), keep && Date.now() - t0 >= SWAP_PATIENCE_MS ? keep : undefined)) {
      done = true;
      fn();
    } else t = setTimeout(attempt, SWAP_RETRY_MS);
  };
  attempt();
  return () => {
    done = true;
    clearTimeout(t);
  };
}

/** 动画实现（没到时 null）；到了会重画一次 */
export function useMotionImpl(): MotionImpl | null {
  return useSyncExternalStore(subscribeMotionImpl, motionImpl, motionImpl);
}

/**
 * 同一个守卫给整页换排法用（B6 电脑版面板，今天页、随手记页）：want 为真、later 说可以了（今天页传 afterAppPainted，面板分包不算进首屏）、
 * load 下载好了、而且 page 里没有焦点、没有按住的指针、不在停一拍期间（canSwap），才交出下载到的模块；不满足就隔 SWAP_RETRY_MS 再看。
 * 交出模块（不是 lazy 组件）：页面直接用里面的组件画，不会先挂起一拍、闪一次原来的排法再重挂一次。
 * 下载失败就一直是 null（照原来的排法画）。交出以后 want 变假立刻是 null（排法跟着窗口宽窄走），再变真直接交出（模块已在）。
 * 下载到的模块按 load 记住：以后再挂上（切页回来）第一次渲染就直接交出，不用先画一帧原来的排法再换（那时页面是新挂的，没有焦点可丢）。
 * keep：见 whenSafe（焦点一直在页里时，等满 SWAP_PATIENCE_MS 以后只为 keep 说要留住的焦点接着等）
 */
export function useSwapWhenSafe<M>(want: boolean, page: RefObject<Element | null>, load: () => Promise<M>, later: (fn: () => void) => void, keep?: (focused: Element) => boolean): M | null {
  const [mod, setMod] = useState(() => (loaded.get(load) as { m: M } | undefined) ?? null);
  useEffect(() => {
    if (!want || mod !== null) return;
    watchPointers();
    let live = true;
    let cancel = (): void => undefined;
    later(() => {
      if (!live) return;
      load().then((m) => {
        loaded.set(load, { m });
        if (live) cancel = whenSafe(() => page.current, () => setMod({ m }), keep);
      }, () => undefined);
    });
    return () => {
      live = false;
      cancel();
    };
  }, [want, mod, page, load, later, keep]);
  return want && mod !== null ? mod.m : null;
}

/** 只给测试用 */
export function resetSwapGuardForTest(): void {
  loaded.clear();
  down.clear();
  holds = 0;
}
