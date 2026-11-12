// AI 输出的二次校验和“＋”识别接口的类型（架构第 7 节“输出结构”“校验的几条口径”、5.1、5.11；0.29 续第 36、58、67～71、124、133 条；
// B3 任务单 BE-3、Q2、接口先定第 1、4 条）。ai-parse、ai-voice、claude-intake、评测 tests/ai/run.ts（经 parseWithAI）共用这一份；
// 前端只 import 类型和 recordResponse 等返回结构，不改这里。A20：字符串里不放汉字。
//
// 校验顺序（0.29 续第 68 条）：
//   ① 结构：只认白名单里的键（多一个键 not_whitelisted；AI 自己带的 confirm 先丢掉、由这里重算，TC-B3-42）、items ≤ 10、
//      日期只查格式（YYYY-MM-DD，月 01～12、日 01～31）、short ≤ 2 个字形簇（超了 out_of_range）、anniv.year 1900～2100；
//      日程有 date、待办有 due 而 date_basis 缺或为 null 打 missing_date_basis（superRefine，带 params.reason）；
//      日子为 null 而 basis 有值算 schema；
//   ② kind 必须在这个人能用的类型里（featureOn 算好的 features），不在算 not_whitelisted、整份退回；
//   ③ 字段和 kind 对不上的清成 null、不整份拒收（纪念日的 date、due、time、short，随手记的 short、date、due、time；
//      待办的 time 不清，它是截止时刻）；
//   ④ 待办给了 time 没给 due：补 due = 今天（调用方传了默认日子就是那一天）、date_basis = rel（数据库要求有 due_time 必须有 due）；
//      调用方传了默认日子（日历页选中的，R-353、R6）时，日程没给 date、待办没给 due 的也补成那一天、date_basis = rel；
//   ⑤ 按 basis 重配、查存在不存在、加 confirm（shared/logic/parse/past-date.ts，和本机规则同一个函数）；
//   ⑥ 查“今天前 1 年到后 5 年”。
// 整份拒收只用于结构不合格、键不在白名单、取值超范围、日子不存在；ai.ts 不替 AI 改类型（R-165、R-195、续第 151 条）。
// 空列表（R7）：文字的 items 为空算 empty；录音的 transcript 为空回空结果（没听清，客户端按 no_speech），transcript 不空而 items 为空算 empty。
import { z } from 'zod';
import { todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import { DATE_BASES, DATE_FMT_RE, dateExists, inAiRange, pastDate, type Confirm, type DateBasis } from '../logic/parse/past-date.ts';
import { graphemeCount, SHORT_GRAPHEMES } from '../logic/short.ts';
import { AI_KINDS, type AiKind } from './kinds.ts';

/** 一次最多几条（第 7 节） */
export const AI_MAX_ITEMS = 10;
/** 原话、转写最长多少字（防提示注入第 2 条：截到 2000 字） */
export const AI_TEXT_MAX = 2000;
/** projects[]：最多几个、每个最长几个字（第 6 节 ai-parse；任务单 M3） */
export const AI_PROJECTS_MAX = 30;
export const AI_PROJECT_LEN = 40;
/** 一段录音最多多少字节（架构 5.11 第 2 点）：前端录音器超了就不交出；服务器 ai-voice、voice-probe
 *  读请求体也用这一份（各自的 index.ts 从 _shared/gen/ 注入，超了回 413） */
export const AI_AUDIO_MAX_BYTES = 600 * 1024;
/** 录音能交出、服务器 ai-voice 和 voice-probe 能收的 Content-Type（去掉参数、转小写以后比）：前端录音器和两个函数都用这一份 */
export const AUDIO_TYPES = ['audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/webm'] as const;
export type AudioType = (typeof AUDIO_TYPES)[number];
/** Content-Type 去掉参数、转小写（audio/mp4;codecs=mp4a.40.2 → audio/mp4）；没有就是空串 */
export function bareMime(ct: string | null | undefined): string {
  return (ct ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}
/** 去掉参数、转小写以后在 AUDIO_TYPES 里就返回它，不在返回 null（audio/webm;codecs=opus → audio/webm） */
export function audioType(ct: string | null | undefined): AudioType | null {
  const base = bareMime(ct);
  return (AUDIO_TYPES as readonly string[]).includes(base) ? (base as AudioType) : null;
}

/** B3 运行时只有 record（Q2）；B4b-3 放开枚举就改这一处 */
export const INTENTS = ['record'] as const;
export type Intent = (typeof INTENTS)[number];

/** 校验失败的原因（第 7 节 InvalidReason） */
export const INVALID_REASONS = ['missing_date_basis', 'bad_date', 'not_whitelisted', 'out_of_range', 'schema', 'empty'] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

export const ANNIV_TYPES = ['birthday', 'anniversary', 'countdown'] as const;

const codepoints = (s: string): number => [...s].length;
const dateFmt = z.string().regex(DATE_FMT_RE);
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** 按码点数的长度上限（和数据库 char_length 一致；超了算 out_of_range） */
const maxCp = (n: number) => z.string().refine((s) => codepoints(s) <= n, { params: { reason: 'out_of_range' } });

/** 安全审建议 5：AI 输出和 claude-intake 收到的 title、project、short 去掉控制字符和双向覆盖字符；
 *  body 是多行正文，留换行和制表符，其余同样去掉。先去再量长度、再判空 */
// eslint-disable-next-line no-control-regex -- 就是要去掉控制字符（C0、DEL、C1）和双向覆盖字符
const CTL_LINE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex -- 同上，留换行和制表符
const CTL_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
export const stripCtlLine = (s: string): string => s.replace(CTL_LINE, '');
export const stripCtlText = (s: string): string => s.replace(CTL_TEXT, '');

const annivRaw = z.strictObject({
  type: z.enum(ANNIV_TYPES),
  calendar: z.enum(['solar', 'lunar']),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  is_leap: z.boolean().optional(),
  year: z.number().int().min(1900).max(2100).nullable().optional(),
});

/** AI 输出的一条（第 7 节 parse 结构）；除 kind、title 外的键可以缺，缺了按 null（important 按 false） */
const itemRaw = z
  .strictObject({
    kind: z.enum(AI_KINDS),
    title: z.string().transform(stripCtlLine).pipe(z.string().trim().min(1).pipe(maxCp(160))),
    date: dateFmt.nullable().optional(),
    time: hm.nullable().optional(),
    duration_min: z.number().int().min(1).max(1440).nullable().optional(),
    due: dateFmt.nullable().optional(),
    important: z.boolean().optional(),
    project: z.string().transform(stripCtlLine).pipe(maxCp(AI_PROJECT_LEN)).nullable().optional(),
    body: z.string().transform(stripCtlText).pipe(maxCp(AI_TEXT_MAX)).nullable().optional(),
    short: z.string().transform(stripCtlLine).nullable().optional(),
    date_basis: z.enum(DATE_BASES).nullable().optional(),
    anniv: annivRaw.nullable().optional(),
  })
  .superRefine((it, ctx) => {
    // 日程看 date、待办看 due（③ 会清掉对不上的列，所以按 kind 取）
    const col = it.kind === 'event' ? 'date' : it.kind === 'todo' ? 'due' : null;
    if (col !== null) {
      const day = (col === 'date' ? it.date : it.due) ?? null;
      const basis = it.date_basis ?? null;
      // 待办给了 time 没给 due：④ 会补今天和 rel，不算缺 basis
      const repaired = it.kind === 'todo' && day === null && (it.time ?? null) !== null;
      if (day !== null && basis === null) {
        ctx.addIssue({ code: 'custom', path: [col], message: 'missing_date_basis', params: { reason: 'missing_date_basis' } });
      } else if (day === null && basis !== null && !repaired) {
        ctx.addIssue({ code: 'custom', path: ['date_basis'], message: 'basis_without_date' });
      }
    }
    if (it.kind === 'anniv' && !it.anniv) ctx.addIssue({ code: 'custom', path: ['anniv'], message: 'anniv_required' });
    const s = it.short ?? null;
    if (s !== null && s.trim() !== '' && graphemeCount(s.trim()) > SHORT_GRAPHEMES) {
      ctx.addIssue({ code: 'custom', path: ['short'], message: 'short_too_long', params: { reason: 'out_of_range' } });
    }
  });

/** ai-parse、claude-intake 的 AI 输出：{items} */
export const aiParseRaw = z.strictObject({ items: z.array(itemRaw).max(AI_MAX_ITEMS) });
/** ai-voice 的 AI 输出：{transcript, items}（transcript 存进各条的 raw_text） */
export const aiVoiceRaw = z.strictObject({ transcript: z.string().pipe(maxCp(AI_TEXT_MAX)), items: z.array(itemRaw).max(AI_MAX_ITEMS) });

export interface AiAnniv {
  type: (typeof ANNIV_TYPES)[number];
  calendar: 'solar' | 'lunar';
  month: number;
  day: number;
  is_leap: boolean;
  year: number | null;
}

/** 校验以后的一条（本机规则 shared/logic/parse/ 的输出用同一结构）。待办的截止时刻也叫 time，存库时才映射成 due_time（capture-map.ts） */
export interface AiItem {
  kind: AiKind;
  title: string;
  date: DateStr | null;
  time: string | null;
  duration_min: number | null;
  due: DateStr | null;
  important: boolean;
  project: string | null;
  body: string | null;
  short: string | null;
  date_basis: DateBasis | null;
  anniv: AiAnniv | null;
  /** 派生字段：过去的月日、几号要先问（R-166），不是 AI 的键 */
  confirm: Confirm | null;
}

export interface AiCheckCtx {
  now: number;
  tz: Tz;
  /** featureOn 算好的、这个人能用的类型 */
  features: readonly AiKind[];
  /** 日历页选中的那天（R6；已过 checkDefaultDay）；不传时没说日子的待办 due 留空 */
  defaultDay?: DateStr | undefined;
}

export type AiCheck<T> =
  | { ok: true; value: T }
  | { ok: false; invalid_reasons: InvalidReason[]; issues: z.core.$ZodIssue[] };

/** zod 的问题归到第 7 节的几种原因（自定义 issue 看 params.reason） */
export function reasonOf(issue: z.core.$ZodIssue): InvalidReason {
  if (issue.code === 'custom') {
    const r = (issue as { params?: { reason?: unknown } }).params?.reason;
    return (INVALID_REASONS as readonly unknown[]).includes(r) ? (r as InvalidReason) : 'schema';
  }
  if (issue.code === 'unrecognized_keys') return 'not_whitelisted';
  if (issue.code === 'too_big' || issue.code === 'too_small') return 'out_of_range';
  // 嵌套在 pipe、union 里的问题：取第一层能认出来的
  return 'schema';
}

const fail = (reasons: InvalidReason[], issues: z.core.$ZodIssue[] = []) =>
  ({ ok: false as const, invalid_reasons: [...new Set(reasons)], issues });

/** 去掉 AI 自己带的 confirm 键（TC-B3-42：不采用 AI 给的值，由这里重算）；别的多余键照样算 not_whitelisted */
function dropConfirm(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o['items'])) return raw;
  return {
    ...o,
    items: o['items'].map((it: unknown) => {
      if (typeof it !== 'object' || it === null || Array.isArray(it)) return it;
      const { confirm: _drop, ...rest } = it as Record<string, unknown>;
      return rest;
    }),
  };
}

