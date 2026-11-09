// 记下来的这一批（B3 任务单 FA-2；架构 5.1 提示条、R-166）
// • 同一句话的几条共用一个 batch_id；确认行选完的那一条加进同一批（R-166），“全部撤销”照样一起撤
// • “已记下 N 条”展开后：每条能修改（交给调用方开编辑页）或撤销；“拆错了，合并成一条”；“全部撤销”
// • 合并：先整批撤销，再把整句原话存成新的一条（新的一批）
// • 写不进去时返回 false，调用方提示“没保存上”
import { useCallback, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { saveCapture, undoRefs, type SavedRef, type Writer } from '../data/capture-save.ts';
import { mergeItems, type TypePlan } from '../data/type-flow.ts';

export interface BatchEntry {
  ref: SavedRef;
  item: AiItem;
}

export interface Batch {
  batchId: string | null;
  entries: BatchEntry[];
  plan: TypePlan;
  raw: string;
  remind: boolean;
}

export interface SaveEnv {
  now: number;
  tz: Tz;
  day: DateStr | null;
}

export type SaveOutcome = 'ok' | 'nothing' | 'not_saved' | 'switching';

export function useSavedBatch(writer: Writer | undefined) {
  const [batch, setBatch] = useState<Batch | null>(null);

  /** 存几条：base 为 null 时开新的一批，否则加进 base 那一批；返回新的 batch（没存成为 null） */
  const store = useCallback(
    async (base: Batch, items: AiItem[], env: SaveEnv): Promise<{ batch: Batch | null; out: SaveOutcome }> => {
      if (items.length === 0) return { batch: base, out: 'ok' };
      const res = await saveCapture(
        {
          items, rawText: base.raw, source: 'page', origin: base.plan.origin, now: env.now, tz: env.tz,
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

  const undoOne = useCallback(
    async (id: string, now: number) => {
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
    async (now: number): Promise<boolean> => {
      if (!batch) return true;
      const left = await undoRefs(batch.entries.map((e) => e.ref), now, writer);
      setBatch(null);
      return left.length === 0;
    },
    [batch, writer],
  );

  /** 拆错了，合并成一条 */
  const merge = useCallback(
    async (env: SaveEnv): Promise<SaveOutcome> => {
      if (!batch) return 'nothing';
      const one = mergeItems(batch.entries.map((e) => e.item), batch.raw);
      if (!one) return 'nothing';
      await undoRefs(batch.entries.map((e) => e.ref), env.now, writer);
      const r = await store({ ...batch, batchId: null, entries: [], remind: false }, [one], env);
      // 合并那一条没写进去：原来的几条已经撤了，提示“没保存上”，原话由调用方填回输入条
      setBatch(r.out === 'ok' ? r.batch : null);
      return r.out;
    },
    [batch, writer, store],
  );

  return { batch, setBatch, store, undoOne, undoAll, merge };
}
