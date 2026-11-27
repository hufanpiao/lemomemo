// 记下来的这一批（提示条）。纯 TS 工厂，界面只 useStore(box) 来画
// • 同一句话的几条共用一个 batch_id；确认行选完的那一条加进同一批，“全部撤销”照样一起撤
// • “已记下 N 条”展开后：每条能修改（交给调用方开编辑页）或撤销；“拆错了，合并成一条”；“全部撤销”
// • 合并：先把整句原话存成新的一条（新的一批，新的 plan：不带原来的重复、安排、没有的日子、额度提示），存成了再撤原来的几条；
//   没存上就原样留着，提示条加一句“合并没保存上”。这一批单条撤成过（条数比存下的少）就不再给合并：整句原话会把撤掉的又记回去
// • 撤过没撤成的条标上 undoTried，留在提示条上：“N 条没撤销成功，可以再试一次”的 N、“纪念日请到纪念日页删除”都由 noticeOf 按条现算
//   （纪念日在这里撤不掉，capture-save 的 undoRefs 一律留下，不算没撤成）
// • 合并的结果放在 last（每次操作写回时整体换掉）：合并没存上；合并成了、原来几条里撤不掉的不留在新的提示条上、不算条数，
//   只加一句“N 条没撤销成功，请到列表里删除”（mergeLeft）和 / 或“纪念日请到纪念日页删除”
// • 会写库的操作（choose、undo、undoOne、merge）共用一把锁：进行中再点一律不理（连点会存两条、撤掉的又回到提示条上）；
//   新的一句（save）、新的一次按住（fresh）、关掉提示条（closeNotice）换代号：之前没走完的操作回来发现代号变了，不写回、不调 flow。
//   写回一律基于 await 之后的最新状态
// • “该不该提醒今天的次数用完了”在这一批第一次有条目存成的那一刻定、记一笔（一天只提醒一次）；确认行没选就关掉不再补
// • 打字条和按住录音共用这一份：存（save）、存完往哪走（land）、确认行（choose）、撤销、合并、关掉；
//   两边只给自己的状态机、收尾和失败提示（flow）。录音那份由控制器持有（切页重挂提示条还在），打字条那份在 data/type-batch.ts 模块里（整页一份，提示条外挂）
// • AI 后台整理完换掉先存的（replace；出过字先存的和没出字的占位“语音记录 · 整理中”同一套，voice-pending.ts）：
//   和合并同一个 swap（先存新的一批、撤旧的之前再看一眼、再撤原来的、没存上原样留着），也走同一把锁；换的是提示条上正在画的这一批时
//   swapping 置上、按钮全部禁用。先存那一刻 mark() 记下这一批、这一批的改动号（rev，按 batchId 记）和库里每一条的样子（updated_at、done_at，删掉的记 gone）。
//   “用户动过没有”只此一份（look，voice-pending 的改名、撤占位也用它）：提示条上撤销、逐条撤、合并、AI 换掉过 → gone；
//   在别处删掉 → gone；在别处改过、勾完成、编辑页开着（edit 登记）、提示条上动过这一批（确认行选或关、点了“修改”touch）→ edited：都不替换。
//   连着说两句时照样换：新的一句、新的一次按住不算动过上一批，上一句没动过照样换。
//   提示条已经关掉（自己点 × 或 5 秒到了）、换成了别的一批的：库里照样换，提示条不再弹出来；还开着的换成 AI 那一批，加一句“AI 已整理”，撤销照样能用
// 纯 TS：不准 import React
import { createStore } from 'zustand/vanilla';
import { collection } from '../../../core/store.ts';
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
import { NO_HINTS, applyConfirm, mergeItems, splitConfirm, type TypePlan } from './type-flow.ts';

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
  /** 从哪来：打字 page（不给就是它）、录音 voice；写进行的 source 列 */
  source?: 'page' | 'voice';
  /** 这一批一共存下了几条（确认行选完加进来的也算）：entries 比它少就是撤成过，不再给合并 */
  stored: number;
  /** 确认行有一条没选就关掉了（没存）：这一批不全，合并会把没存的那条的原话也带进去，所以不给合并 */
  partial?: true;
  last: BatchLast;
  /** AI 后台整理换掉了先存的：提示条加一句“AI 已整理” */
  byAi?: true;
}

