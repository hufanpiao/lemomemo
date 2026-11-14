// “＋”的意图：AI 输出的校验和规整、函数返回结构（架构 5.14 第 2、3、7 点；0.29 续第 154～165、168 条；B4b-3）。
// 本机规则（shared/logic/parse/intent.ts 的 localIntent）、ai-parse、ai-voice（经 shared/schema/ai.ts 的 checkParseOutput、checkVoiceOutput）、
// 客户端 outcomeOf 共用这一份。A20：字符串里不放汉字。
//
// 规整口径（AI 给的不合格就规整，规整不了才整份拒收）：
//   query：kinds 只认 event、todo、note（别的丢掉，丢完为空就是三种都查）；text 去控制字符、截 100 字；
//     range 的两个日子必须格式对、存在、在今天前后 5 年以内（不然整份拒收）；from 为 null =“截止到 to”，只配 kinds [todo]、done open，
//     别的组合规整成这样（续第 165 条），to 为 null 的规整为今天；from 有值 to 为 null 的当单日；from 晚于 to 的两头对调。
//   target：kinds 只认 event、todo（别的丢掉；取消、改期丢完为空就两种都看）；完成只认 todo，去掉 event 后为空整份拒收；
//     all 只给改期，取消、完成带了就去掉；with_overdue 为 true 而 date 为 null 的 date 规整为今天；text 截 60 字。
//   to：只有改期才有，date、time 都为 null 的整份拒收；别的意图带了就丢掉。
//   items：只有 record 才有，别的意图带了一律丢掉（AI 只解析条件，不生成列表）。
// 批量判定（all）不在这里：客户端拿到以后和本机规则一样过 shared/logic/parse/resolve-target.ts 的 resolveTarget（本机和 AI 走同一个函数）。
import { z } from 'zod';
import { todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import type { PlusTarget, TargetIntent, TargetKind } from '../logic/parse/resolve-target.ts';
import { DATE_FMT_RE, dateExists, inIntentRange } from '../logic/parse/past-date.ts';
import { INTENT_KINDS, type IntentKind } from './kinds.ts';

/** “＋”的意图（主枚举，0.29 续第 168 条） */
export const PLUS_INTENTS = ['record', 'search', 'summarize', 'cancel', 'reschedule', 'complete'] as const;
export type PlusIntent = (typeof PLUS_INTENTS)[number];
export const QUERY_INTENTS = ['search', 'summarize'] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];
export const TARGET_INTENTS = ['cancel', 'reschedule', 'complete'] as const satisfies readonly TargetIntent[];
export const QUERY_DONE = ['open', 'done', 'any'] as const;
export type QueryDone = (typeof QUERY_DONE)[number];
/** AI 的 confidence 低于这个算模糊（架构 5.14 第 2 点）：先按记下保存，再给查找结果 */
export const INTENT_SURE_MIN = 0.6;
export const QUERY_TEXT_MAX = 100;
export const TARGET_TEXT_MAX = 60;

export interface PlusQuery {
  text: string;
  /** from 为 null：截止到 to 为止（只配 kinds [todo]、done open） */
  range: { from: DateStr | null; to: DateStr } | null;
  kinds: IntentKind[];
  done: QueryDone;
}
/** 改期改到哪天几点（只说时刻的 date 为 null，日子不变） */
export interface PlusTo {
  date: DateStr | null;
  time: string | null;
}

// eslint-disable-next-line no-control-regex -- 去掉控制字符（C0、DEL、C1）和双向覆盖字符（同 ai.ts 的 stripCtlLine）
const CTL = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;
const cleanText = (s: string, max: number): string => [...s.replace(CTL, '').trim()].slice(0, max).join('').trim();
const dateFmt = z.string().regex(DATE_FMT_RE);
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const TARGET_KINDS = ['event', 'todo'] as const satisfies readonly TargetKind[];

// ---------- AI 输出（宽松读，规整在下面） ----------

