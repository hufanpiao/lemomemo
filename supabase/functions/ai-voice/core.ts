// ai-voice（架构第 6 节函数表 ai-voice 行、5.11、第 7 节“语音”；B3 任务单 S8、S12、BE-4，M3 X-Projects，Q2 服务器包 intent）。
// 顺序：方法（只收 POST）→ JWT → Content-Type 白名单（先去参数再比，不在 4 种里回 415、不调 Gemini；S1、TC-B3-65 起新增用例）
//   → 请求头 X-Now、X-TZ、X-Locale、X-Scope、X-Projects、X-Default-Day（日历页选中的那天，R6；不合格回 400）→ 边读边计数读请求体（≤ 600 KB，超了中断回 413，不只看 Content-Length）
//   → 共用的门（_shared/ai/gate.ts）→ voiceWithAI（Gemini 15 秒超时；回 503 时服务器端重试一次、两次合计仍不超过 15 秒，_shared/ai/retry.ts）→ 成功回 {intent: 'record', confidence, transcript, items, quota_left}；
//   失败退回预扣、回 {ai_failed, reason}（客户端留着录音，可以重试或再说一次）。
// 空列表（R7 ②）：转写为空回 {transcript: '', items: []}、照常算 1 次（客户端按 no_speech）；转写不空而条目为空由校验判 invalid（empty），退回次数。
// X-Projects：UTF-8 JSON 再 base64url，≤ 4 KB；超了截到 4 KB、按项截断（留下完整的几项），本来就解不开的当没给（不拒收）。
// 音频只在内存里：不写 Storage、不写日志、不 console.*（5.11 第 3 点、A23）。转交 Gemini 时 mimeType 用去掉参数以后的类型。
// 失败分支写 logs 表（架构审第九节第 2 条）：Gemini 拒收、超时、额度用完、计数出错各写一行 kind 'ai'、act 'voice_fail'、src 'ai-voice'，
//   code 是固定错误码，fields 只有 status=HTTP 状态、type=异常类型名、retried=1（503 重试过）、bytes=音频字节数区间；不写转写、正文、请求头。写失败不影响回答。
// 503 重试后成功的，counters 记 voice-retry:global:<太平洋日期> 加一（经 take_rate，上限给得很大、只当计数用；写失败不影响回答）。
// scope = vault：隐私记页面经“＋”记下在 B4b-3 才有（届时换成 verifyVaultToken + ai.vault），B3 回 {fallback, vault_ai_off}、不调 Gemini、不扣次数。
import { aiGate, pacificDate, settleFailure, type GateDeps } from '../_shared/ai/gate.ts';
import type { AIProvider } from '../_shared/ai/provider.ts';
import type { AiKindLike, ParseFail, ParseOk, VoiceInput } from '../_shared/ai/parse-core.ts';
import { readCapped } from '../_shared/body.ts';

export const MAX_AUDIO = 600 * 1024;
export const MAX_PROJECTS_HEADER = 4096;
export const AUDIO_TYPES = ['audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/webm'] as const;
export const RECORD_CONFIDENCE = 1;
/** 503 重试后成功的全项目计数键（附录 A；三段写法过得了 counters 的 check 约束） */
export const voiceRetryKey = (ms: number): string => `voice-retry:global:${pacificDate(ms)}`;
/** 只当计数用：上限给得远超全项目每日额度，take_rate 永远放行 */
export const VOICE_RETRY_COUNT_LIMIT = 1_000_000;

export type AuthResult = { ok: true; user: { userId: string } } | { ok: false; response: Response };

export interface Logic<Item> {
  normLocale(v: unknown): 'zh' | 'ko';
  normProjects(v: unknown): string[];
  isValidTz(tz: string): boolean;
  /** 默认日子（R6）：不传 null；格式不对、不存在、不在前 1 年到后 5 年之内 'bad' */
  checkDefaultDay(v: unknown, now: number, tz: string): string | null | 'bad';
  voiceWithAI(input: VoiceInput, provider: AIProvider): Promise<ParseOk<{ transcript: string; items: Item[] }> | ParseFail>;
}

export interface Deps<Item> extends GateDeps {
  authenticate(req: Request): Promise<AuthResult>;
  logic: Logic<Item>;
  /** 失败写 logs 表一行（index.ts 接 service role 的 insert） */
  logFail(userId: string, code: string, fields: string[]): Promise<void>;
}

/** 音频字节数区间（只记区间，不记确切大小） */
export function bytesBucket(n: number): string {
  if (n < 16 * 1024) return '<16k';
  if (n < 64 * 1024) return '16k-64k';
  if (n < 256 * 1024) return '64k-256k';
  return '256k-600k';
}

/** 门拦下来时哪些算失败（同意、类型开关不算）：额度用完、每分钟限流、计数或读配置出错 */
function gateFailCode(status: number, body: Record<string, unknown>, codes: readonly string[]): string | null {
  if (body['consent_required'] === true || body['reason'] === 'feature_off') return null;
  if (body['quota_out'] === true) return 'quota_out';
  if (status === 429) return 'rate_limited';
  return codes.at(-1) ?? (body['reason'] === 'quota' ? 'quota_exhausted' : 'gate_error');
}

import { json } from '../_shared/http.ts';
export { json };

