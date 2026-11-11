// voice-probe 的 HTTP 一层（预览专用、一次性；B3 任务单 BE-0、Q1 ①～⑨，R-68：iPhone 的 AAC、电脑 Edge 的 WebM 能不能直传 Gemini）。
// 说明、调用方法和下线步骤见 docs/09-路线图/B3-voice-probe探测函数.md。只 import _shared 里的纯模块，Vitest 能直接测。
// 顺序（每一道不过就停，不往下做）：
//   ① 环境判断：SUPABASE_URL 不是一字不差的 https://<预览 ref>.supabase.co（只许末尾多一个斜杠）→ 404，什么都不做（同 db-probe）；
//   ② 写死的失效时间 EXPIRES_AT：过了一律 410；
//   ③ 只收 POST，别的方法 → 404；
//   ④ 白名单为空或有格式不对的项（改坏了）→ 404（日志记 misconfigured；不验 JWT、不计数、不调 Gemini）；
//      ③④ 在鉴权之前，一律回 404、不回 405 / 500，免得外人借状态码知道预览上有这个函数（安全审建议 1）；
//   ⑤ 自己验 JWT（auth.getUser），user_id 不在写死的白名单里、令牌无效一律 404（不说是哪一种）；
//   ⑥ 模型只认 Q6 的两个，由请求头 X-Model 指定、没有默认值，不对回 400；
//   ⑦ Content-Type 照正式 ai-voice：去参数、转小写，只认 4 种，不在回 415（另回显收到的原始标注）；
//   ⑧ 边读边计数 ≤ shared 的 AI_AUDIO_MAX_BYTES（index.ts 从生成副本注入），超了中断回 413；空的回 400；
//   ⑨ 每天额度：经 service role 的 private.take_rate 记 voice_probe:global:<太平洋日期>，≤ 100 次，超了 429、不重试；
//   ⑩ 调 Gemini（密钥只在 x-goog-api-key 请求头，由 _shared/ai/gemini.ts 管；15 秒超时），只要转写。11-11 起回 503 重试一次
//      （_shared/ai/retry.ts，两次合计不超过 15 秒；iPhone 实测 40 次里 4 次 503），重试过的返回体带 retried: true。
// 返回 {mime, raw_type, bytes, gemini_http, gemini_ms, total_ms, result, transcript, model, retried}；Gemini 失败也回 200，result 写原因。
// 日志（Q1 ⑥）：只记事件码、mime、字节数、HTTP 状态、耗时；不记转写、音频、请求头、Gemini 出错时的返回正文，不打印请求体。
// 录音只在内存里（5.11 第 3 点、A23）：不写 Storage、不写库、不写日志。响应一律 Cache-Control: no-store。
import { readCapped } from '../../_shared/body.ts';
import { json } from '../../_shared/http.ts';
import { pacificDate } from '../../_shared/ai/gate.ts';
import { VOICE_PROBE_PARAMS, VOICE_TIMEOUT_MS } from '../../_shared/ai/params.ts';
import type { AIProvider, AiResult } from '../../_shared/ai/provider.ts';
import { generateRetry503 } from '../../_shared/ai/retry.ts';
// 类型白名单直接用正式 ai-voice 的（代码审 S3：从源头保证一致；ai-voice/core.ts 只依赖 _shared，不读环境变量、不碰数据库）；
// 大小上限和正式 ai-voice 一样由 index.ts 注入 shared 的 AI_AUDIO_MAX_BYTES（HandlerDeps.maxAudio）
import { AUDIO_TYPES } from '../../ai-voice/core.ts';

/** 预览项目 ref（db-probe 11-12 已删，这里是唯一一份） */
export const PREVIEW_REF = 'yoeqwhygehbaftkppati';

/**
 * 失效时间：B3 开工日按 2026-11-07（任务单定稿日，主持人 11-09 定）+ 10 天（Q1 ③）＝ 2026-11-17 24:00（首尔）。
 * 过了一律 410。要延期只改这一处，并重新过安全审查。
 */