export const queryRaw = z.strictObject({
  text: z.string().optional(),
  range: z.strictObject({ from: dateFmt.nullable().optional(), to: dateFmt.nullable().optional() }).nullable().optional(),
  kinds: z.array(z.string()).max(10).optional(),
  done: z.enum(QUERY_DONE).optional(),
});
export const targetRaw = z.strictObject({
  text: z.string().optional(),
  date: dateFmt.nullable().optional(),
  time: hm.nullable().optional(),
  kinds: z.array(z.string()).max(10).optional(),
  with_overdue: z.boolean().optional(),
  all: z.boolean().optional(),
});
export const toRaw = z.strictObject({ date: dateFmt.nullable().optional(), time: hm.nullable().optional() });
/** 顶层多出来的几个键（ai.ts 的 aiParseRaw、aiVoiceRaw 并进去） */
export const intentRawShape = {
  intent: z.enum(PLUS_INTENTS).optional(),
  confidence: z.number().optional(),
  query: queryRaw.nullable().optional(),
  target: targetRaw.nullable().optional(),
  to: toRaw.nullable().optional(),
};
export type QueryRaw = z.infer<typeof queryRaw>;
export type TargetRaw = z.infer<typeof targetRaw>;
export type ToRaw = z.infer<typeof toRaw>;

/** 规整不了的原因（并进 ai.ts 的 InvalidReason）：bad_date 日子不存在，out_of_range 不在前后 5 年，schema 缺 target / to 全空 / 完成没有待办 */
export type IntentInvalid = 'bad_date' | 'out_of_range' | 'schema';
export type Norm<T> = { ok: true; value: T; fixed: boolean } | { ok: false; reason: IntentInvalid };

/** 一个日子：没给为 null；给了要存在、在前后 5 年以内 */
function day(v: string | null | undefined, today: DateStr): { ok: true; v: DateStr | null } | { ok: false; reason: IntentInvalid } {
  if (v === null || v === undefined) return { ok: true, v: null };
  if (!dateExists(v)) return { ok: false, reason: 'bad_date' };
  return inIntentRange(v, today) ? { ok: true, v } : { ok: false, reason: 'out_of_range' };
}

const pickKinds = <K extends string>(given: readonly string[] | undefined, allowed: readonly K[]): K[] =>
  allowed.filter((k) => (given ?? []).includes(k));

/** 查找、总结的条件（规整口径见文件头）；fixed：改动过 AI 给的值（评测另计规整次数） */
export function normQuery(raw: QueryRaw | null | undefined, today: DateStr): Norm<PlusQuery> {
  const q = raw ?? {};
  let fixed = raw === null || raw === undefined;
  const given = pickKinds(q.kinds, INTENT_KINDS);
  if (q.kinds !== undefined && given.length !== q.kinds.length) fixed = true;
  let kinds: IntentKind[] = given.length > 0 ? given : [...INTENT_KINDS];
  let done: QueryDone = q.done ?? 'any';
  let range: PlusQuery['range'] = null;
  if (q.range) {
    const f = day(q.range.from, today);
    if (!f.ok) return f;
    const t = day(q.range.to, today);
    if (!t.ok) return t;
    if (f.v === null) {
      if (kinds.length !== 1 || kinds[0] !== 'todo' || done !== 'open' || t.v === null) fixed = true;
      kinds = ['todo'];
      done = 'open';
      range = { from: null, to: t.v ?? today };
    } else {
      const to = t.v ?? f.v;
      range = f.v <= to ? { from: f.v, to } : { from: to, to: f.v };
      if (t.v === null || f.v > to) fixed = true;
    }
  }
  return { ok: true, value: { text: cleanText(q.text ?? '', QUERY_TEXT_MAX), range, kinds, done }, fixed };
}

/** 取消、改期、完成的 target 和 to（规整口径见文件头）；target 缺了整份拒收 */
export function normTarget(intent: TargetIntent, raw: TargetRaw | null | undefined, rawTo: ToRaw | null | undefined, today: DateStr): Norm<{ target: PlusTarget; to: PlusTo | null }> {
  if (!raw) return { ok: false, reason: 'schema' };
  let fixed = false;
  const d = day(raw.date, today);
  if (!d.ok) return d;
  let kinds: TargetKind[] = pickKinds(raw.kinds, TARGET_KINDS);
  if (raw.kinds !== undefined && kinds.length !== raw.kinds.length) fixed = true;
  if (intent === 'complete') {
    // 只给了日程（去掉以后没有待办）整份拒收；一样都没给的按待办
    if (kinds.length > 0 && !kinds.includes('todo')) return { ok: false, reason: 'schema' };
    if (kinds.includes('event')) fixed = true;
    kinds = ['todo'];
  } else if (kinds.length === 0) {
    kinds = [...TARGET_KINDS];
  }
  const overdue = raw.with_overdue === true;
  const date = overdue && d.v === null ? today : d.v;
  if (date !== d.v) fixed = true;
  const all = intent === 'reschedule' && raw.all === true;
  if (raw.all === true && !all) fixed = true;
  const target: PlusTarget = {
    text: cleanText(raw.text ?? '', TARGET_TEXT_MAX), date, time: raw.time ?? null, kinds,
    ...(overdue ? { with_overdue: true } : {}), ...(all ? { all: true } : {}),
  };
  if (intent !== 'reschedule') return { ok: true, value: { target, to: null }, fixed: fixed || (rawTo !== null && rawTo !== undefined) };
  const td = day(rawTo?.date, today);
  if (!td.ok) return td;
  const to: PlusTo = { date: td.v, time: rawTo?.time ?? null };
  if (to.date === null && to.time === null) return { ok: false, reason: 'schema' };
  return { ok: true, value: { target, to }, fixed };
}

