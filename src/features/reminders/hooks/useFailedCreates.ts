// 新建失败、码不能重试的记录（R-378）和它们的两个出路：给“未同步”提示条的 FailedCreateActions 用
// • 记录：outbox 里 failed 的 insert、canRetryUnsynced 为假的（能重试的走提示条原有的“重试”）；outbox 状态一变就重读。
//   settings 也算（R-378 复查必改）：重开页面后才被拒的，已经没有 core/ai-settings.ts 的监听来回滚，不出按钮就永远卡在“未同步”；
//   它按 (user_id,key) 唯一、另存照样冲突，所以只给“放弃”（FailedCreateActions；core 里 settings 的 copy 也按 drop 处理）
// • run('copy') 另存为新的一条、run('drop') 放弃：一次处理全部这样的记录（core/write-failed-create.ts）；
//   另存被拒（有别的记录依赖它，has_dependents）的留着，只能放弃；有没处理成的，failed 给出原因（'dependents' 或 'other'），下次点时清掉。期间 busy，重复点不重复做；出错（拒收以外）挪到下一个微任务重新抛出（同 useRetryUnsynced）
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getBoot } from '../../../core/boot.ts';
import { canRetryUnsynced, NO_COPY_TABLES } from '../../../core/outbox-logic.ts';
import type { Outbox } from '../../../core/outbox-types.ts';
import { resolveFailedCreate } from '../../../core/write-failed-create.ts';

export type FailedCreateOutbox = Pick<Outbox, 'subscribe' | 'getStatus' | 'list'>;
export type ResolveFailedCreate = typeof resolveFailedCreate;
type Rec = readonly [table: string, id: string];
export type FailedReason = 'dependents' | 'other';

const noop = (): (() => void) => () => undefined;

export function useFailedCreates(
  outbox: FailedCreateOutbox | null = getBoot()?.outbox ?? null,
  resolve: ResolveFailedCreate = resolveFailedCreate,
): {
  readonly recs: readonly Rec[];
  /** 有能“另存”的记录（不全是 NO_COPY_TABLES 里的表：settings、note_images） */
  readonly canCopy: boolean;
  readonly busy: boolean;
  readonly failed: FailedReason | null;
  readonly run: (mode: 'copy' | 'drop') => void;
} {
  // 状态里的两个集合换新就重读（getStatus 每次可能返回新对象，不能直接拿它当快照）
  const remind = useSyncExternalStore(outbox ? outbox.subscribe : noop, () => outbox?.getStatus().remindRecs ?? null, () => null);
  const retry = useSyncExternalStore(outbox ? outbox.subscribe : noop, () => outbox?.getStatus().retryRecs ?? null, () => null);
  const [recs, setRecs] = useState<readonly Rec[]>([]);
  useEffect(() => {
    if (!outbox) return;
    let live = true;
    Promise.resolve()
      .then(() => outbox.list())
      .then((items) => {
        if (!live) return;
        const seen = new Map<string, Rec>();
        for (const i of items) if (i.state === 'failed' && i.op === 'insert' && !canRetryUnsynced(i)) seen.set(i.rec, [i.table, i.id]);
        setRecs([...seen.values()]);
      })
      .catch(() => undefined);   // 库已关（换账号、清库中）、替身没有 list：不管
    return () => {
      live = false;
    };
  }, [outbox, remind, retry]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<FailedReason | null>(null);
  const busyRef = useRef(false);
  const run = useCallback(
    (mode: 'copy' | 'drop') => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setFailed(null);
      (async () => {
        let bad: FailedReason | null = null;
        for (const [table, id] of recs) {
          const r = await resolve(table, id, mode);
          if (!r.ok) bad = r.code === 'has_dependents' && bad !== 'other' ? 'dependents' : 'other';
        }
        setFailed(bad);
      })()
        .catch((e: unknown) => queueMicrotask(() => {
          throw e;
        }))
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    },
    [recs, resolve],
  );
  return { recs, canCopy: recs.some(([table]) => !NO_COPY_TABLES.has(table)), busy, failed, run };
}
