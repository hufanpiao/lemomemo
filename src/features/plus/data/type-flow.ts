// 打字记一条：本机规则 → 有把握直接用 / 没把握调 ai-parse → 失败退回本机结果（B3 任务单 S2、FA-2；架构 5.1、5.11）
// • 本机规则只经 shared/logic/parse 的公开入口（parseSplit、confidence、recurHint、arrangeHint、clauseSeparators）
// • 有把握（R-54：只拆出 1 件、日期能识别、类型明确）→ 不调 AI、不花次数
// • 没把握，在线、开着 AI、今天还有次数 → ai-parse（6 秒超时；只在网络错误、连接都没建立时自动重试 1 次）
//   失败、超时、退回、没同意、不认识的 intent → 用本机结果，原话不丢（Q2 ②）；额度用完 → 本机结果 + 额度提示
// • 离线 → 本机结果，状态 offline_saved
// • R-353、R-359：日历页打的字没说日子时记到选中的那天（date_basis 记 rel，不问）；今天页、待办页照旧记今天。
//   选中的日子按后端约定传（任务单 R6）：本机规则 ParseOpts.defaultDay、ai-parse 请求体 default_day；补出来的日子不算认出了日子（R9），
//   “买牛奶”照旧判没把握，在线有次数照样交给 AI（带 default_day）。选中的日子过不了 checkDefaultDay（前 1 年到后 5 年以外，后端会回 400）时
//   不调 AI，直接用本机结果（照样记到选中那天）；万一后端仍回 400，按调 AI 没成退回本机结果（ai_failed http）
// • 过去的月日（confirm）：这里只带出来，界面出确认行，用户选了 applyConfirm 以后才保存；没选不保存。
//   没选就关掉确认行时，原话里去掉已经存了的那几条、只留等确认那条的原文（keepAsked）；去不干净时原话整句留着，界面提示其他几条已经记下了
// 纯 TS：不准 import React（A1）
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { arrangeHint, clauseSeparators, confidence, parseSplit, recurHint, type ParseHints, type ParseResult } from '../../../../shared/logic/parse/index.ts';
import { AI_TEXT_MAX, checkDefaultDay, normProjects, type AiItem } from '../../../../shared/schema/ai.ts';
import type { AiKind } from '../../../../shared/schema/kinds.ts';
import { outcomeOf, type AiOutcome } from './ai-outcome.ts';
import { AI_PARSE_TIMEOUT_MS, canAutoRetry, type SendFail } from './record-logic.ts';

export interface TypeCtx {
  now: number;
  tz: Tz;
  locale: 'zh' | 'ko';
  /** 本机已有的项目名（ai-parse 的 projects[]，本机规则认项目也用） */
  projects: readonly string[];
  /** 日历页选中的那天（R-353）；别的页为 null */
  day: DateStr | null;
  /** 这个人能用的类型；不给按本机规则的默认（日程、待办） */
  features?: readonly AiKind[];
}

export interface TypeEnv {
  online: boolean;
  /** 现在在不在线（断网重试前再看一眼；不给用 navigator.onLine） */
  isOnline?: () => boolean;
  /** 开着 AI（ai.enabled）并且同意过告知 */
  aiOn: boolean;
  /** 本机记着今天的次数已经用完（quota_left = 0） */
  quotaOut: boolean;
}

/** ai-parse 的请求体（接口先定第 2 条） */
export interface AiParseReq {
  text: string;
  now: number;
  tz: Tz;
  locale: 'zh' | 'ko';
  projects: string[];
  scope: 'main';
  /** 日历页选中的那天（R6；已过 checkDefaultDay）；别的页不传 */
  default_day?: DateStr;
}

/** 送 ai-parse 的口子：返回已 parse 的 JSON；失败抛 SendError（或 fetch 原样抛的 TypeError、AbortError） */
export type CallAi = (req: AiParseReq, signal: AbortSignal) => Promise<unknown>;

export class SendError extends Error {
  readonly fail: SendFail;
  constructor(fail: SendFail) {
    super(fail);
    this.fail = fail;
    this.name = 'SendError';
  }
}

export type TypeStatus =
  /** AI 识别的，或本机规则有把握的 */
  | 'saved'
  /** 调了 AI 没成，先用本机规则记 */
  | 'saved_rule'
  /** 今天的 AI 次数用完了，先用本机规则记 */
  | 'quota_out'
  /** 没网，先用本机规则记 */
  | 'offline_saved';

export interface TypePlan {
  status: TypeStatus;
  origin: 'ai' | 'rule';
  items: AiItem[];
  hints: ParseHints;
  /** AI 返回的剩余次数（没调 AI 或没返回为 null） */
  quotaLeft: number | null;
  /** 调 AI 没成的原因（日志、调试用；不给用户看） */
  aiReason: string | null;
}