export const EXPIRES_AT = Date.parse('2026-11-17T15:00:00Z');

/**
 * 测试账号白名单（Q1 ②：负责人的预览验收账号、QA 的 .test 账号，按 user_id 写死）。
 * 11-09 主持人在预览控制台 Authentication › Users 只读核对：预览项目一共就这两个账号。随 voice-probe 一起删。
 */
export const ALLOWED_UIDS: readonly string[] = [
  '7aa8c4cb-11ba-4e9e-aa6f-72196dfe3f8b',   // 负责人的预览验收账号（即 db-probe 的 TEST_UID，测试账号 A）
  '8380dfe1-44e2-4eca-b8d2-7fef8f719305',   // QA 的 .test 账号（e2e 管理员）
];

/** 模型只认 Q6 的两个（架构师 11-07 定、主持人第一天确认是哪个；探测时两个都可能要跑），由请求头 X-Model 指定，没有默认值 */
export const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] as const;
export { AUDIO_TYPES };
/** 每天额度（Q1 ④） */
export const DAILY_LIMIT = 100;
/**
 * take_rate 的窗口：30 天。take_rate 的窗口从 1970 年起按整数倍对齐（迁移 20261029130000），31 天窗口的边界落在 2026-11-13 00:00 UTC，
 * 会把太平洋时间 11-12 那一天切成两半（那天最多能到 200 次）；30 天窗口是 2026-11-03～12-03，整个有效期都在同一个窗口里（单测核对）。
 */
export const QUOTA_WINDOW_S = 2_592_000;
export const quotaKey = (ms: number): string => `voice_probe:global:${pacificDate(ms)}`;
/** 回显的转写最多这么多字（够看出对不对） */
export const MAX_TRANSCRIPT = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BEARER = /^Bearer ([A-Za-z0-9._-]{20,4096})$/;

/** 给 Gemini 的系统提示：探测只要转写，不做识别（不用正式的 voice 提示词，免得把格式问题和解析问题混在一起）。
 *  11-11 改（B3 iPhone 实测）：第 4 段“买牛奶”两次都被写成韩文“우유”、第 12 段中文字间带空格——加主语言提示和逐字转写的要求 */
export const PROBE_SYSTEM = [
  '你是语音转写器。录音的主要语言是简体中文，可能夹着韩文。',
  '逐字转写：听到什么语言就用什么语言写，不翻译、不改写、不总结、不补字；中文写成简体，汉字之间不加空格。',
  '听不到人声时 transcript 给空字符串。只按 responseSchema 输出 JSON。',
].join('\n');
/** 音频前面的一段文字指令（只有音频、没有文字时模型更容易自由发挥） */
export const PROBE_INSTRUCTION = '请转写这段录音。';
/** 大写写法和正式的 parse-core.ts responseSchema 一致（代码审 S1：请求和正式的长得一样，免得大小写被拒的 400 和“格式被拒”混在一起） */
export const PROBE_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: { transcript: { type: 'STRING' } },
  required: ['transcript'],
});

/** 日志只许这几个字段（Q1 ⑥） */
export interface ProbeLog {
  code: string;
  mime?: string;
  bytes?: number;
  http?: number;
  ms?: number;
}

