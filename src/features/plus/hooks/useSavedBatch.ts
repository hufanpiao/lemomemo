// 记下来的这一批（B3 任务单 FA-2；架构 5.1 提示条、R-166）
// • 同一句话的几条共用一个 batch_id；确认行选完的那一条加进同一批（R-166），“全部撤销”照样一起撤
// • “已记下 N 条”展开后：每条能修改（交给调用方开编辑页）或撤销；“拆错了，合并成一条”；“全部撤销”
// • 合并：先把整句原话存成新的一条（新的一批），存成了再撤原来的几条；没存上就原样留着，提示条加一句“合并没保存上”
// • 全部撤销：没撤成的几条留在提示条上，加一句“N 条没撤销成功”（FA-3 整块评审第 13 条）
// • 新的一句、确认行写不进去时返回没存上的原因，调用方提示“没保存上”
// • 打字条（useTypeBar）和按住录音（useVoice）共用这一套：新的一句怎么存（storeNew）、确认行选了怎么加（choose）、
//   提示条显示什么（notice，含“今天的次数用完了”那一句该不该出）、撤销 / 合并；两边只管自己的状态机和输入
import { useCallback, useMemo, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { quotaResetClock } from '../../../../shared/logic/ai-quota.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { saveCapture, undoRefs, type StoredRef, type Writer } from '../data/capture-save.ts';
import { noticeLines, type NoticeLine } from '../data/notice.ts';
import { markQuotaNotice, quotaNoticeDue } from '../data/quota.ts';
import { applyConfirm, mergeItems, splitConfirm, type TypePlan } from '../data/type-flow.ts';

export interface BatchEntry {
  /** 显示标题用 ref.title（库里存的，可能比 item.title 短），不用 item.title */
  ref: StoredRef;
  item: AiItem;
}

export interface Batch {
  batchId: string | null;
  entries: BatchEntry[];
  plan: TypePlan;
  raw: string;
  remind: boolean;
  /** 从哪来：打字 page（不给就是它）、录音 voice（B3 FA-3）；写进行的 source 列 */
  source?: 'page' | 'voice';
  /** 上一次合并没存上 / 全部撤销有几条没撤成（提示条加一句） */
  mergeFailed?: boolean;
  undoFailed?: number;
}

export interface SaveEnv {
  now: number;
  tz: Tz;
  day: DateStr | null;
}

export type SaveOutcome = 'ok' | 'nothing' | 'not_saved' | 'switching';

/** 提示条：主句和附加句，加上这一批每一条（多条时展开逐条改、撤） */
export interface BatchNotice {
  lines: NoticeLine[];
  entries: BatchEntry[];
}

/** writer 测试用；confirming：调用方正在出确认行（这时不出提示条、才能 choose）；tag：运行日志的前缀 */
export function useSavedBatch(writer: Writer | undefined, confirming: boolean, tag: string) {
  const [batch, setBatch] = useState<Batch | null>(null);
  /** 确认行还要问的几条（过去的月日，R-166） */
  const [ask, setAsk] = useState<AiItem[]>([]);
  const [quotaDue, setQuotaDue] = useState(false);

  /** 存几条：base 为 null 时开新的一批，否则加进 base 那一批；返回新的 batch（没存成为 null） */
  const store = useCallback(
    async (base: Batch, items: AiItem[], env: SaveEnv): Promise<{ batch: Batch | null; out: SaveOutcome }> => {
      if (items.length === 0) return { batch: base, out: 'ok' };
      const res = await saveCapture(
        {
          items, rawText: base.raw, source: base.source ?? 'page', origin: base.plan.origin, now: env.now, tz: env.tz,
          ...(env.day ? { day: env.day } : {}), ...(base.batchId ? { batchId: base.batchId } : {}),
        },
        writer,
      );
      // 没写进去：已经存了的那几条不动（照样能撤），只报这一次没保存上
      if (!res.ok) return { batch: base.entries.length > 0 ? base : null, out: res.reason === 'local_unavailable' || res.reason === 'closing' ? 'not_saved' : res.reason };
      const entries: BatchEntry[] = [];
      for (const [k, ref] of res.saved.entries()) {
        const item = items[res.at[k] ?? -1];
        if (item) entries.push({ ref, item });
      }
      return { batch: { ...base, batchId: res.batchId, entries: [...base.entries, ...entries], remind: base.remind || res.remind }, out: 'ok' };
    },
    [writer],
  );

  /** 新的一句（base.plan.items 是整句拆出来的几条）：不用问的先存；有过去的月日的留着问（返回 ask，调用方出确认行） */
  const storeNew = useCallback(
    async (base: Batch, env: SaveEnv): Promise<SaveOutcome | 'ask'> => {
      const { ready, ask: later } = splitConfirm(base.plan.items);
      const r = await store(base, ready, env);
      rlog(`${tag} stored out=${r.out} ready=${ready.length} ask=${later.length} origin=${base.plan.origin}`);
      if (r.out !== 'ok' || !r.batch) return r.out === 'ok' ? 'not_saved' : r.out;
      setBatch(r.batch);
      if (later.length === 0) return 'ok';
      setAsk(later);
      return 'ask';
    },
    [store, tag],
  );

  /** 确认行选了：加进同一批。more 还有要问的；done 问完了（调用方收尾，plan 是这一批的）；skip 不在确认中 */
  const choose = useCallback(
    async (c: 'past' | 'next', env: SaveEnv): Promise<SaveOutcome | 'more' | 'done' | 'skip'> => {
      const first = ask[0];
      if (!batch || !first || !confirming) return 'skip';
      const r = await store(batch, [applyConfirm(first, c)], env);
      if (r.out !== 'ok' || !r.batch) return r.out === 'ok' ? 'not_saved' : r.out;
      setBatch(r.batch);
      const rest = ask.slice(1);
      setAsk(rest);
      return rest.length > 0 ? 'more' : 'done';
    },
    [ask, batch, confirming, store],
  );

  /** 这一批都存好了：该提醒“今天的次数用完了”时记一笔（一天只提醒一次） */
  const settle = useCallback((p: TypePlan): void => {
    const now = clock.now();
    const due = quotaNoticeDue(now);
    if (p.status === 'quota_out' && due) markQuotaNotice(now);
    setQuotaDue(due);
  }, []);

  const notice = useMemo((): BatchNotice | null => {
    if (!batch || batch.entries.length === 0 || confirming) return null;
    const lines = noticeLines({
      status: batch.plan.status, titles: batch.entries.map((e) => e.ref.title), hints: batch.plan.hints, remind: batch.remind,
      quotaNoticeDue: quotaDue, resetClock: quotaResetClock(clock.now(), currentTz()), mergeFailed: batch.mergeFailed === true, undoFailed: batch.undoFailed ?? 0,
    });
    return { lines, entries: batch.entries };
  }, [batch, confirming, quotaDue]);

  const undoOne = useCallback(
    async (id: string) => {
      const now = clock.now();
      if (!batch) return;
      const hit = batch.entries.find((e) => e.ref.id === id);
      if (!hit) return;
      const left = await undoRefs([hit.ref], now, writer);
      if (left.length > 0) return;
      const entries = batch.entries.filter((e) => e.ref.id !== id);
      setBatch(entries.length > 0 ? { ...batch, entries } : null);
    },
    [batch, writer],
  );

  const undoAll = useCallback(
    async (): Promise<boolean> => {
      if (!batch) return true;
      const left = await undoRefs(batch.entries.map((e) => e.ref), clock.now(), writer);
      rlog(`${tag} undo_all n=${batch.entries.length} left=${left.length}`);
      // 撤成的拿掉；没撤成的留在提示条上（能再点一次）
      setBatch(left.length === 0 ? null : { ...batch, entries: batch.entries.filter((e) => left.includes(e.ref)), mergeFailed: false, undoFailed: left.length });
      return left.length === 0;
    },
    [batch, writer, tag],
  );

  /** 拆错了，合并成一条 */
  const merge = useCallback(
    async (env: SaveEnv): Promise<SaveOutcome> => {
      if (!batch) return 'nothing';
      const one = mergeItems(batch.entries.map((e) => e.item), batch.raw);
      if (!one) return 'nothing';
      const r = await store({ ...batch, batchId: null, entries: [], remind: false, mergeFailed: false, undoFailed: 0 }, [one], env);
      rlog(`${tag} merge out=${r.out} n=${batch.entries.length}`);
      // 合并那一条没写进去：原来的几条不动，提示条加一句
      if (r.out !== 'ok' || !r.batch) {
        setBatch({ ...batch, mergeFailed: true });
        return r.out === 'ok' ? 'not_saved' : r.out;
      }
      // 新的存成了再撤原来的；有撤不掉的（纪念日、写不进去）照样留在库里，不挡合并
      const left = await undoRefs(batch.entries.map((e) => e.ref), env.now, writer);
      if (left.length > 0) rlog(`${tag} merge undo_left=${left.length}`);
      setBatch(r.batch);
      return 'ok';
    },
    [batch, writer, store, tag],
  );

  return { batch, setBatch, ask, setAsk, asking: confirming ? (ask[0] ?? null) : null, notice, store, storeNew, choose, settle, undoOne, undoAll, merge };
}