/**
 * AI 返回以后的兜底（R-353、R6）：AI 已按 default_day 补日子，这里只补它漏掉的——没日子的日程、没截止日的待办记到选中那天（basis rel）。
 * 待办没截止日、连时刻也没有的也补（R6：“买牛奶”记成选中那天的待办）
 */
export function fillDay(items: readonly AiItem[], day: DateStr | null): AiItem[] {
  if (day === null) return [...items];
  return items.map((it) => {
    if (it.kind === 'event' && it.date === null) return { ...it, date: day, date_basis: 'rel' };
    if (it.kind === 'todo' && it.due === null) return { ...it, due: day, date_basis: 'rel' };
    return it;
  });
}

/** 本机规则（预览“会记成这样”也用它；不花 AI 次数）。选中的日子交给本机规则（ParseOpts.defaultDay）；有没有把握只看原话（R9） */
export function planLocal(text: string, ctx: TypeCtx): { result: ParseResult; sure: boolean } {
  const opts = { ...(ctx.features ? { features: ctx.features } : {}), ...(ctx.day !== null ? { defaultDay: ctx.day } : {}) };
  const result = parseSplit(text, ctx.now, ctx.tz, ctx.locale, ctx.projects, opts);
  return { result, sure: confidence(result) === 'sure' };
}

const failOf = (e: unknown): SendFail => {
  if (e instanceof SendError) return e.fail;
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return 'timeout';
  if (e instanceof TypeError) return 'network';
  return 'http';
};

/** 浏览器明确说离线（navigator.onLine === false）才算离线；读不到当在线 */
export const navOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * 调一次 ai-parse（6 秒超时，网络错误自动重试 1 次）→ 结果。
 * 重试前浏览器已经明确说离线：不再重试（B3 前端A代码审 C4：不然断网时要等两个 6 秒才退回本机）
 */
export async function askAi(req: AiParseReq, call: CallAi, timeoutMs = AI_PARSE_TIMEOUT_MS, online: () => boolean = navOnline): Promise<AiOutcome> {
  for (let tried = 0; ; tried++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    try {
      return outcomeOf(await call(req, ac.signal));
    } catch (e) {
      const fail = ac.signal.aborted ? 'timeout' : failOf(e);
      if (!canAutoRetry(fail, tried) || !online()) return { kind: 'ai_failed', reason: fail };
    } finally {
      clearTimeout(timer);
    }
  }
}

const cutText = (s: string): string => [...s].slice(0, AI_TEXT_MAX).join('');

/** 整个打字流程（不保存；保存交给 capture-save） */
export async function planTyped(text: string, ctx: TypeCtx, env: TypeEnv, call: CallAi): Promise<TypePlan> {
  const { result, sure } = planLocal(text, ctx);
  const local = (status: TypeStatus, aiReason: string | null = null, quotaLeft: number | null = null): TypePlan => ({
    status, origin: 'rule', items: result.items, hints: result.hints, quotaLeft, aiReason,
  });
  if (sure) return local('saved');
  if (!env.online) return local('offline_saved');
  if (env.quotaOut) return local('quota_out');
  if (!env.aiOn) return local('saved');
  // 选中的日子超出后端认的范围：发了也是 400，不调 AI、不花次数，直接用本机结果（记到选中那天）；不是“AI 没回应”，不出那句提示
  const dd = ctx.day === null ? null : checkDefaultDay(ctx.day, ctx.now, ctx.tz);
  if (dd === 'bad') return local('saved', 'bad_default_day');
  const req: AiParseReq = {
    text: cutText(text), now: ctx.now, tz: ctx.tz, locale: ctx.locale, projects: normProjects(ctx.projects), scope: 'main', ...(dd !== null ? { default_day: dd } : {}),
  };
  const isOnline = env.isOnline ?? navOnline;
  const out = await askAi(req, call, AI_PARSE_TIMEOUT_MS, isOnline);
  switch (out.kind) {
    case 'record': {
      if (out.items.length === 0) return local('saved_rule', 'empty', out.quotaLeft);
      const hints: ParseHints = { recur: recurHint(text), arrange: arrangeHint(text), bad_day: null };
      return { status: 'saved', origin: 'ai', items: fillDay(out.items, ctx.day), hints, quotaLeft: out.quotaLeft, aiReason: null };
    }
    case 'quota_out':
      return local('quota_out', null, 0);
    case 'consent_required':
      return local('saved', 'consent_required');
    case 'fallback':
      if (out.reason === 'quota') return local('quota_out', out.reason, 0);
      // 功能没开、隐私记没开 AI：不是“AI 没回应”，不出那句提示
      if (out.reason === 'feature_off' || out.reason === 'vault_ai_off') return local('saved', out.reason);
      return local('saved_rule', out.reason);
    case 'ai_failed':
      // 发出去以后断了网（浏览器明确说离线）：和一开始就离线一样记（offline_saved），不出“AI 没回应”
      if (out.reason === 'network' && !isOnline()) return local('offline_saved', out.reason);
      return local('saved_rule', out.reason);
    default: {
      const never: never = out;
      return never;
    }
  }
}