type ItemIn = z.infer<typeof itemRaw>;

/** ③④：清掉和 kind 对不上的字段、补待办的今天 */
function normalize(it: ItemIn, today: DateStr, dflt: DateStr | null): Omit<AiItem, 'confirm'> {
  const short = it.short?.trim() ? it.short.trim() : null;
  const base: Omit<AiItem, 'confirm'> = {
    kind: it.kind,
    title: it.title,
    date: it.date ?? null,
    time: it.time ?? null,
    duration_min: it.duration_min ?? null,
    due: it.due ?? null,
    important: it.important ?? false,
    project: it.project?.trim() ? it.project.trim() : null,
    body: it.body?.trim() ? it.body : null,
    short,
    date_basis: it.date_basis ?? null,
    anniv: it.anniv ? { ...it.anniv, is_leap: it.anniv.calendar === 'lunar' ? (it.anniv.is_leap ?? false) : false, year: it.anniv.year ?? null } : null,
  };
  switch (it.kind) {
    case 'event': {
      const e = { ...base, due: null, anniv: null };
      if (dflt !== null && e.date === null) return { ...e, date: dflt, date_basis: 'rel' };
      return e;
    }
    case 'todo': {
      const t = { ...base, date: null, duration_min: null, anniv: null };
      if (t.due === null && (dflt !== null || t.time !== null)) return { ...t, due: dflt ?? today, date_basis: 'rel' };
      return t;
    }
    case 'note':
      return { ...base, date: null, due: null, time: null, short: null, duration_min: null, date_basis: null, anniv: null };
    case 'anniv':
      return { ...base, date: null, due: null, time: null, short: null, duration_min: null, date_basis: null };
    default: {
      const never: never = it.kind;
      return never;
    }
  }
}