/** Content-Type 去参数、转小写；在白名单里返回它，不在返回 null（audio/webm;codecs=opus → audio/webm） */
export function audioType(ct: string | null): string | null {
  const base = (ct ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return (AUDIO_TYPES as readonly string[]).includes(base) ? base : null;
}

/** X-Projects：base64url(UTF-8 JSON 字符串数组)。超过 4 KB 截到 4 KB，按项截断：留下截断处之前完整的几项（代码审建议 6，
 *  原来截完整段 JSON 解不开就全丢了）；本来就解不开的当没给 */
export function decodeProjects(h: string | null): unknown[] {
  if (!h) return [];
  const cut = h.length > MAX_PROJECTS_HEADER;
  const s = (cut ? h.slice(0, MAX_PROJECTS_HEADER - (MAX_PROJECTS_HEADER % 4)) : h).replace(/-/g, '+').replace(/_/g, '/');
  let text: string;
  try {
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    // 截断处可能切开一个多字节字符：只在截断时放宽（结尾的半个字符变成 U+FFFD，下面连同那一项一起丢掉）
    text = new TextDecoder('utf-8', { fatal: !cut }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return [];
  }
  const parse = (t: string): unknown[] | null => {
    try {
      const v: unknown = JSON.parse(t);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const whole = parse(text);
  if (whole) return whole;
  if (!cut) return [];
  // 从后往前找项与项之间的分隔（", 或 ",空白"），截在那里补上 ]，直到解得开
  for (let i = text.lastIndexOf('",'); i > 0; i = text.lastIndexOf('",', i - 1)) {
    const v = parse(`${text.slice(0, i + 1)}]`);
    if (v) return v;
  }
  return [];
}

export { readCapped };

export async function handle<Item>(req: Request, deps: Deps<Item>): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const userId = auth.user.userId;

  const mime = audioType(req.headers.get('content-type'));
  if (!mime) {
    await req.body?.cancel().catch(() => {});
    return json(415, { error: 'unsupported_media_type' });
  }
  const now = Number(req.headers.get('x-now'));
  const tz = req.headers.get('x-tz') ?? '';
  const scope = req.headers.get('x-scope') ?? 'main';
  const defaultDay = Number.isInteger(now) && now > 0 && deps.logic.isValidTz(tz) ? deps.logic.checkDefaultDay(req.headers.get('x-default-day') ?? undefined, now, tz) : 'bad';
  if (defaultDay === 'bad' || (scope !== 'main' && scope !== 'vault')) {
    await req.body?.cancel().catch(() => {});
    return json(400, { error: 'bad_request' });
  }
  const audio = await readCapped(req, MAX_AUDIO);
  if (audio === 'too_large') return json(413, { error: 'too_large' });
  if (audio === 'empty') return json(400, { error: 'bad_request' });
  if (scope === 'vault') return json(200, { fallback: true, reason: 'vault_ai_off' });

  const codes: string[] = [];
  const d: Deps<Item> = { ...deps, log: (c) => { codes.push(c); deps.log(c); } };
  const bytes = `bytes=${bytesBucket(audio.length)}`;
  const logFail = async (code: string, fields: string[]) => {
    try {
      await deps.logFail(userId, code, [...fields, bytes]);
    } catch {
      deps.log('log_write_failed');
    }
  };

  const gate = await aiGate(d, userId, req.headers.get('x-app-version') ?? '');
  if (gate.stop) {
    const code = gateFailCode(gate.status, gate.body, codes);
    if (code !== null) await logFail(code, []);
    return json(gate.status, gate.body);
  }

  const input: VoiceInput = {
    audio, mime, now, tz, locale: deps.logic.normLocale(req.headers.get('x-locale')),
    projects: deps.logic.normProjects(decodeProjects(req.headers.get('x-projects'))), features: gate.features as AiKindLike[],
    defaultDay: defaultDay ?? undefined,
  };
  let r: ParseOk<{ transcript: string; items: Item[] }> | ParseFail;
  try {
    r = await deps.logic.voiceWithAI(input, gate.provider);
  } catch (e) {
    r = { ok: false, reason: 'error', errName: e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'unknown' };
  }
  if (r.badDefaultDay) d.log('bad_default_day');   // R10 兜底：入口已 400，到这里说明入口漏校验
  if (!r.ok) {
    d.log(`ai_${r.reason}`);
    await logFail(`ai_${r.reason}`, [
      ...(r.status !== undefined ? [`status=${r.status}`] : []),
      ...(r.errName !== undefined ? [`type=${r.errName}`] : []),
      ...(r.retried ? ['retried=1'] : []),
    ]);
    const before = codes.length;
    await settleFailure(d, gate, userId, 'ai-voice', r);
    if (codes.slice(before).includes('settle_failed')) await logFail('settle_failed', []);
    return json(200, { ai_failed: true, reason: r.reason });
  }
  if (r.retried) {
    try {
      await d.rate(voiceRetryKey(d.now()), VOICE_RETRY_COUNT_LIMIT, 86_400);
    } catch {
      d.log('voice_retry_count_failed');
    }
  }
  return json(200, {
    intent: 'record', confidence: RECORD_CONFIDENCE, transcript: r.value.transcript, items: r.value.items, quota_left: gate.quotaLeft,
  });
}