/** AI 的 confidence 规整到 0～1（没给按 1：B3 起 record 的老口径） */
export const normConfidence = (c: number | undefined): number => (c === undefined || !Number.isFinite(c) ? 1 : Math.min(1, Math.max(0, c)));

/** 校验以后、非 record 意图的结果（ai.ts 的 checkParseOutput / checkVoiceOutput 交出） */
export type IntentChecked =
  | { intent: QueryIntent; confidence: number; query: PlusQuery; fixed: boolean }
  | { intent: TargetIntent; confidence: number; target: PlusTarget; to: PlusTo | null; fixed: boolean };

/** 非 record 的那一段：intent、confidence 已读出（items 由调用方丢掉） */
export function normIntent(
  intent: Exclude<PlusIntent, 'record'>,
  raw: { confidence?: number | undefined; query?: QueryRaw | null | undefined; target?: TargetRaw | null | undefined; to?: ToRaw | null | undefined },
  now: number,
  tz: Tz,
): { ok: true; value: IntentChecked } | { ok: false; reason: IntentInvalid } {
  const today = todayOf(now, tz);
  const confidence = normConfidence(raw.confidence);
  if (intent === 'search' || intent === 'summarize') {
    const q = normQuery(raw.query, today);
    return q.ok ? { ok: true, value: { intent, confidence, query: q.value, fixed: q.fixed } } : q;
  }
  const t = normTarget(intent, raw.target, raw.to, today);
  return t.ok ? { ok: true, value: { intent, confidence, target: t.value.target, to: t.value.to, fixed: t.fixed } } : t;
}

// ---------- 函数返回结构（ai-parse、ai-voice 成功时；客户端 outcomeOf 按这里校验） ----------

const confidenceOut = z.number().min(0).max(1);
export const queryOut = z.strictObject({
  text: z.string().max(QUERY_TEXT_MAX * 2),
  range: z.strictObject({ from: dateFmt.nullable(), to: dateFmt }).nullable(),
  kinds: z.array(z.enum(INTENT_KINDS)).min(1).max(INTENT_KINDS.length),
  done: z.enum(QUERY_DONE),
});
export const targetOut = z.strictObject({
  text: z.string().max(TARGET_TEXT_MAX * 2),
  date: dateFmt.nullable(),
  time: hm.nullable(),
  kinds: z.array(z.enum(TARGET_KINDS)).min(1).max(TARGET_KINDS.length),
  with_overdue: z.boolean().optional(),
  all: z.boolean().optional(),
});
export const toOut = z.strictObject({ date: dateFmt.nullable(), time: hm.nullable() });

/** 查找、总结：{intent, confidence, query, quota_left}（ai-voice 多 transcript） */
export const queryResponse = z.strictObject({
  intent: z.enum(QUERY_INTENTS),
  confidence: confidenceOut,
  query: queryOut,
  quota_left: z.number().int().min(0),
  transcript: z.string().optional(),
});
/** 取消、改期、完成：{intent, confidence, target, to, quota_left}（to 只有改期才不为 null；ai-voice 多 transcript） */
export const targetResponse = z.strictObject({
  intent: z.enum(TARGET_INTENTS),
  confidence: confidenceOut,
  target: targetOut,
  to: toOut.nullable(),
  quota_left: z.number().int().min(0),
  transcript: z.string().optional(),
});
export type QueryResponse = z.infer<typeof queryResponse>;
export type TargetResponse = z.infer<typeof targetResponse>;