function checkItems(items: ItemIn[], ctx: AiCheckCtx): AiCheck<AiItem[]> {
  const today = todayOf(ctx.now, ctx.tz);
  if (items.some((it) => !ctx.features.includes(it.kind))) return fail(['not_whitelisted']);
  const out: AiItem[] = [];
  const reasons: InvalidReason[] = [];
  for (const it of items) {
    const r = pastDate(normalize(it, today, ctx.defaultDay ?? null), ctx.now, ctx.tz);
    if (r.ok) out.push(r.item);
    else reasons.push(r.reason);
  }
  return reasons.length ? fail(reasons) : { ok: true, value: out };
}

function structural(issues: z.core.$ZodIssue[]): AiCheck<never> {
  return fail(issues.map(reasonOf), issues);
}

/** ai-parse、claude-intake：校验 AI 的 {items} 输出 */
export function checkParseOutput(raw: unknown, ctx: AiCheckCtx): AiCheck<{ items: AiItem[] }> {
  const p = aiParseRaw.safeParse(dropConfirm(raw));
  if (!p.success) return structural(p.error.issues);
  if (p.data.items.length === 0) return fail(['empty']);   // R7 ①：退回次数，客户端走本机规则
  const r = checkItems(p.data.items, ctx);
  return r.ok ? { ok: true, value: { items: r.value } } : r;
}

