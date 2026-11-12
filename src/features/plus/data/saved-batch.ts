// 记下来的这一批（B3 任务单 FA-2；架构 5.1 提示条、R-166）。纯 TS 工厂（FA-3 第二轮复查第 2 条从 hooks/useSavedBatch.ts 挪来），界面只 useStore(box) 来画
// • 同一句话的几条共用一个 batch_id；确认行选完的那一条加进同一批（R-166），“全部撤销”照样一起撤
// • “已记下 N 条”展开后：每条能修改（交给调用方开编辑页）或撤销；“拆错了，合并成一条”；“全部撤销”
// • 合并：先把整句原话存成新的一条（新的一批），存成了再撤原来的几条；没存上就原样留着，提示条加一句“合并没保存上”
// • 全部撤销：没撤成的几条留在提示条上，加一句“N 条没撤销成功”（FA-3 整块评审第 13 条）
// • 纪念日在这里撤不掉（capture-save 的 undoRefs 一律留下）：不算没撤成，留在提示条上、单独一句“纪念日请到纪念日页删除”；
//   合并成功后撤不掉的旧条也照样留在新的提示条上（不悄悄在库里多出几条；FA-3 复查第 3、4 条）
// • 打字条和按住录音共用这一份（FA-3 第二轮第 5 条）：存（save）、存完往哪走（land）、确认行（choose）、撤销、合并、关掉；
//   两边只给自己的状态机、收尾和失败提示（flow）。录音那份由控制器持有（切页重挂提示条还在，第 11 条），打字条每次挂载一份
// 纯 TS：不准 import React（A1）
import { createStore } from 'zustand/vanilla';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { quotaResetClock } from '../../../../shared/logic/ai-quota.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { saveCapture, undoRefs, type SavedRef, type SaveOutcome, type StoredRef, type Writer } from './capture-save.ts';
import type { CaptureEvent } from './capture-state.ts';
import { noticeLines, type NoticeLine } from './notice.ts';
import { markQuotaNotice, quotaNoticeDue } from './quota.ts';
import { applyConfirm, mergeItems, splitConfirm, type TypePlan } from './type-flow.ts';

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
  /** 上一次合并没存上 / 撤销有几条没撤成 / 有纪念日撤不掉（提示条各加一句） */
  mergeFailed?: boolean;
  undoFailed?: number;
  annivKept?: boolean;
}

/** 撤完以后：撤成的拿掉，没撤成的留着；纪念日单算（不算失败） */
function afterUndo(entries: readonly BatchEntry[], left: readonly SavedRef[]): Pick<Batch, 'entries' | 'undoFailed' | 'annivKept'> {
  const anniv = left.filter((r) => r.table === 'anniversaries').length;
  return { entries: entries.filter((e) => left.includes(e.ref)), undoFailed: left.length - anniv, annivKept: anniv > 0 };
}

export interface SaveEnv {
  now: number;
  tz: Tz;
  day: DateStr | null;
}

/** 提示条：主句和附加句，加上这一批每一条（多条时展开逐条改、撤） */
export interface BatchNotice {
  lines: NoticeLine[];
  entries: BatchEntry[];
}

/** 这一批：记下的、确认行还要问的几条（过去的月日，R-166）、这次该不该提醒“今天的次数用完了” */
export interface BatchState {
  batch: Batch | null;
  ask: AiItem[];
  quotaDue: boolean;
}

/** 这一批放在哪（zustand 的 vanilla store；不是组件状态） */
export const createBatchBox = () => createStore<BatchState>(() => ({ batch: null, ask: [], quotaDue: false }));
export type BatchBox = ReturnType<typeof createBatchBox>;

/** 提示条（没有记下的就是 null；确认行出着时调用方不画它） */
export function noticeOf({ batch, quotaDue }: BatchState): BatchNotice | null {
  if (!batch || batch.entries.length === 0) return null;
  const lines = noticeLines({
    status: batch.plan.status, titles: batch.entries.map((e) => e.ref.title), hints: batch.plan.hints, remind: batch.remind,
    quotaNoticeDue: quotaDue, resetClock: quotaResetClock(clock.now(), currentTz()), mergeFailed: batch.mergeFailed === true, undoFailed: batch.undoFailed ?? 0, annivKept: batch.annivKept === true,
  });
  return { lines, entries: batch.entries };
}

/** 两边各自的那一点：go 自己的状态机；done 这一批都存好了（额度提示已记过）；fail 新的一句没存上；error 确认行选了没存上（状态不动，还能再选） */
export interface BatchFlow {
  go(e: CaptureEvent): void;
  done(p: TypePlan): void;
  fail(out: Exclude<SaveOutcome, 'ok'>): void;
  error(out: 'not_saved' | 'switching'): void;
}

export interface SavedBatchOpts {
  box: BatchBox;
  /** 测试用：写入口 */
  writer?: Writer | undefined;
  /** 运行日志的前缀 */
  tag: string;
  source?: 'page' | 'voice';
  env(): SaveEnv;
  flow: BatchFlow;
}

export type SavedBatch = ReturnType<typeof createSavedBatch>;

