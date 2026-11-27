// 带提醒、还没同步上的记录：读 core 的 outbox 状态 remindRecs（`${table}:${id}`）；没启动、没有 outbox 时为空
// useRetryUnsynced：其中能重试的记录（outbox 状态 retryRecs，同步算好的）和一次全部重试
// • 宽限（否则每勾一条带提醒的待办，“未同步，提醒可能不响”横条都闪出又收回，下面整页跳一下）：
//   页面开着的时候新进 remindRecs 的记录，连着 UNSYNCED_GRACE_MS 还没同步上才算“未同步”（正常同步不到一秒，就不出横条和行尾标记）；
//   发送失败能重试的（retryRecs）马上算；页面挂上时已经在里面的（离线时记的、上次没同步上的）也马上算。几处共用同一个 outbox 的同一份结果
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { getBoot } from '../../../core/boot.ts';
import type { Outbox, OutboxStatus } from '../../../core/outbox-types.ts';
import { retryUnsynced } from '../data/retry-unsynced.ts';

const EMPTY: ReadonlySet<string> = new Set();
const noop = (): (() => void) => () => undefined;

export interface OutboxLike {
  subscribe(fn: () => void): () => void;
  getStatus(): Pick<OutboxStatus, 'remindRecs' | 'retryRecs'>;
}

export type RetryOutboxLike = OutboxLike & Pick<Outbox, 'list' | 'retryFailed'>;

/** 新出现的未同步记录等多久还没同步上才显示（ms） */
export const UNSYNCED_GRACE_MS = 3000;

interface Graced {
  subscribe(fn: () => void): () => void;
  get(): ReadonlySet<string>;
}

const gracedOf = new WeakMap<OutboxLike, Graced>();

/** outbox 的 remindRecs 加上宽限：订阅者从 0 变 1 时已经在里面的记成“老的”马上显示，之后新进来的等满宽限（能重试的除外） */
function graced(outbox: OutboxLike): Graced {
  const hit = gracedOf.get(outbox);
  if (hit) return hit;
  const seen = new Map<string, number>();
  const fns = new Set<() => void>();
  let shown: ReadonlySet<string> = EMPTY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off: (() => void) | null = null;
  /** 按现在的 outbox 状态重算 shown；变了返回 true。arm：要不要为还在宽限里的记录定时再算 */
  const compute = (arm: boolean): boolean => {
    const { remindRecs, retryRecs } = outbox.getStatus();
    const t = performance.now();
    for (const k of [...seen.keys()]) if (!remindRecs.has(k)) seen.delete(k);
    const next: string[] = [];
    let wait = Infinity;
    for (const k of remindRecs) {
      // 没在看的时候（还没有订阅者）进来的都算老的
      if (!seen.has(k)) seen.set(k, fns.size === 0 ? -Infinity : t);
      const age = t - (seen.get(k) ?? t);
      if (retryRecs.has(k) || age >= UNSYNCED_GRACE_MS) next.push(k);
      else wait = Math.min(wait, UNSYNCED_GRACE_MS - age);
    }
    clearTimeout(timer);
    if (arm && wait !== Infinity) timer = setTimeout(update, wait);
    const changed = next.length !== shown.size || next.some((k) => !shown.has(k));
    if (changed) shown = next.length === 0 ? EMPTY : new Set(next);
    return changed;
  };
  const update = (): void => {
    if (compute(true)) for (const fn of [...fns]) fn();
  };
  const g: Graced = {
    subscribe(fn) {
      if (fns.size === 0) {
        compute(false);
        fns.add(fn);
        off = outbox.subscribe(update);
        update();
      } else fns.add(fn);
      return () => {
        fns.delete(fn);
        if (fns.size > 0) return;
        off?.();
        off = null;
        clearTimeout(timer);
        seen.clear();
      };
    },
    get() {
      if (fns.size === 0) compute(false);
      return shown;
    },
  };
  gracedOf.set(outbox, g);
  return g;
}

export function useUnsyncedRemind(outbox: OutboxLike | null = getBoot()?.outbox ?? null): ReadonlySet<string> {
  const g = outbox ? graced(outbox) : null;
  return useSyncExternalStore(g ? g.subscribe : noop, () => g?.get() ?? EMPTY, () => EMPTY);
}

/**
 * recs：能重试的记录（retryRecs），和 remindRecs 同一次状态更新换新，提示文字和按钮同一次渲染。
 * retry 期间 busy，重复点不重复发；出错（库已关以外）不吞：挪到下一个微任务重新抛出，走全局 js_error
 */
export function useRetryUnsynced(outbox: RetryOutboxLike | null = getBoot()?.outbox ?? null): {
  readonly recs: ReadonlySet<string>;
  readonly busy: boolean;
  readonly retry: () => void;
} {
  const recs = useSyncExternalStore(
    outbox ? outbox.subscribe : noop,
    () => outbox?.getStatus().retryRecs ?? EMPTY,
    () => EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // 卸载后才完成：setBusy 在 React 18 起不报警告、也不做事，不另加守卫
  const retry = useCallback(() => {
    if (!outbox || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const rethrow = (e: unknown): void => queueMicrotask(() => {
      throw e;
    });
    retryUnsynced(outbox, recs)
      .catch(rethrow)
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, [outbox, recs]);
  return { recs, busy, retry };
}
