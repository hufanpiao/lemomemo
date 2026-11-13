// 记下来的这一批（B3 任务单 FA-2；架构 5.1 提示条、R-166）。纯 TS 工厂（FA-3 第二轮复查第 2 条从 hooks/useSavedBatch.ts 挪来），界面只 useStore(box) 来画
// • 同一句话的几条共用一个 batch_id；确认行选完的那一条加进同一批（R-166），“全部撤销”照样一起撤
// • “已记下 N 条”展开后：每条能修改（交给调用方开编辑页）或撤销；“拆错了，合并成一条”；“全部撤销”
// • 合并：先把整句原话存成新的一条（新的一批，新的 plan：不带原来的重复、安排、没有的日子、额度提示），存成了再撤原来的几条；
//   没存上就原样留着，提示条加一句“合并没保存上”。这一批单条撤成过（条数比存下的少）就不再给合并：整句原话会把撤掉的又记回去（主持人代定，待负责人确认）
// • 撤过没撤成的条标上 undoTried，留在提示条上：“N 条没撤销成功，可以再试一次”的 N、“纪念日请到纪念日页删除”都由 noticeOf 按条现算
//   （FA-3 整块评审第 13 条；纪念日在这里撤不掉，capture-save 的 undoRefs 一律留下，不算没撤成）
// • 合并的结果放在 last（每次操作写回时整体换掉）：合并没存上；合并成了、原来几条里撤不掉的不留在新的提示条上、不算条数，
//   只加一句“N 条没撤销成功，请到列表里删除”（mergeLeft）和 / 或“纪念日请到纪念日页删除”（负责人 11-13 定，待定 23、R-405）
// • 会写库的操作（choose、undo、undoOne、merge）共用一把锁：进行中再点一律不理（连点会存两条、撤掉的又回到提示条上）；
//   新的一句（save）、新的一次按住（fresh）、关掉提示条（closeNotice）换代号：之前没走完的操作回来发现代号变了，不写回、不调 flow。
//   写回一律基于 await 之后的最新状态
// • “该不该提醒今天的次数用完了”在这一批第一次有条目存成的那一刻定、记一笔（一天只提醒一次）；确认行没选就关掉不再补（第 12 条）
// • 打字条和按住录音共用这一份（FA-3 第二轮第 5 条）：存（save）、存完往哪走（land）、确认行（choose）、撤销、合并、关掉；
//   两边只给自己的状态机、收尾和失败提示（flow）。录音那份由控制器持有（切页重挂提示条还在，第 11 条），打字条每次挂载一份
// 纯 TS：不准 import React（A1）
import { createStore } from 'zustand/vanilla';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { quotaResetClock } from '../../../../shared/logic/ai-quota.ts';
import type { ParseHints } from '../../../../shared/logic/parse/index.ts';
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
  /** 撤过、没撤成（纪念日、写不进去）：还在提示条上，算进“没撤销成功”或“纪念日请到纪念日页删除” */
  undoTried?: true;
}

/** 上一次合并的结果（每次操作写回时整体换掉）：合并没存上；合并成了、原来几条里撤不掉的（不在提示条上，纪念日单算） */
export type BatchLast = null | 'merge_failed' | { mergeLeft: number; annivLeft: boolean };

export interface Batch {
  batchId: string | null;
  entries: BatchEntry[];
  plan: TypePlan;
  raw: string;
  remind: boolean;
  /** 从哪来：打字 page（不给就是它）、录音 voice（B3 FA-3）；写进行的 source 列 */
  source?: 'page' | 'voice';
  /** 这一批一共存下了几条（确认行选完加进来的也算）：entries 比它少就是撤成过，不再给合并 */
  stored: number;
  /** 确认行有一条没选就关掉了（没存）：这一批不全，合并会把没存的那条的原话也带进去，所以不给合并（复查 N4） */
  partial?: true;
  last: BatchLast;
}

const NO_HINTS: ParseHints = { recur: false, arrange: false, bad_day: null };
const isAnniv = (r: SavedRef): boolean => r.table === 'anniversaries';

/** 能不能“拆错了，合并成一条”：多条，一条都没撤成过，确认行也没有没选就关掉的 */
const canMerge = (b: Batch): boolean => !b.partial && b.entries.length > 1 && b.entries.length === b.stored;

/** 撤过这几条以后（基于最新的这一批）：撤成的拿掉，没撤成的标上 undoTried；“合并没存上”换掉，合并成了留下的指路句保留（复查 N3）；一条不剩为 null */
function afterTry(b: Batch | null, tried: readonly SavedRef[], left: readonly SavedRef[]): Batch | null {
  if (!b) return null;
  const hit = new Set(tried.map((r) => r.id));
  const kept = new Set(left.map((r) => r.id));
  const entries = b.entries.flatMap((e): BatchEntry[] => (!hit.has(e.ref.id) ? [e] : kept.has(e.ref.id) ? [{ ...e, undoTried: true }] : []));
  return entries.length > 0 ? { ...b, entries, last: b.last === 'merge_failed' ? null : b.last } : null;
}