/** 还有没有要用户先选的过去日子 */
export const needsConfirm = (items: readonly AiItem[]): boolean => items.some((it) => it.confirm !== null);

/** 确认行选了“补记今年（past）/ 明年（next）”：按选的改日期、去掉 confirm */
export function applyConfirm(item: AiItem, choice: 'past' | 'next'): AiItem {
  if (item.confirm === null) return item;
  const date = item.confirm[choice];
  if (item.kind === 'event') return { ...item, date, confirm: null };
  if (item.kind === 'todo') return { ...item, due: date, confirm: null };
  return { ...item, confirm: null };
}

/** 先存的（没有要问的）和要等用户选的（R-166：同一批里其他条照常保存，这一条等用户选） */
export function splitConfirm(items: readonly AiItem[]): { ready: AiItem[]; ask: AiItem[] } {
  return { ready: items.filter((it) => it.confirm === null), ask: items.filter((it) => it.confirm !== null) };
}

/** 标题最长（和编辑页 TITLE_MAX 一致） */
export const MERGE_TITLE_MAX = 160;

/**
 * “拆错了，合并成一条”（架构 5.1）：整句原话当标题，类型、日子、时刻取第一条的；不带简称（原话不是 AI 起的简称）。
 * 调用方先整批撤销，再按新的一批存这一条
 */
export function mergeItems(items: readonly AiItem[], rawText: string): AiItem | null {
  const first = items[0];
  const title = [...rawText.trim()].slice(0, MERGE_TITLE_MAX).join('');
  if (!first || title === '') return null;
  return { ...first, title, short: null, body: null, confirm: null };
}

/** 切原话用的分隔（逗号、分号、句号、换行、“然后 / 还有 / 그리고”）：和本机规则拆句同一套（shared/logic/parse/split.ts，
 *  A20 词表只放那里），只用来找等确认那条在原话里的位置 */

const same = (a: AiItem, b: AiItem): boolean =>
  a.kind === b.kind && a.title === b.title && a.time === b.time && JSON.stringify(a.confirm) === JSON.stringify(b.confirm);

/**
 * 确认行没选就关掉（R-166 补充，主持人 11-07 定）：从原话里去掉已经存了的那几条，只留等确认那几条的原文。
 * 按分隔切段，每条等确认的标题只落在一段里、那段里没有已存的标题；它前面紧挨着的没有标题的段（只说了日子、时刻）一起留下。
 * 留下的字再用本机规则解析一遍（parse），得出来的必须和等确认的几条一样（类型、标题、时刻、要问的日子），才算去干净；
 * 去不干净（AI 改过标题、一段里列了几件、日子是从前一句带过来的……）返回 null，调用方原话整句留着并提示
 */
export function keepAsked(raw: string, saved: readonly AiItem[], asked: readonly AiItem[], parse: (text: string) => readonly AiItem[]): string | null {
  if (saved.length === 0) return raw;
  const segs: string[] = [];
  const from: number[] = [];
  let at = 0;
  for (const m of raw.matchAll(clauseSeparators())) {
    segs.push(raw.slice(at, m.index));
    from.push(at);
    at = m.index + m[0].length;
  }
  segs.push(raw.slice(at));
  from.push(at);
  const all = [...saved, ...asked];
  const hits = (title: string): number[] => segs.flatMap((s, i) => (title !== '' && s.includes(title) ? [i] : []));
  const titled = (i: number): boolean => all.some((it) => it.title !== '' && (segs[i] ?? '').includes(it.title));
  const used = new Set<number>();
  for (const it of saved) {
    const h = hits(it.title);
    if (h.length === 0) return null;
    for (const i of h) used.add(i);
  }
  const keep = new Set<number>();
  for (const it of asked) {
    const h = hits(it.title);
    const i = h[0];
    if (h.length !== 1 || i === undefined || used.has(i)) return null;
    keep.add(i);
    for (let j = i - 1; j >= 0 && !titled(j) && (segs[j] ?? '').trim() !== ''; j -= 1) keep.add(j);
  }
  // 留下的几段在原话里挨着：截原话那一段（带着原来的逗号）；不挨着用空格拼
  const idx = [...keep].sort((a, b) => a - b);
  const lo = idx[0] ?? 0;
  const hi = idx[idx.length - 1] ?? 0;
  const text = hi - lo === idx.length - 1
    ? raw.slice(from[lo], (from[hi] ?? 0) + (segs[hi] ?? '').length).trim()
    : idx.map((i) => (segs[i] ?? '').trim()).filter(Boolean).join(' ');
  const again = parse(text);
  if (again.length !== asked.length || again.some((it, k) => !same(it, asked[k] as AiItem))) return null;
  return text;
}
