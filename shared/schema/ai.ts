// AI 输出的二次校验和“＋”识别接口的类型（架构第 7 节“输出结构”“校验的几条口径”、5.1、5.11；0.29 续第 36、58、67～71、124、133 条；
// B3 任务单 BE-3、Q2、接口先定第 1、4 条）。ai-parse、ai-voice、claude-intake、评测 tests/ai/run.ts（经 parseWithAI）共用这一份；
// 前端只 import 类型和 recordResponse 等返回结构，不改这里。A20：字符串里不放汉字。
//
// 校验顺序（0.29 续第 68 条）：
//   ① 结构：只认白名单里的键（多一个键 not_whitelisted；AI 自己带的 confirm 先丢掉、由这里重算，TC-B3-42）、items ≤ 10、
//      日期只查格式（YYYY-MM-DD，月 01～12、日 01～31）、anniv.year 1900～2100；
//      日程有 date、待办有 due 而 date_basis 缺或为 null 打 missing_date_basis（superRefine，带 params.reason）；
//      日子为 null 而 basis 有值算 schema；
//   ② kind 必须在这个人能用的类型里（featureOn 算好的 features），不在算 not_whitelisted、整份退回；
//   ②′ 日程、待办的日子和时刻（11-25 起）：AI 原样抄出的 date_said、time_said 用本机规则换算（shared/logic/parse/said-when.ts），
//      换算得出来覆盖 AI 自己算的 date / due（连同 date_basis）、time，换算不出来用 AI 的；这两个键不进 AiItem、不回给客户端；
//   ③ 字段和 kind 对不上的清成 null、不整份拒收（纪念日的 date、due、time、short，随手记的 short、date、due、time；
//      待办的 time 不清，它是截止时刻）；short 超过 SHORT_GRAPHEMES 个字形簇（R-446 起 4 个）也清成 null（11-16 测试集 ① 第 4 次：
//      当时上限 2，韩文“영수증”“배드민턴”整份被拒、整句退回本机规则；short 只是月历标签，清掉后照 R-104、R-446 按标题取，条目本身没错，不该连累整句）；
//   ④ 待办给了 time 没给 due：补 due = 今天（调用方传了默认日子就是那一天）、date_basis = rel（数据库要求有 due_time 必须有 due）；
//      调用方传了默认日子（日历页选中的，R-353、R6）时，日程没给 date、待办没给 due 的也补成那一天、date_basis = rel；
//   ⑤ 按 basis 重配、查存在不存在、加 confirm（shared/logic/parse/past-date.ts，和本机规则同一个函数）；
//   ⑥ 查“今天前 1 年到后 5 年”。
// 整份拒收只用于结构不合格、键不在白名单、取值超范围、日子不存在；ai.ts 不替 AI 改类型（R-165、R-195、续第 151 条）。
// 空列表（R7）：文字的 items 为空算 empty；录音的 transcript 为空回空结果（没听清，客户端按 no_speech），transcript 不空而 items 为空算 empty。
// 意图（B4b-3，架构 5.14 第 2、7 点）：顶层多 intent、confidence、query、target、to（intent.ts 的 intentRawShape，缺 intent 按 record）。
//   record：照上面 ①～⑥ 校验 items，交出 {intent: 'record', confidence, items}；
//   别的意图：items 不看、一律丢掉（AI 只解析条件，不生成列表），query / target / to 过 intent.ts 的 normIntent 规整，交出 IntentChecked；
//   规整不了的原因（bad_date、out_of_range、schema）就是这里的 InvalidReason。confidence 一律过 normConfidence（没给按 1）。
// claude-intake、评测只做记下：经 _shared/ai/parse-core.ts 的 recordOnly 把非 record 当 schema 拒收。
import { z } from 'zod';
import { todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';
import { DATE_BASES, DATE_FMT_RE, dateExists, inAiRange, pastDate, type Confirm, type DateBasis } from '../logic/parse/past-date.ts';
import { saidWhen } from '../logic/parse/said-when.ts';
import { graphemeCount, SHORT_GRAPHEMES } from '../logic/short.ts';
import { AI_KINDS, type AiKind } from './kinds.ts';
import { EVENT_DURATION_MAX } from './rows.ts';
import {
  intentRawShape, normConfidence, normIntent, PLUS_INTENTS, queryResponse, targetResponse,
  type IntentChecked, type IntentInvalid, type PlusIntent,
} from './intent.ts';

/** 一次最多几条（第 7 节） */
export const AI_MAX_ITEMS = 10;
/** 原话、转写最长多少字（防提示注入第 2 条：截到 2000 字） */
export const AI_TEXT_MAX = 2000;
/** projects[]：最多几个、每个最长几个字（第 6 节 ai-parse；任务单 M3） */
export const AI_PROJECTS_MAX = 30;
export const AI_PROJECT_LEN = 40;
/** examples[]（R-497 以前分进自建项目的几条）：最多几条、标题最长几个字（项目名同 AI_PROJECT_LEN）；录音走请求头，客户端编出来另有字节上限（ai-voice-api.ts） */
export const AI_EXAMPLES_MAX = 20;
export const AI_EXAMPLE_TITLE_LEN = 30;
/** 一条例子：标题 → 项目名 */
export interface ProjectExample {
  title: string;
  project: string;
}
/** 一段录音最多多少字节（架构 5.11 第 2 点）：前端录音器超了就不交出；服务器 ai-voice、voice-probe
 *  读请求体也用这一份（各自的 index.ts 从 _shared/gen/ 注入，超了回 413） */
export const AI_AUDIO_MAX_BYTES = 600 * 1024;
/** 前端录音码率（架构 5.11：直传按 AAC 32–64 kbps 算）：录满 60 秒约 360 KB，留足 AI_AUDIO_MAX_BYTES 的余量。
 *  只给前端录音器的调用方用（正式录音、开发用的录音探测页都传这一份，探测测的就是正式参数）；放 shared 是因为 app 层引不到功能层的 record-logic */
export const AI_AUDIO_BITS_PER_SECOND = 48_000;
/** 按住说话一段最长录多久（毫秒）：“＋”按住说话、AI 聊天按住提问同一个数（代码结构审查 11-25 第 9 条，原来两边各写一份 60_000） */
export const AI_AUDIO_MAX_MS = 60_000;
/** ai-voice 服务器等 Gemini 转写加解析的超时（架构 5.11 第 4 点；毫秒）。前端上传总超时的下限由它推出（record-logic 的 UPLOAD_MIN_MS）；
 *  服务器那边用 _shared/ai/params.ts 的同名常量（服务器函数不能直接引 shared），两边相等由 tests/shared/ai-schema.test.ts 钉住 */
export const VOICE_TIMEOUT_MS = 15_000;
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

/** “＋”的意图：B4b-3 起就是 intent.ts 的主枚举（0.29 续第 168 条） */
export const INTENTS = PLUS_INTENTS;
export type Intent = PlusIntent;

/** 校验失败的原因（第 7 节 InvalidReason） */
export const INVALID_REASONS = ['missing_date_basis', 'bad_date', 'not_whitelisted', 'out_of_range', 'schema', 'empty'] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];
/** 意图规整不了的原因必须都在 InvalidReason 里（编译期核对：intent.ts 多加一种原因而这里没加，这一行编译不过） */
const INTENT_REASONS_COVERED: IntentInvalid extends InvalidReason ? true : never = true;
void INTENT_REASONS_COVERED;

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
    duration_min: z.number().int().min(1).max(EVENT_DURATION_MAX).nullable().optional(),   // R-444：跨天的日程最多 31 天，同 events 表
    due: dateFmt.nullable().optional(),
    important: z.boolean().optional(),
    project: z.string().transform(stripCtlLine).pipe(maxCp(AI_PROJECT_LEN)).nullable().optional(),
    body: z.string().transform(stripCtlText).pipe(maxCp(AI_TEXT_MAX)).nullable().optional(),
    short: z.string().transform(stripCtlLine).nullable().optional(),
    date_basis: z.enum(DATE_BASES).nullable().optional(),
    anniv: annivRaw.nullable().optional(),
    // 11-25：AI 原样抄出的说日子、说时刻的字（said-when.ts 换算后覆盖 date / due、time）；只在这里用，不进 AiItem、不回给客户端、不写库。
    // 不卡长度（太长的 saidWhen 不认，用 AI 自己的），免得抄多了几个字连累整句被拒
    date_said: z.string().nullable().optional(),
    time_said: z.string().nullable().optional(),
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
  });