/** 这一批里撤过没撤成的（纪念日不算） */
const failedOf = (b: Batch): number => b.entries.filter((e) => e.undoTried && !isAnniv(e.ref)).length;

export interface SaveEnv {
  now: number;
  tz: Tz;
  day: DateStr | null;
}

/** 提示条：主句和附加句，加上这一批每一条（多条时展开逐条改、撤）；merge 给不给“拆错了，合并成一条” */
export interface BatchNotice {
  lines: NoticeLine[];
  entries: BatchEntry[];
  merge: boolean;
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
  const last = batch.last;
  const merged = last !== null && last !== 'merge_failed' ? last : null;
  const lines = noticeLines({
    status: batch.plan.status, titles: batch.entries.map((e) => e.ref.title), hints: batch.plan.hints, remind: batch.remind,
    quotaNoticeDue: quotaDue, resetClock: quotaResetClock(clock.now(), currentTz()),
    mergeFailed: last === 'merge_failed', undoFailed: failedOf(batch), mergeLeft: merged?.mergeLeft ?? 0,
    annivKept: batch.entries.some((e) => e.undoTried && isAnniv(e.ref)) || merged?.annivLeft === true,
  });
  return { lines, entries: batch.entries, merge: canMerge(batch) };
}

/** 两边各自的那一点：go 自己的状态机；done 这一批都存好了；fail 新的一句没存上；error 确认行选了没存上（状态不动，还能再选） */
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
  /** 代号：新的一句、新的一次按住、关掉提示条时加 1；await 回来变了就不写回 */
  let gen = 0;
  /** 写库的操作进行中的那一代（choose、undo、undoOne、merge 共用）：同一代再点不理；换了代的新提示条照常能点（复查 N2） */
  let busyGen = -1;

  const once = async (op: string, run: (g: number) => Promise<void>): Promise<void> => {
    const g = gen;
    if (busyGen === g) {
      rlog(`${tag} busy skip op=${op}`);
      return;
    }
    busyGen = g;
    try {
      await run(g);
    } finally {
      if (busyGen === g) busyGen = -1;
    }
  };
  /** await 回来：代号变了（之后又按了“＋”、关了提示条、记了新的一句）就不写回 */
  const stale = (g: number, op: string): boolean => {
    if (g === gen) return false;
    rlog(`${tag} stale op=${op}`);
    return true;
  };
  /** 这一批第一次有条目存成：该提醒“今天的次数用完了”时记一笔（一天只提醒一次），返回这次该不该提醒 */
  const quotaOnce = (plan: TypePlan): boolean => {
    const now = clock.now();
    const due = quotaNoticeDue(now);
    if (plan.status === 'quota_out' && due) markQuotaNotice(now);
    return due;
  };

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
    return {
      batch: { ...base, batchId: res.batchId, entries: [...base.entries, ...entries], stored: base.stored + entries.length, remind: base.remind || res.remind },
      out: 'ok',
    };
  };

  /** 存完往哪走：问 → 确认行；好 → 调用方收尾（额度提示存成那一刻已经定了）；别的交给调用方的失败提示 */
  const land = (out: SaveOutcome | 'ask', plan: TypePlan): void => {
    if (out === 'ask') return flow.go({ type: 'need_confirm' });
    if (out !== 'ok') return flow.fail(out);
    flow.done(plan);
  };

  return {
    box,
    land,
    /** 新的一句（plan.items 是整句拆出来的几条）：不用问的先存；有过去的月日的留着问（返回 ask）。上一批没走完的操作不再写回 */
    async save(plan: TypePlan, raw: string): Promise<SaveOutcome | 'ask'> {
      if (plan.items.length === 0) return 'nothing';
      gen += 1;
      const { ready, ask } = splitConfirm(plan.items);
      const t0 = performance.now();
      const r = await store({ batchId: null, entries: [], plan, raw, remind: false, stored: 0, last: null, ...(source ? { source } : {}) }, ready, env());
      // ms：只算存这一步（写本机、进 outbox）；等 AI 的耗时在调用方的 planned 行里（Q-27 取证：两行相加是按“记下”后一共等了多久）
      rlog(`${tag} stored out=${r.out} ready=${ready.length} ask=${ask.length} origin=${plan.origin} ms=${Math.round(performance.now() - t0)}`);
      if (r.out !== 'ok' || !r.batch) return r.out === 'ok' ? 'not_saved' : r.out;
      put({ batch: r.batch, ask, quotaDue: r.batch.entries.length > 0 ? quotaOnce(plan) : false });
      return ask.length === 0 ? 'ok' : 'ask';
    },
    /** 确认行选了（确认行只在调用方 confirming 时画）：加进同一批；问完了收尾 */
    choose: (c: 'past' | 'next'): Promise<void> =>
      once('choose', async (g) => {
        const { batch, ask } = get();
        const first = ask[0];
        if (!batch || !first) return;
        const r = await store(batch, [applyConfirm(first, c)], env());
        if (stale(g, 'choose')) return;
        if (r.out !== 'ok' || !r.batch) return flow.error(r.out === 'switching' ? 'switching' : 'not_saved');
        const rest = get().ask.slice(1);
        // 存的时候确认行被关掉了（dismiss 在最新那一批上标了 partial）：写回时带上，不让“合并”又出来（复查续第 2 条）
        put({ batch: get().batch?.partial ? { ...r.batch, partial: true } : r.batch, ask: rest, ...(batch.entries.length === 0 ? { quotaDue: quotaOnce(batch.plan) } : {}) });
        if (rest.length > 0) return;
        flow.go({ type: 'confirmed' });
        land('ok', batch.plan);
      }),
    /** 确认行没选就关掉：不再问，回到 idle；返回关掉之前的这一批（调用方决定原话怎么办） */
    dismiss(): BatchState {
      const was = get();
      put(was.batch ? { ask: [], batch: { ...was.batch, partial: true } } : { ask: [] });
      flow.go({ type: 'cancel' });
      return was;
    },
    /** 逐条撤销：撤成了拿掉；没撤成（纪念日、写不进去）那一条留着、标上，提示条说一句 */
    undoOne: (id: string): Promise<void> =>
      once('undo_one', async (g) => {
        const hit = get().batch?.entries.find((e) => e.ref.id === id);
        if (!hit) return;
        const left = await undoRefs([hit.ref], clock.now(), writer);
        if (stale(g, 'undo_one')) return;
        put({ batch: afterTry(get().batch, [hit.ref], left) });
      }),
    /** 全部撤销：撤成的拿掉；没撤成的留在提示条上（能再点一次）；只剩纪念日不算失败。没有真正没撤成的回到 idle */
    undo: (): Promise<void> =>
      once('undo_all', async (g) => {
        const batch = get().batch;
        if (batch) {
          const refs = batch.entries.map((e) => e.ref);
          const left = await undoRefs(refs, clock.now(), writer);
          rlog(`${tag} undo_all n=${refs.length} left=${left.length}`);
          if (stale(g, 'undo_all')) return;
          const next = afterTry(get().batch, refs, left);
          put({ batch: next });
          if (next && failedOf(next) > 0) return;
        }
        flow.go({ type: 'cleared' });
      }),
    /** 拆错了，合并成一条：没存上原来的几条不动，提示条自己加一句（不把原话填回输入条，免得再记一遍） */
    merge: (): Promise<void> =>
      once('merge', async (g) => {
        const batch = get().batch;
        const one = batch && canMerge(batch) ? mergeItems(batch.entries.map((e) => e.item), batch.raw) : null;
        if (!batch || !one) return;
        const e = env();
        const plan: TypePlan = { ...batch.plan, status: 'saved', items: [one], hints: NO_HINTS, quotaLeft: null, aiReason: null };
        const base: Batch = { batchId: null, entries: [], plan, raw: batch.raw, remind: false, stored: 0, last: null, ...(batch.source ? { source: batch.source } : {}) };
        const r = await store(base, [one], e);
        rlog(`${tag} merge out=${r.out} n=${batch.entries.length}`);
        if (r.out !== 'ok' || !r.batch) {
          const now = stale(g, 'merge') ? null : get().batch;
          if (now) put({ batch: { ...now, last: 'merge_failed' } });
          return;
        }
        // 新的存成了再撤原来的：代号变了也照样撤（新的一条已经在库里，不撤就重了），只是不写回提示条
        const refs = batch.entries.map((x) => x.ref);
        const left = await undoRefs(refs, e.now, writer);
        if (left.length > 0) rlog(`${tag} merge undo_left=${left.length}`);
        if (stale(g, 'merge')) return;
        const anniv = left.filter(isAnniv).length;
        put({ batch: { ...r.batch, last: { mergeLeft: left.length - anniv, annivLeft: anniv > 0 } } });
      }),
    closeNotice(): void {
      gen += 1;
      put({ batch: null });
      flow.go({ type: 'cleared' });
    },
    /** 新的一次按住：上一批的提示条、确认行收起 */
    fresh(): void {
      gen += 1;
      put({ batch: null, ask: [] });
    },
  };
}