/** 先存那一刻记下的：这一批、这一批当时的改动号（按批记）、库里每一条的样子（peek 读的，和 entries 一一对应） */
export interface BatchMark {
  batch: Batch;
  rev: number;
  seen: (string | null)[];
}

/** 判“用户动过没有”只要这几样（look 用；app 重开以后占位那一条从本机库里拼回来的也是这个样子，rev 为 -1 = 不比改动号） */
export interface MarkLike {
  batch: { batchId: string | null; entries: readonly { ref: SavedRef }[] };
  rev: number;
  seen: readonly (string | null)[];
}

/** 这一批先存的几条现在怎样：ok 没动过；gone 撤掉、删掉了；edited 改过、勾完成、编辑页开着、提示条上动过 */
export type Look = 'ok' | 'gone' | 'edited';

/** 库里这一条现在的样子（改过、勾完成都会变）：删掉、撤掉的是 'gone'；本机集合里没有是 null */
export type Peek = (ref: SavedRef) => string | null;

const peekStore: Peek = (ref) => {
  const row = collection(ref.table).get(ref.id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return row['deleted_at'] != null ? 'gone' : JSON.stringify([row['updated_at'] ?? null, row['done_at'] ?? null]);
};

/** AI 后台整理的结果：replaced 换了；same 和先存的一样；not_saved 新的没存上（先存的原样留着）；
 *  skip_* 没换（为什么：gone 撤掉删掉了、edited 动过、confirm 要先问、busy 锁占着、empty AI 一条都没拆出来） */
export type ReplaceOut = 'replaced' | 'same' | 'not_saved' | 'skip_gone' | 'skip_edited' | 'skip_confirm' | 'skip_busy' | 'skip_empty';

/** 比标题前去掉空白和标点（“买牛奶。”和“买 牛奶”算一样） */
const bare = (s: string): string => s.replace(/[\s\p{P}]/gu, '');

/** 两次拆出来的算不算一样：条数、每条的类型、标题（去掉空白和标点）、日子、截止、时刻、时长、项目都一样。
 *  标题也比：AI 后台整理就是要纠正识别错的字，结构一样、字不一样也要换；
 *  项目也比（R-497）：AI 照以前怎么分的配了自建项目、别的都和本机规则一样时也要换，不然先存的固定类别留着 */
export function sameItems(a: readonly AiItem[], b: readonly AiItem[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return y !== undefined && x.kind === y.kind && bare(x.title) === bare(y.title) && x.date === y.date && x.due === y.due && x.time === y.time && x.duration_min === y.duration_min
      && (x.project ?? null) === (y.project ?? null);
  });
}

const isAnniv = (r: SavedRef): boolean => r.table === 'anniversaries';

/** 能不能“拆错了，合并成一条”：多条，一条都没撤成过，确认行也没有没选就关掉的 */
const canMerge = (b: Batch): boolean => !b.partial && b.entries.length > 1 && b.entries.length === b.stored;

/** 撤过这几条以后（基于最新的这一批）：撤成的拿掉，没撤成的标上 undoTried；“合并没存上”换掉，合并成了留下的指路句保留；一条不剩为 null */
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
  /** 模糊先按记下存了的：提示条给“改成搜索”，found 时再给“也帮你找了一下：N 条 ›” */
  alt: TypePlan['alt'];
  /** 这一批的原话（“改成搜索”撤销以后照它查找、“改成记下”照它再记） */
  raw: string;
  /** AI 整理正在换这一批：按钮全部禁用 */
  busy: boolean;
}

/** 这一批：记下的、确认行还要问的几条（过去的月日）、这次该不该提醒“今天的次数用完了” */
export interface BatchState {
  batch: Batch | null;
  ask: AiItem[];
  quotaDue: boolean;
  /** AI 整理正在换这一批（replace 进行中） */
  swapping: boolean;
}

