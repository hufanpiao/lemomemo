// 带提醒、还没同步上的记录（架构 4.2；TC-B2-69）：读 core 的 outbox 状态 remindRecs（`${table}:${id}`）；没启动、没有 outbox 时为空
// useRetryUnsynced（UNSYNCED-retry-ui，负责人 11-05 定方案 C）：其中能重试的记录（outbox 状态 retryRecs，同步算好的）和一次全部重试
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

export function useUnsyncedRemind(outbox: OutboxLike | null = getBoot()?.outbox ?? null): ReadonlySet<string> {
  return useSyncExternalStore(
    outbox ? outbox.subscribe : noop,
    () => outbox?.getStatus().remindRecs ?? EMPTY,
    () => EMPTY,
  );
}

/**
 * recs：能重试的记录（retryRecs），和 remindRecs 同一次状态更新换新，提示文字和按钮同一次渲染（审查 M1）。
 * retry 期间 busy，重复点不重复发；出错（库已关以外）不吞：挪到下一个微任务重新抛出，走全局 js_error（审查 L1）
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