/** ai-voice：校验 AI 的 {transcript, items} 输出 */
export function checkVoiceOutput(raw: unknown, ctx: AiCheckCtx): AiCheck<{ transcript: string; items: AiItem[] }> {
  const p = aiVoiceRaw.safeParse(dropConfirm(raw));
  if (!p.success) return structural(p.error.issues);
  // R7 ②：没听清（转写为空）照常算 1 次、回空结果；听清了却没拆出条目算失败、退回次数
  if (p.data.transcript.trim() === '') return { ok: true, value: { transcript: '', items: [] } };
  if (p.data.items.length === 0) return fail(['empty']);
  const r = checkItems(p.data.items, ctx);
  return r.ok ? { ok: true, value: { transcript: p.data.transcript, items: r.value } } : r;
}

// ---------- 请求入参（接口先定第 2 条） ----------

/** locale 规整成 zh / ko（ko 开头的是韩文，其余一律中文） */
export function normLocale(v: unknown): 'zh' | 'ko' {
  return typeof v === 'string' && /^ko\b/i.test(v.trim()) ? 'ko' : 'zh';
}

/** projects[]：只留字符串、去空白、去重，每个截到 40 字，最多 30 个（多了截断，不拒收） */
export function normProjects(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string') continue;
    const s = [...p.trim()].slice(0, AI_PROJECT_LEN).join('');
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= AI_PROJECTS_MAX) break;
  }
  return out;
}

/** ai-parse 的请求体 */
export const aiParseRequest = z.object({
  text: z.string().min(1).pipe(maxCp(AI_TEXT_MAX)),
  now: z.number().int().positive(),
  tz: z.string().min(1).max(64),
  locale: z.string().max(16).optional(),
  projects: z.array(z.unknown()).max(200).optional(),
  scope: z.enum(['main', 'vault']).optional(),
  default_day: z.string().max(16).optional(),
});

/** 默认日子（R6：ai-parse 请求体 default_day、ai-voice 请求头 X-Default-Day）：不传回 null；
 *  传了要格式对、这一天存在、在今天（按 now、tz）前 1 年到后 5 年之内，否则 'bad'（调用方回 400） */
export function checkDefaultDay(v: unknown, now: number, tz: Tz): DateStr | null | 'bad' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !DATE_FMT_RE.test(v) || !dateExists(v)) return 'bad';
  return inAiRange(v, todayOf(now, tz)) ? v : 'bad';
}

// ---------- 返回结构（接口先定第 4 条；客户端按这里校验，不认识的 intent 当 ai_failed，Q2 ②） ----------

const confirmOut = z.strictObject({ past: dateFmt, next: dateFmt });
const itemOut = z.strictObject({
  kind: z.enum(AI_KINDS),
  title: z.string().min(1),
  date: dateFmt.nullable(),
  time: hm.nullable(),
  duration_min: z.number().int().nullable(),
  due: dateFmt.nullable(),
  important: z.boolean(),
  project: z.string().nullable(),
  body: z.string().nullable(),
  short: z.string().nullable(),
  date_basis: z.enum(DATE_BASES).nullable(),
  anniv: z.strictObject({
    type: z.enum(ANNIV_TYPES), calendar: z.enum(['solar', 'lunar']), month: z.number().int(), day: z.number().int(),
    is_leap: z.boolean(), year: z.number().int().nullable(),
  }).nullable(),
  confirm: confirmOut.nullable(),
});

/** 识别成功：{intent, confidence, items, quota_left}（ai-voice 多 transcript） */
export const recordResponse = z.strictObject({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  items: z.array(itemOut).max(AI_MAX_ITEMS),
  quota_left: z.number().int().min(0),
  transcript: z.string().optional(),
});
export type RecordResponse = z.infer<typeof recordResponse>;

/** 退回本机规则的原因（客户端只看有没有 fallback，原因给日志和提示条选文案） */
export const FALLBACK_REASONS = ['invalid', 'timeout', 'error', 'quota', 'feature_off', 'vault_ai_off'] as const;

export const aiResponse = z.union([
  recordResponse,
  z.strictObject({ fallback: z.literal(true), reason: z.enum(FALLBACK_REASONS) }),
  z.strictObject({ consent_required: z.literal(true) }),
  z.strictObject({ quota_out: z.literal(true), quota_left: z.literal(0) }),
  z.strictObject({ ai_failed: z.literal(true), reason: z.enum(FALLBACK_REASONS) }),
]);
export type AiResponse = z.infer<typeof aiResponse>;

/** B3 服务器包外层时的 confidence：模型不判断意图（Q2），校验通过就是 1 */
export const RECORD_CONFIDENCE = 1;
