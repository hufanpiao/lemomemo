// parseWithAI 的实现（架构第 7 节“parseWithAI：解析的纯函数”，0.29 AI 句库 Q8 后端承诺；B3 任务单 BE-1）。
// 本文件不 import _shared/gen/、不 import npm 包：校验函数（shared/schema/ai.ts 的 checkParseOutput、checkVoiceOutput）由调用方注入，
// 这样 Vitest 和 tsc 能直接测它（tests/edge/ai-parse-with-ai.test.ts 注入真的 shared 版本）；函数和评测用的绑定在 parse-with-ai.ts。
// 做的事：去控制字符、转义 </data>、截 2000 字 → 拼提示词 → 调 provider → 校验 → 返回校验后的结果和原始输出（评测两份都存）。
// 不做的事：不查 AI 同意、不计次数和限流、不看“本机有把握就不调 AI”、不读写数据库（quota 只作为 reason 返回，ai_state 由调用方写）。
import { PROMPT_VERSION, TASK_PARAMS, PARSE_TIMEOUT_MS, VOICE_TIMEOUT_MS } from './params.ts';
import { DEFAULT_DAY_RULE, PARSE_V2 } from './prompts/parse.v2.ts';
import { VOICE_V2 } from './prompts/voice.v2.ts';
import type { AIProvider } from './provider.ts';

export type AiKindLike = 'event' | 'todo' | 'note' | 'anniv';
export type InvalidReasonLike = 'missing_date_basis' | 'bad_date' | 'not_whitelisted' | 'out_of_range' | 'schema' | 'empty';

/** 注入的校验（shared/schema/ai.ts 的同名函数满足这个形状） */
export type CheckResult<T> = { ok: true; value: T } | { ok: false; invalid_reasons: InvalidReasonLike[]; issues: unknown[] };
export interface CheckCtx { now: number; tz: string; features: readonly AiKindLike[]; defaultDay?: string | undefined }
export interface Checkers<Item> {
  checkParseOutput(raw: unknown, ctx: CheckCtx): CheckResult<{ items: Item[] }>;
  checkVoiceOutput(raw: unknown, ctx: CheckCtx): CheckResult<{ transcript: string; items: Item[] }>;
  /** 默认日子的校验（shared/schema/ai.ts 的 checkDefaultDay，和 ai-parse、ai-voice 入口同一个函数，R10） */
  checkDefaultDay: DayCheck;
}

/** 默认日子校验：不传 null；格式不对、不存在、不在今天前 1 年到后 5 年之内 'bad' */
export type DayCheck = (v: unknown, now: number, tz: string) => string | null | 'bad';

export interface ParseInput {
  text: string;
  /** 毫秒 */
  now: number;
  tz: string;
  locale: 'zh' | 'ko';
  projects: readonly string[];
  /** 已按 featureOn 算好的、这个人能用的类型 */
  features: readonly AiKindLike[];
  /** 日历页选中的那天（R6；调用方已校验）；不传时提示词里没有这一条，行为和今天页一样 */
  defaultDay?: string | undefined;
}

export interface VoiceInput extends Omit<ParseInput, 'text'> {
  audio: Uint8Array;
  /** 去掉参数以后的类型（audio/webm;codecs=opus → audio/webm），4 种之一 */
  mime: string;
}

export type FailReason = 'quota' | 'timeout' | 'invalid' | 'error';
/** status：服务商的 HTTP 状态码；errName：异常类型名（只给日志用，ai-voice 写 logs，架构审第九节第 2 条） */
/** badDefaultDay：传进来的默认日子没过校验，已按没传处理（R10 兜底；调用方记错误码 bad_default_day） */
export type ParseFail = { ok: false; reason: FailReason; raw?: unknown; invalid_reasons?: InvalidReasonLike[]; issues?: unknown[]; status?: number; errName?: string; badDefaultDay?: true };
export type ParseOk<T> = { ok: true; value: T; raw: unknown; prompt: string; badDefaultDay?: true };

export const TEXT_MAX = 2000;
export const PROJECTS_MAX = 30;
export const PROJECT_LEN = 40;