/** 这一批放在哪（zustand 的 vanilla store；不是组件状态） */
export const createBatchBox = () => createStore<BatchState>(() => ({ batch: null, ask: [], quotaDue: false, swapping: false }));
export type BatchBox = ReturnType<typeof createBatchBox>;

/** 提示条（没有记下的就是 null；确认行出着时调用方不画它） */
export function noticeOf({ batch, quotaDue, swapping }: BatchState): BatchNotice | null {
  if (!batch || batch.entries.length === 0) return null;
  const last = batch.last;
  const merged = last !== null && last !== 'merge_failed' ? last : null;
  const lines = noticeLines({
    status: batch.plan.status, titles: batch.entries.map((e) => e.ref.title), hints: batch.plan.hints, remind: batch.remind,
    quotaNoticeDue: quotaDue, resetClock: quotaResetClock(clock.now(), currentTz()),
    mergeFailed: last === 'merge_failed', undoFailed: failedOf(batch), mergeLeft: merged?.mergeLeft ?? 0, aiTidied: batch.byAi === true,
    annivKept: batch.entries.some((e) => e.undoTried && isAnniv(e.ref)) || merged?.annivLeft === true,
  });
  return { lines, entries: batch.entries, merge: canMerge(batch), alt: batch.plan.alt ?? null, raw: batch.raw, busy: swapping };
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
  /** 测试用：读库里一条的样子（不给读本机库） */
  peek?: Peek | undefined;
}

export type SavedBatch = ReturnType<typeof createSavedBatch>;

/** 换的那一下锁被占着（提示条上正在撤销、合并）：等这么久再试一次 */
export const BUSY_RETRY_MS = 1000;

/**
 * AI 后台整理回来换掉先存的（录音 voice-pending、打字 type-batch 的 tidyTyped 共用这一份）：换的那一下占住升级中心的 busy
 * （hold 占上、交回放开的函数），锁被占着（skip_busy）等 BUSY_RETRY_MS 再试一次，日志 `<tag> tidy busy_retry`；at 见 replace
 */
export async function replaceHeld(
  b: Pick<SavedBatch, 'replace'>, m: BatchMark, plan: TypePlan, raw: string, hold: () => (() => void) | undefined, tag: string, at?: Omit<SaveEnv, 'now'>,
): Promise<ReplaceOut> {
  const once = async (): Promise<ReplaceOut> => {
    const free = hold();
    try {
      return await b.replace(m, plan, raw, at);
    } finally {
      free?.();
    }
  };
  const out = await once();
  if (out !== 'skip_busy') return out;
  rlog(`${tag} tidy busy_retry`);
  await new Promise<void>((ok) => setTimeout(ok, BUSY_RETRY_MS));
  return once();
}

