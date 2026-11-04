// 带提醒、还没同步上的记录（架构 4.2；TC-B2-69）：读 core 的 outbox 状态 remindRecs（`${table}:${id}`）；没启动、没有 outbox 时为空
import { useSyncExternalStore } from 'react';
import { getBoot } from '../../../core/boot.ts';
import type { OutboxStatus } from '../../../core/outbox-types.ts';

const EMPTY: ReadonlySet<string> = new Set();
const noop = (): (() => void) => () => undefined;

export interface OutboxLike {
  subscribe(fn: () => void): () => void;
  getStatus(): Pick<OutboxStatus, 'remindRecs'>;
}

export function useUnsyncedRemind(outbox: OutboxLike | null = getBoot()?.outbox ?? null): ReadonlySet<string> {
  return useSyncExternalStore(
    outbox ? outbox.subscribe : noop,
    () => outbox?.getStatus().remindRecs ?? EMPTY,
    () => EMPTY,
  );
}