export interface HandlerDeps {
  /** 只给单测用：503 重试前的等待（默认 setTimeout）；时钟用下面的 clock */
  sleep?: (ms: number) => Promise<void>;
  /** 平台注入的 SUPABASE_URL */
  supabaseUrl: string | undefined;
  /** 一段录音最多多少字节：shared 的 AI_AUDIO_MAX_BYTES（index.ts 从 _shared/gen/ 注入，和正式 ai-voice 同一份） */
  maxAudio: number;
  now: () => number;
  /** 单调时钟（毫秒），量耗时用 */
  clock: () => number;
  /** 验 JWT：有效返回 user_id，无效返回 null；连不上抛错 */
  verify: (jwt: string) => Promise<string | null>;
  /** private.take_rate：没到上限返回 true；出错抛错 */
  take: (key: string, limit: number, windowS: number) => Promise<boolean>;
  /** 按模型建 Gemini（密钥由 index.ts 读）；没配密钥返回 null。seen：Gemini 回了 HTTP 响应就报一次状态码
   *  （GeminiProvider 在正文解析不了时只回 error、不带状态码，探测要知道“格式收了但输出坏了”还是“被拒了”） */
  provider: (model: (typeof MODELS)[number], seen: (status: number) => void) => AIProvider | null;
  log: (e: ProbeLog) => void;
  /** 只给单测用：替换 ALLOWED_UIDS（index.ts 不传） */
  allowed?: readonly string[];
}

/** 回 json（经 _shared/http.ts，一律 no-store），另带 nosniff */
const reply = (status: number, body: unknown): Response => json(status, body, { 'x-content-type-options': 'nosniff' });

/** 一字不差，只许去掉末尾一个斜杠（同 db-probe 的 isPreview） */
export function isPreview(supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return false;
  const want = ['https', `//${PREVIEW_REF}.supabase.co`].join(':');
  return supabaseUrl === want || supabaseUrl === `${want}/`;
}

/** 白名单能用：不空，每一项都是小写 UUID（防改坏；比较是按字符串全等，大写或带空格的项永远对不上） */
export function allowedReady(list: readonly string[]): boolean {
  return list.length > 0 && list.every((u) => UUID.test(u));
}