const itemsRaw = z.array(itemRaw).max(AI_MAX_ITEMS);
const transcriptRaw = z.string().pipe(maxCp(AI_TEXT_MAX));
/** ai-parse、claude-intake 的 AI 输出（record）：{items}，加意图的几个键（intent 缺省按 record） */
export const aiParseRaw = z.strictObject({ items: itemsRaw, ...intentRawShape });
/** ai-voice 的 AI 输出（record）：{transcript, items}（transcript 存进各条的 raw_text），加意图的几个键 */
export const aiVoiceRaw = z.strictObject({ transcript: transcriptRaw, items: itemsRaw, ...intentRawShape });
/** 先读顶层：键在不在白名单、意图的几个键对不对；items 等判出是 record 才校验（别的意图整个丢掉，里面写了什么都不看） */
const parseTop = z.strictObject({ items: z.unknown().optional(), ...intentRawShape });
const voiceTop = z.strictObject({ transcript: transcriptRaw, items: z.unknown().optional(), ...intentRawShape });

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
  const s = it.short?.trim() ?? '';
  const short = s !== '' && graphemeCount(s) <= SHORT_GRAPHEMES ? s : null;
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
    // 随手记、纪念日没有项目（notes、anniversaries 表都没有 project 列；R-440 提示词同样要求为 null），AI 给了也清掉
    case 'note':
      return { ...base, date: null, due: null, time: null, short: null, duration_min: null, project: null, date_basis: null, anniv: null };
    case 'anniv':
      return { ...base, date: null, due: null, time: null, short: null, duration_min: null, project: null, date_basis: null };
    default: {
      const never: never = it.kind;
      return never;
    }
  }
}