// 控制字符（保留换行、制表）、双向覆盖字符：去掉
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/** 防提示注入第 2 条：去控制字符、转义 </data>（不分大小写，也挡 </projects>）、截到 max 个码点 */
export function sanitize(s: string, max = TEXT_MAX): string {
  const cut = [...s.replace(CTRL, '')].slice(0, max).join('');
  return cut.replace(/<\s*\/\s*(data|projects)\s*>/gi, (_m, tag: string) => `<\\/${tag}>`).replace(/<\s*(data|projects)\s*>/gi, (_m, tag: string) => `<_${tag}>`);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 某时区里的今天、星期、现在几点（不依赖 shared：用 Intl） */
export function wallOf(now: number, tz: string): { today: string; weekday: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { today: `${get('year')}-${get('month')}-${get('day')}`, weekday: wd < 0 ? '' : (WEEKDAYS.at(wd) ?? ''), time: `${get('hour')}:${get('minute')}` };
}

/** 填提示词的占位符（单测核对没有漏填的 {{…}}） */
export interface FilledPrompt {
  system: string;
  /** 默认日子传了但没过校验：没拼进提示词，按没传处理 */
  badDefaultDay: boolean;
  /** 校验过的默认日子（没传或不合格是 undefined），校验 AI 输出时用这一个 */
  defaultDay: string | undefined;
}

/** 填提示词的占位符。默认日子来自客户端、进的是系统提示区（不在 <data> 里），拼之前用同一个校验函数再查一次（R10）：
 *  不合格不拼原值，{{DEFAULT_DAY_RULE}} 整行去掉、{{DEFAULT_DAY}} 填空，返回 badDefaultDay 让调用方记日志 */
export function fillPrompt(
  tpl: string,
  input: { now: number; tz: string; locale: 'zh' | 'ko'; features: readonly AiKindLike[]; defaultDay?: string | undefined },
  checkDay: DayCheck,
): FilledPrompt {
  const checked = input.defaultDay === undefined ? null : checkDay(input.defaultDay, input.now, input.tz);
  const day = checked === null || checked === 'bad' ? undefined : checked;
  const w = wallOf(input.now, input.tz);
  const map: Record<string, string> = {
    TODAY: w.today, WEEKDAY: w.weekday, NOW_TIME: w.time, TZ: input.tz,
    LOCALE: input.locale === 'ko' ? '韩文' : '中文', KINDS: input.features.join(', '), DEFAULT_DAY: day ?? '',
  };
  // 默认日子那一条：传了才有，不传整行去掉（R6：今天页、待办页、评测不传，提示词不变）
  const withRule = tpl.replace(/^\{\{DEFAULT_DAY_RULE\}\}\n/m, day ? `${DEFAULT_DAY_RULE}\n` : '');
  const system = withRule.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (Object.hasOwn(map, k) ? map[k] : undefined) ?? m);
  return { system, badDefaultDay: checked === 'bad', defaultDay: day };
}

/** 项目名：去控制字符、截 40 字、最多 30 个 */
export function cleanProjects(ps: readonly string[]): string[] {
  return ps.slice(0, PROJECTS_MAX).map((p) => sanitize(p, PROJECT_LEN)).filter((p) => p.trim() !== '');
}

const STR = { type: 'STRING' };
const NSTR = { type: 'STRING', nullable: true };