/** Content-Type 去参数、转小写；在 4 种里返回它，不在返回 null（同 ai-voice 的 audioType） */
export function audioType(ct: string | null): string | null {
  const base = (ct ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return (AUDIO_TYPES as readonly string[]).includes(base) ? base : null;
}

/** 回显的原始标注：只留可打印 ASCII、最多 100 字；有别的字符整个换成 (invalid) */
export function rawLabel(ct: string | null): string | null {
  if (ct === null) return null;
  const t = ct.trim();
  if (t.length > 100 || !/^[\x20-\x7e]*$/.test(t)) return '(invalid)';
  return t;
}

const isModel = (m: string | null): m is (typeof MODELS)[number] => m !== null && (MODELS as readonly string[]).includes(m);

const drop = async (req: Request): Promise<void> => {
  if (req.body) await req.body.cancel().catch(() => undefined);
};

/** Gemini 的结果 → result、HTTP 状态、转写。超时一律 http = null（代码审 S2：响应头到了、读正文时才超时，seen 已记了 200，
 *  照写会成“200 + timeout”，容易误读） */
function outcome(r: AiResult, seen: number | null): { result: string; http: number | null; transcript: string | null } {
  if (!r.ok) return { result: r.reason, http: r.reason === 'timeout' ? null : seen ?? r.status ?? null, transcript: null };
  const t = (r.json as { transcript?: unknown } | null)?.transcript;
  if (typeof t !== 'string') return { result: 'bad_output', http: 200, transcript: null };
  return { result: 'ok', http: 200, transcript: [...t].slice(0, MAX_TRANSCRIPT).join('') };
}

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const t0 = deps.clock();
  // ①
  if (!isPreview(deps.supabaseUrl)) {
    await drop(req);
    return reply(404, { error: 'not_found' });
  }
  // ②
  if (!(deps.now() < EXPIRES_AT)) {
    await drop(req);
    return reply(410, { error: 'expired' });
  }
  // ③ 鉴权前一律 404（安全审建议 1）
  if (req.method !== 'POST') {
    await drop(req);
    return reply(404, { error: 'not_found' });
  }
  // ④ 同上：名单改坏了也像没有这个函数一样，只在日志里记 misconfigured
  const allowed = deps.allowed ?? ALLOWED_UIDS;
  if (!allowedReady(allowed)) {
    await drop(req);
    deps.log({ code: 'misconfigured' });
    return reply(404, { error: 'not_found' });
  }
  // ⑤ 令牌无效、不在白名单：一律 404（像没有这个函数）
  const m = BEARER.exec(req.headers.get('authorization') ?? '');
  let uid: string | null = null;
  if (m?.[1]) {
    try {
      uid = await deps.verify(m[1]);
    } catch {
      await drop(req);
      deps.log({ code: 'auth_unavailable' });
      return reply(503, { error: 'try_later' });
    }
  }
  if (uid === null || !allowed.includes(uid)) {
    await drop(req);
    deps.log({ code: uid === null ? 'auth_rejected' : 'not_allowed' });
    return reply(404, { error: 'not_found' });
  }
  // ⑥
  const model = req.headers.get('x-model');
  if (!isModel(model)) {
    await drop(req);
    return reply(400, { error: 'bad_model', models: MODELS });
  }
  // ⑦
  const ct = req.headers.get('content-type');
  const mime = audioType(ct);
  const raw_type = rawLabel(ct);
  if (mime === null) {
    await drop(req);
    deps.log({ code: 'unsupported_type' });
    return reply(415, { error: 'unsupported_type', raw_type });
  }
  // ⑧
  const audio = await readCapped(req, deps.maxAudio);
  if (audio === 'too_large') {
    deps.log({ code: 'too_large', mime });
    return reply(413, { error: 'too_large', mime, raw_type });
  }
  if (audio === 'empty') {
    deps.log({ code: 'empty' });   // 代码审 S5：只记事件码
    return reply(400, { error: 'empty', mime, raw_type });
  }
  const bytes = audio.length;
  // 先确认配了密钥再扣次数（代码审 S4：没配密钥不白占名额）
  let seen: number | null = null;
  const provider = deps.provider(model, (s) => {
    seen = s;
  });
  if (!provider) {
    deps.log({ code: 'misconfigured', mime, bytes });
    return reply(500, { error: 'misconfigured' });
  }
  // ⑨
  let okQuota: boolean;
  try {
    okQuota = await deps.take(quotaKey(deps.now()), DAILY_LIMIT, QUOTA_WINDOW_S);
  } catch {
    deps.log({ code: 'quota_unavailable', mime, bytes });
    return reply(503, { error: 'try_later' });
  }
  if (!okQuota) {
    deps.log({ code: 'daily_limit', mime, bytes });
    return reply(429, { error: 'daily_limit', limit: DAILY_LIMIT });
  }
  // ⑩
  const g0 = deps.clock();
  let r: AiResult;
  let retried = false;
  try {
    const out = await generateRetry503(provider, {
      system: PROBE_SYSTEM,
      parts: [{ text: PROBE_INSTRUCTION }, { inlineData: { mimeType: mime, data: audio } }],
      schema: PROBE_SCHEMA,
      params: VOICE_PROBE_PARAMS,   // 带 thinkingLevel minimal，先在探测页实测（正式 ai-voice 暂不带，11-11 架构复审定）
      timeoutMs: VOICE_TIMEOUT_MS,
    }, { clock: deps.clock, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    r = out.result;
    retried = out.retried;
  } catch {
    r = { ok: false, reason: 'error' };
  }
  const gemini_ms = Math.round(deps.clock() - g0);
  const o = outcome(r, seen);
  deps.log({ code: `gemini_${o.result}${retried ? '_retried' : ''}`, mime, bytes, ...(o.http === null ? {} : { http: o.http }), ms: gemini_ms });
  return reply(200, {
    model, mime, raw_type, bytes,
    gemini_http: o.http, gemini_ms, total_ms: Math.round(deps.clock() - t0),
    result: o.result, transcript: o.transcript, retried,
  });
}