/** ③ 之前：日程、待办的日子和时刻按 AI 抄出的字用本机规则换算（said-when.ts；11-25 负责人“周五变成周日，后天变成明天”），
 *  换算得出来的覆盖 AI 自己算的，换算不出来用 AI 的；随手记、纪念日不看 */
function withSaid(it: ItemIn, ctx: AiCheckCtx): ItemIn {
  if (it.kind !== 'event' && it.kind !== 'todo') return it;
  const s = saidWhen(it.date_said, it.time_said, ctx.now, ctx.tz);
  const col = it.kind === 'event' ? 'date' : 'due';
  const day = s.day ? { [col]: s.day.date, date_basis: s.day.basis } : {};
  return { ...it, ...day, ...(s.time !== null ? { time: s.time } : {}) };
}

function checkItems(items: ItemIn[], ctx: AiCheckCtx): AiCheck<AiItem[]> {
  const today = todayOf(ctx.now, ctx.tz);
  if (items.some((it) => !ctx.features.includes(it.kind))) return fail(['not_whitelisted']);
  const out: AiItem[] = [];
  const reasons: InvalidReason[] = [];
  for (const it of items) {
    const r = pastDate(normalize(withSaid(it, ctx), today, ctx.defaultDay ?? null), ctx.now, ctx.tz);
    if (r.ok) out.push(r.item);
    else reasons.push(r.reason);
  }
  return reasons.length ? fail(reasons) : { ok: true, value: out };
}

function structural(issues: z.core.$ZodIssue[]): AiCheck<never> {
  return fail(issues.map(reasonOf), issues);
}

/** 校验以后的记下：items 是校验、规整过的条目，confidence 是 AI 给的（normConfidence，没给按 1） */
export interface RecordChecked {
  intent: 'record';
  confidence: number;
  items: AiItem[];
}
/** checkParseOutput 交出的：记下，或别的意图（intent.ts 的 IntentChecked） */
export type ParseChecked = RecordChecked | IntentChecked;
/** checkVoiceOutput 交出的：多一个 transcript */
export type VoiceChecked = ParseChecked & { transcript: string };

/** 非 record：丢掉 items，query / target / to 过 normIntent */
function checkIntent(intent: Exclude<PlusIntent, 'record'>, top: z.infer<typeof parseTop>, ctx: AiCheckCtx): AiCheck<IntentChecked> {
  const n = normIntent(intent, top, ctx.now, ctx.tz);
  return n.ok ? { ok: true, value: n.value } : fail([n.reason]);
}