/** Gemini responseSchema（OpenAPI 子集）：kind 的枚举只放这个人能用的类型；没有 anniv 时整个 anniv 键不出现。不放 intent（Q2） */
export function responseSchema(features: readonly AiKindLike[], voice: boolean): Record<string, unknown> {
  const props: Record<string, unknown> = {
    kind: { type: 'STRING', enum: [...features] },
    title: STR,
    date: NSTR,
    time: NSTR,
    duration_min: { type: 'INTEGER', nullable: true },
    due: NSTR,
    important: { type: 'BOOLEAN' },
    project: NSTR,
    body: NSTR,
    short: NSTR,
    date_basis: { type: 'STRING', enum: ['ymd', 'md', 'd', 'rel'], nullable: true },
  };
  const required = ['kind', 'title', 'date', 'time', 'due', 'important', 'date_basis'];
  if (features.includes('anniv')) {
    props['anniv'] = {
      type: 'OBJECT', nullable: true,
      properties: {
        type: { type: 'STRING', enum: ['birthday', 'anniversary', 'countdown'] },
        calendar: { type: 'STRING', enum: ['solar', 'lunar'] },
        month: { type: 'INTEGER' }, day: { type: 'INTEGER' }, is_leap: { type: 'BOOLEAN' }, year: { type: 'INTEGER', nullable: true },
      },
      required: ['type', 'calendar', 'month', 'day'],
    };
  }
  const items = { type: 'ARRAY', items: { type: 'OBJECT', properties: props, required } };
  return voice
    ? { type: 'OBJECT', properties: { transcript: STR, items }, required: ['transcript', 'items'] }
    : { type: 'OBJECT', properties: { items }, required: ['items'] };
}

function dataParts(text: string, projects: readonly string[]): string {
  return `<projects>${JSON.stringify(cleanProjects(projects))}</projects>\n<data>${sanitize(text)}</data>`;
}

function failOf(r: { ok: false; reason: 'quota' | 'timeout' | 'error'; status?: number; errName?: string }): ParseFail {
  return { ok: false, reason: r.reason, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.errName !== undefined ? { errName: r.errName } : {}) };
}

export function makeParseWithAI<Item>(checkers: Checkers<Item>) {
  /** 文字：ai-parse、claude-intake、评测 */
  async function parseWithAI(input: ParseInput, provider: AIProvider): Promise<ParseOk<{ items: Item[] }> | ParseFail> {
    const fp = fillPrompt(PARSE_V2, input, checkers.checkDefaultDay);
    const bad = fp.badDefaultDay ? ({ badDefaultDay: true } as const) : {};
    const r = await provider.generate({
      system: fp.system,
      parts: [{ text: dataParts(input.text, input.projects) }],
      schema: responseSchema(input.features, false),
      params: TASK_PARAMS.parse,
      timeoutMs: PARSE_TIMEOUT_MS,
    });
    if (!r.ok) return { ...failOf(r), ...bad };
    const v = checkers.checkParseOutput(r.json, { now: input.now, tz: input.tz, features: input.features, defaultDay: fp.defaultDay });
    if (!v.ok) return { ok: false, reason: 'invalid', raw: r.json, invalid_reasons: v.invalid_reasons, issues: v.issues, ...bad };
    return { ok: true, value: v.value, raw: r.json, prompt: PROMPT_VERSION.parse, ...bad };
  }

  /** 录音：ai-voice（一次完成转写和拆分；C 路不做评测，R-167） */
  async function voiceWithAI(input: VoiceInput, provider: AIProvider): Promise<ParseOk<{ transcript: string; items: Item[] }> | ParseFail> {
    const fp = fillPrompt(VOICE_V2, input, checkers.checkDefaultDay);
    const bad = fp.badDefaultDay ? ({ badDefaultDay: true } as const) : {};
    const r = await provider.generate({
      system: fp.system,
      parts: [
        { text: `<projects>${JSON.stringify(cleanProjects(input.projects))}</projects>` },
        { inlineData: { mimeType: input.mime, data: input.audio } },
      ],
      schema: responseSchema(input.features, true),
      params: TASK_PARAMS.voice,
      timeoutMs: VOICE_TIMEOUT_MS,
    });
    if (!r.ok) return { ...failOf(r), ...bad };
    const v = checkers.checkVoiceOutput(r.json, { now: input.now, tz: input.tz, features: input.features, defaultDay: fp.defaultDay });
    if (!v.ok) return { ok: false, reason: 'invalid', raw: r.json, invalid_reasons: v.invalid_reasons, issues: v.issues, ...bad };
    return { ok: true, value: v.value, raw: r.json, prompt: PROMPT_VERSION.voice, ...bad };
  }

  return { parseWithAI, voiceWithAI };
}