export function createSavedBatch({ box, writer, tag, source, env, flow, peek = peekStore }: SavedBatchOpts) {
  const get = box.getState;
  const put = (s: Partial<BatchState>): void => box.setState(s);
  /** 代号：新的一句、新的一次按住、关掉提示条时加 1；await 回来变了就不写回 */
  let gen = 0;
  /** 写库的操作进行中的那一代（choose、undo、undoOne、merge 共用）：同一代再点不理；换了代的新提示条照常能点 */
  let busyGen = -1;
  /** 改动号，按批记（batchId → 次数；连着说两句时照样换）：用户在提示条上动过这一批就加 1，
   *  新的一句（save）、新的一次按住（fresh）不碰上一批的；AI 后台整理回来对不上就不替换 */
  const revs = new Map<string, number>();
  const revOf = (id: string | null): number => (id === null ? 0 : (revs.get(id) ?? 0));
  /** 提示条上正在画的这一批算动过一次 */
  const bump = (): void => {
    const id = get().batch?.batchId ?? null;
    if (id === null) return;
    revs.set(id, revOf(id) + 1);
    // 只留最近的几十批（一次运行里说不了几句，防的是一直不重开）
    if (revs.size > 64) revs.delete(revs.keys().next().value as string);
  };
  /** 经这里撤成了的（提示条上撤销、逐条撤、合并、AI 换掉）：库里还没同步到本机集合时也认得出撤掉了 */
  const undone = new Set<string>();
  const undoHere = async (refs: readonly SavedRef[], now: number): Promise<SavedRef[]> => {
    const left = await undoRefs(refs, now, writer);
    const kept = new Set(left.map((r) => r.id));
    for (const r of refs) if (!kept.has(r.id)) undone.add(r.id);
    return left;
  };
  /** 编辑页开着的几条（edit 登记，关掉时撤）：AI 回来不替换 */
  const editing = new Map<string, number>();
  /** 这一批先存的几条现在怎样（replace、voice-pending 的改名和撤掉都只看它，判“用户动过没有”只此一份） */
  const look = (m: MarkLike): Look => {
    const refs = m.batch.entries.map((e) => e.ref);
    if (refs.some((r, i) => undone.has(r.id) || (peek(r) === 'gone' && m.seen[i] !== 'gone'))) return 'gone';
    if (refs.some((r, i) => editing.has(r.id) || peek(r) !== m.seen[i])) return 'edited';
    return m.rev >= 0 && revOf(m.batch.batchId) !== m.rev ? 'edited' : 'ok';
  };

  const once = async <T = void>(op: string, run: (g: number) => Promise<T>): Promise<T | undefined> => {
    const g = gen;
    if (busyGen === g) {
      rlog(`${tag} busy skip op=${op}`);
      return undefined;
    }
    busyGen = g;
    try {
      return await run(g);
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
    if (!res.ok) return { batch: base.entries.length > 0 ? base : null, out: res.reason === 'switching' || res.reason === 'nothing' ? res.reason : 'not_saved' };
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

  /** 先存新的一批（plan、raw、items），存成了再撤 old 的几条（合并、AI 整理替换共用）：没存上返回 null，原来的几条不动。
   *  新的存成了就撤旧的（不撤就重了），撤不掉的交回 left；still：撤旧的之前再看一眼（AI 替换用），这时用户动过了就撤掉刚存的、旧的不动，交回为什么 */
  const swap = async (
    old: Batch, plan: TypePlan, raw: string, items: AiItem[], e: SaveEnv, still?: () => Look,
  ): Promise<{ batch: Batch; left: SavedRef[] } | null | Exclude<Look, 'ok'>> => {
    const base: Batch = { batchId: null, entries: [], plan, raw, remind: false, stored: 0, last: null, ...(old.source ? { source: old.source } : {}) };
    const r = await store(base, items, e);
    if (r.out !== 'ok' || !r.batch) return null;
    const now = still?.() ?? 'ok';
    if (now !== 'ok') {
      const back = await undoRefs(r.batch.entries.map((x) => x.ref), e.now, writer);
      rlog(`${tag} swap late_${now} back_left=${back.length}`);
      return now;
    }
    const left = await undoHere(old.entries.map((x) => x.ref), e.now);
    if (left.length > 0) rlog(`${tag} swap undo_left=${left.length}`);
    return { batch: r.batch, left };
  };
  /** 撤不掉的几条：不留在新的提示条上，指路句的条数、纪念日 */
  const leftOf = (left: readonly SavedRef[]): BatchLast => {
    const anniv = left.filter(isAnniv).length;
    return { mergeLeft: left.length - anniv, annivLeft: anniv > 0 };
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
      // 只换代号；改动号按批记，新的一句不算动过上一批
      gen += 1;
      const { ready, ask } = splitConfirm(plan.items);
      const t0 = performance.now();
      const r = await store({ batchId: null, entries: [], plan, raw, remind: false, stored: 0, last: null, ...(source ? { source } : {}) }, ready, env());
      // ms：只算存这一步（写本机、进 outbox）；等 AI 的耗时在调用方的 planned 行里（两行相加是按“记下”后一共等了多久）
      rlog(`${tag} stored out=${r.out} ready=${ready.length} ask=${ask.length} origin=${plan.origin} ms=${Math.round(performance.now() - t0)}`);
      if (r.out !== 'ok' || !r.batch) return r.out === 'ok' ? 'not_saved' : r.out;
      put({ batch: r.batch, ask, quotaDue: r.batch.entries.length > 0 ? quotaOnce(plan) : false });
      return ask.length === 0 ? 'ok' : 'ask';
    },
    /** 确认行选了（确认行只在调用方 confirming 时画）：加进同一批；问完了收尾 */
    choose: (c: 'past' | 'next'): Promise<void> =>
      once('choose', async (g) => {
        bump();
        const { batch, ask } = get();
        const first = ask[0];
        if (!batch || !first) return;
        const r = await store(batch, [applyConfirm(first, c)], env());
        if (stale(g, 'choose')) return;
        if (r.out !== 'ok' || !r.batch) return flow.error(r.out === 'switching' ? 'switching' : 'not_saved');
        const rest = get().ask.slice(1);
        // 存的时候确认行被关掉了（dismiss 在最新那一批上标了 partial）：写回时带上，不让“合并”又出来
        put({ batch: get().batch?.partial ? { ...r.batch, partial: true } : r.batch, ask: rest, ...(batch.entries.length === 0 ? { quotaDue: quotaOnce(batch.plan) } : {}) });
        if (rest.length > 0) return;
        flow.go({ type: 'confirmed' });
        land('ok', batch.plan);
      }),
    /** 确认行没选就关掉：不再问，回到 idle；返回关掉之前的这一批（调用方决定原话怎么办） */
    dismiss(): BatchState {
      const was = get();
      bump();
      put(was.batch ? { ask: [], batch: { ...was.batch, partial: true } } : { ask: [] });
      flow.go({ type: 'cancel' });
      return was;
    },
    /** 逐条撤销：撤成了拿掉；没撤成（纪念日、写不进去）那一条留着、标上，提示条说一句 */
    undoOne: (id: string): Promise<void> =>
      once('undo_one', async (g) => {
        bump();
        const hit = get().batch?.entries.find((e) => e.ref.id === id);
        if (!hit) return;
        const left = await undoHere([hit.ref], clock.now());
        if (stale(g, 'undo_one')) return;
        put({ batch: afterTry(get().batch, [hit.ref], left) });
      }),
    /** 全部撤销：撤成的拿掉；没撤成的留在提示条上（能再点一次）；只剩纪念日不算失败。没有真正没撤成的回到 idle */
    /** 撤整批；返回 true = 全撤掉了（提示条“改成搜索”只在这时换成查找）；连点被锁挡下是 undefined */
    undo: (): Promise<boolean | undefined> =>
      once('undo_all', async (g) => {
        bump();
        const batch = get().batch;
        if (batch) {
          const refs = batch.entries.map((e) => e.ref);
          const left = await undoHere(refs, clock.now());
          rlog(`${tag} undo_all n=${refs.length} left=${left.length}`);
          if (stale(g, 'undo_all')) return false;
          const next = afterTry(get().batch, refs, left);
          put({ batch: next });
          if (next && failedOf(next) > 0) return false;
        }
        flow.go({ type: 'cleared' });
        return true;
      }),
    /** 拆错了，合并成一条：没存上原来的几条不动，提示条自己加一句（不把原话填回输入条，免得再记一遍） */
    merge: (): Promise<void> =>
      once('merge', async (g) => {
        bump();
        const batch = get().batch;
        const one = batch && canMerge(batch) ? mergeItems(batch.entries.map((e) => e.item), batch.raw) : null;
        if (!batch || !one) return;
        const plan: TypePlan = { ...batch.plan, status: 'saved', items: [one], hints: NO_HINTS, quotaLeft: null, aiReason: null };
        const r = await swap(batch, plan, batch.raw, [one], env());
        rlog(`${tag} merge out=${r ? 'ok' : 'not_saved'} n=${batch.entries.length}`);
        if (!r || typeof r === 'string') {
          const now = stale(g, 'merge') ? null : get().batch;
          if (now) put({ batch: { ...now, last: 'merge_failed' } });
          return;
        }
        // 代号变了也照样撤了（swap 里），只是不写回提示条
        if (stale(g, 'merge')) return;
        put({ batch: { ...r.batch, last: leftOf(r.left) } });
      }),
    /** 先存那一刻记下这一批（AI 后台整理回来时拿它比、拿它撤）；还没有记下的为 null */
    mark(): BatchMark | null {
      const batch = get().batch;
      return batch ? { batch, rev: revOf(batch.batchId), seen: batch.entries.map((e) => peek(e.ref)) } : null;
    },
    /** 自己改过这几条以后（voice-pending 改占位的标题）：重记库里的样子，免得把自己的改动当成用户动过 */
    remark<M extends MarkLike>(m: M): M {
      return { ...m, seen: m.batch.entries.map((e) => peek(e.ref)) };
    },
    look,
    /** 用户点了某一条的“修改”：算动过提示条上的这一批，AI 整理回来不再替换 */
    touch(): void {
      bump();
    },
    /** 编辑页打开了这一条（待办编辑页挂上时登记，返回关掉时调的）：开着的时候 AI 回来不替换、占位不改名不撤 */
    edit(id: string): () => void {
      editing.set(id, (editing.get(id) ?? 0) + 1);
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        const n = (editing.get(id) ?? 1) - 1;
        if (n > 0) editing.set(id, n);
        else editing.delete(id);
      };
    },
    /** AI 后台整理完：和先存的不一样就换（swap：先存 AI 的、撤旧的之前再看一眼、再撤先存的，没存上原样留着）。
     *  撤掉删掉了（skip_gone）、动过（skip_edited：改过、勾完成、编辑页开着、提示条上动过这一批）、这一批的确认行还在问、
     *  AI 的结果里有要问的过去月日（skip_confirm）：不换。换的是提示条上正在画的这一批时按钮禁用；
     *  换完提示条还开着的换成 AI 那一批、带“AI 已整理”，已经关掉、换成了别的一批的不再弹出来 */
    async replace(m: BatchMark, plan: TypePlan, raw: string, at?: Omit<SaveEnv, 'now'>): Promise<ReplaceOut> {
      // AI 一条都没拆出来：不拿空的去换，不然先存的会被撤掉、什么都不剩（调用方有转写时已经换成整句，见 voice-flow 的 finishVoice）
      if (plan.items.length === 0) return 'skip_empty';
      const l = look(m);
      if (l !== 'ok') return l === 'gone' ? 'skip_gone' : 'skip_edited';
      const current = (): boolean => get().batch?.batchId === m.batch.batchId;
      if ((current() && get().ask.length > 0) || plan.items.some((it) => it.confirm !== null)) return 'skip_confirm';
      if (sameItems(m.batch.entries.map((e) => e.item), plan.items)) return 'same';
      const out = await once<ReplaceOut>('replace', async (g) => {
        const mine = current();
        if (mine) put({ swapping: true });
        try {
          // at：说这句那一刻的时区、日历页选中的那天（打字这一路给；不给按现在绑着的）——AI 回来前切了页、选了别的日子也不记错天
          const r = await swap(m.batch, plan, raw, plan.items, at ? { ...at, now: env().now } : env(), () => look(m));
          if (!r) return 'not_saved';
          if (typeof r === 'string') return r === 'gone' ? 'skip_gone' : 'skip_edited';
          // 提示条已经关掉、换成了别的一批（又说了一句）：库里照样换了，提示条不动
          if (stale(g, 'replace') || !current()) return 'replaced';
          put({ batch: { ...r.batch, byAi: true, last: r.left.length > 0 ? leftOf(r.left) : null } });
          return 'replaced';
        } finally {
          if (mine) put({ swapping: false });
        }
      });
      return out ?? 'skip_busy';
    },
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