/** ai-parse、claude-intake：校验 AI 的 {intent?, confidence?, items, query?, target?, to?} 输出 */
export function checkParseOutput(raw: unknown, ctx: AiCheckCtx): AiCheck<ParseChecked> {
  const pre = dropConfirm(raw);
  const top = parseTop.safeParse(pre);
  if (!top.success) return structural(top.error.issues);
  const intent = top.data.intent ?? 'record';
  if (intent !== 'record') return checkIntent(intent, top.data, ctx);
  const p = aiParseRaw.safeParse(pre);
  if (!p.success) return structural(p.error.issues);
  if (p.data.items.length === 0) return fail(['empty']);   // R7 ①：退回次数，客户端走本机规则
  const r = checkItems(p.data.items, ctx);
  return r.ok ? { ok: true, value: { intent: 'record', confidence: normConfidence(p.data.confidence), items: r.value } } : r;
}

/** ai-voice：校验 AI 的 {transcript, intent?, confidence?, items, query?, target?, to?} 输出 */
export function checkVoiceOutput(raw: unknown, ctx: AiCheckCtx): AiCheck<VoiceChecked> {
  const pre = dropConfirm(raw);
  const top = voiceTop.safeParse(pre);
  if (!top.success) return structural(top.error.issues);
  const confidence = normConfidence(top.data.confidence);
  // R7 ②：没听清（转写为空）照常算 1 次、回空结果（不管判的什么意图）；听清了却没拆出条目算失败、退回次数
  if (top.data.transcript.trim() === '') return { ok: true, value: { intent: 'record', confidence, transcript: '', items: [] } };
  const intent = top.data.intent ?? 'record';
  if (intent !== 'record') {
    const n = checkIntent(intent, top.data, ctx);
    return n.ok ? { ok: true, value: { ...n.value, transcript: top.data.transcript } } : n;
  }
  const p = aiVoiceRaw.safeParse(pre);
  if (!p.success) return structural(p.error.issues);
  if (p.data.items.length === 0) return fail(['empty']);
  const r = checkItems(p.data.items, ctx);
  return r.ok ? { ok: true, value: { intent: 'record', confidence, transcript: p.data.transcript, items: r.value } } : r;
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

/** examples[]（R-497 以前怎么分的，客户端 shared/logic/project-examples.ts 挑）：只留标题、项目都是非空字符串的，
 *  标题截到 AI_EXAMPLE_TITLE_LEN、项目截到 AI_PROJECT_LEN 个字，最多 AI_EXAMPLES_MAX 条（多了截断，不拒收）；ai-voice 从 X-Examples 头解出来也走这里 */
export function normExamples(v: unknown): ProjectExample[] {
  if (!Array.isArray(v)) return [];
  const out: ProjectExample[] = [];
  for (const e of v) {
    if (typeof e !== 'object' || e === null) continue;
    const { title, project } = e as { title?: unknown; project?: unknown };
    if (typeof title !== 'string' || typeof project !== 'string') continue;
    const t = [...title.trim()].slice(0, AI_EXAMPLE_TITLE_LEN).join('');
    const pr = [...project.trim()].slice(0, AI_PROJECT_LEN).join('');
    if (t && pr) out.push({ title: t, project: pr });
    if (out.length >= AI_EXAMPLES_MAX) break;
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
  /** R-497：以前分进自建项目的几条（normExamples 规整）；旧版客户端不带 */
  examples: z.array(z.unknown()).max(200).optional(),
  scope: z.enum(['main', 'vault']).optional(),
  default_day: z.string().max(16).optional(),
  /** R-444 起的客户端带 1：能存跨天日程（duration_min 到 44640）；没带的是旧版，服务器把时长规整到 1440 以内（parse-core.ts 的 plusBody） */
  span: z.literal(1).optional(),
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

/** 记下：{intent: 'record', confidence, items, quota_left}（ai-voice 多 transcript）；别的意图见 intent.ts 的 queryResponse、targetResponse */
export const recordResponse = z.strictObject({
  intent: z.literal('record'),
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
  queryResponse,
  targetResponse,
  z.strictObject({ fallback: z.literal(true), reason: z.enum(FALLBACK_REASONS) }),
  z.strictObject({ consent_required: z.literal(true) }),
  z.strictObject({ quota_out: z.literal(true), quota_left: z.literal(0) }),
  z.strictObject({ ai_failed: z.literal(true), reason: z.enum(FALLBACK_REASONS) }),
]);
export type AiResponse = z.infer<typeof aiResponse>;
export type { IntentChecked, QueryResponse, TargetResponse } from './intent.ts';