export function createSavedBatch({ box, writer, tag, source, env, flow }: SavedBatchOpts) {
  const get = box.getState;
  const put = (s: Partial<BatchState>): void => box.setState(s);
  /** 确认行选了还在存：再点不算（连点会存两条，第二轮复查续第 2 条） */
  let choosing = false;

  /** 存几条：加进 base 那一批（base.batchId 为 null 时开新的一批）；返回新的 batch（没存成为 null） */
  const store = async (base: Batch, items: AiItem[], e: SaveEnv): Promise<{ batch: Batch | null; out: SaveOutcome }> => {
    if (items.length === 0) return { batch: base, out: 'ok' };
    const res = await saveCapture(
      {
        items, rawText: base.raw, source: base.source ?? 'page', origin: base.plan.origin, now: e.now, tz: e.tz,
        ...(e.day ? { day: e.day } : {}), ...(base.batchId ? { batchId: base.batchId } : {}),
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
  };

  /** 存完往哪走：问 → 确认行；好 → 该提醒“今天的次数用完了”时记一笔（一天只提醒一次），调用方收尾；别的交给调用方的失败提示 */
  const land = (out: SaveOutcome | 'ask', plan: TypePlan): void => {
    if (out === 'ask') return flow.go({ type: 'need_confirm' });
    if (out !== 'ok') return flow.fail(out);
    const now = clock.now();
    const due = quotaNoticeDue(now);
    if (plan.status === 'quota_out' && due) markQuotaNotice(now);
    put({ quotaDue: due });
    flow.done(plan);
  };

  return {
    box,
    land,
    /** 新的一句（plan.items 是整句拆出来的几条）：不用问的先存；有过去的月日的留着问（返回 ask） */
    async save(plan: TypePlan, raw: string): Promise<SaveOutcome | 'ask'> {
      if (plan.items.length === 0) return 'nothing';
      const { ready, ask } = splitConfirm(plan.items);
      const t0 = performance.now();
      const r = await store({ batchId: null, entries: [], plan, raw, remind: false, ...(source ? { source } : {}) }, ready, env());
      // ms：只算存这一步（写本机、进 outbox）；等 AI 的耗时在调用方的 planned 行里（Q-27 取证：两行相加是按“记下”后一共等了多久）
      rlog(`${tag} stored out=${r.out} ready=${ready.length} ask=${ask.length} origin=${plan.origin} ms=${Math.round(performance.now() - t0)}`);
      if (r.out !== 'ok' || !r.batch) return r.out === 'ok' ? 'not_saved' : r.out;
      put({ batch: r.batch, ask });
      return ask.length === 0 ? 'ok' : 'ask';
    },
    /** 确认行选了（确认行只在调用方 confirming 时画）：加进同一批；问完了收尾 */
    async choose(c: 'past' | 'next'): Promise<void> {
      const { batch, ask } = get();
      const first = ask[0];
      if (!batch || !first || choosing) return;
      choosing = true;
      const r = await store(batch, [applyConfirm(first, c)], env()).finally(() => {
        choosing = false;
      });
      if (r.out !== 'ok' || !r.batch) return flow.error(r.out === 'switching' ? 'switching' : 'not_saved');
      const rest = ask.slice(1);
      put({ batch: r.batch, ask: rest });
      if (rest.length > 0) return;
      flow.go({ type: 'confirmed' });
      land('ok', batch.plan);
    },
    /** 确认行没选就关掉：不再问，回到 idle；返回关掉之前的这一批（调用方决定原话怎么办） */
    dismiss(): BatchState {
      const was = get();
      put({ ask: [] });
      flow.go({ type: 'cancel' });
      return was;
    },
    async undoOne(id: string): Promise<void> {
      const { batch } = get();
      const hit = batch?.entries.find((e) => e.ref.id === id);
      if (!batch || !hit) return;
      const left = await undoRefs([hit.ref], clock.now(), writer);
      // 没撤成（纪念日、写不进去）：那一条还在，提示条说一句
      if (left.length > 0) return put({ batch: { ...batch, ...afterUndo([hit], left), entries: batch.entries } });
      const entries = batch.entries.filter((e) => e.ref.id !== id);
      put({ batch: entries.length > 0 ? { ...batch, entries } : null });
    },
    /** 全部撤销：撤成的拿掉；没撤成的留在提示条上（能再点一次）；只剩纪念日不算失败。全撤成了回到 idle */
    async undo(): Promise<void> {
      const { batch } = get();
      if (batch) {
        const left = await undoRefs(batch.entries.map((e) => e.ref), clock.now(), writer);
        rlog(`${tag} undo_all n=${batch.entries.length} left=${left.length}`);
        const rest = afterUndo(batch.entries, left);
        put({ batch: left.length === 0 ? null : { ...batch, ...rest, mergeFailed: false } });
        if (rest.undoFailed !== 0) return;
      }
      flow.go({ type: 'reset' });
    },
    /** 拆错了，合并成一条：没存上原来的几条不动，提示条自己加一句（不把原话填回输入条，免得再记一遍） */
    async merge(): Promise<void> {
      const { batch } = get();
      const one = batch ? mergeItems(batch.entries.map((e) => e.item), batch.raw) : null;
      if (!batch || !one) return;
      const e = env();
      const r = await store({ ...batch, batchId: null, entries: [], remind: false, mergeFailed: false, undoFailed: 0, annivKept: false }, [one], e);
      rlog(`${tag} merge out=${r.out} n=${batch.entries.length}`);
      if (r.out !== 'ok' || !r.batch) return put({ batch: { ...batch, mergeFailed: true } });
      // 新的存成了再撤原来的；撤不掉的（纪念日、写不进去）留在新的提示条上，写明
      const left = await undoRefs(batch.entries.map((x) => x.ref), e.now, writer);
      if (left.length > 0) rlog(`${tag} merge undo_left=${left.length}`);
      const rest = afterUndo(batch.entries, left);
      put({ batch: { ...r.batch, ...rest, entries: [...r.batch.entries, ...rest.entries] } });
    },
    closeNotice(): void {
      put({ batch: null });
      flow.go({ type: 'reset' });
    },
    /** 新的一次按住：上一批的提示条、确认行收起 */
    fresh: (): void => put({ batch: null, ask: [] }),
  };
}
