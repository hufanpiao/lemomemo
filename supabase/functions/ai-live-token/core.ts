// ai-live-token：给客户端发一个 Gemini Live 实时转写用的短期令牌（ephemeral token）。
// 11-24 负责人选“改走录音加云端转写”：按住“＋”说话时，客户端拿这个令牌直连 Gemini Live（gemini-3.5-transcribe-live），边说边出字；
// 长期密钥只在服务器上，浏览器只拿得到一次性、短时效、锁死模型和配置的令牌（官方文档 ephemeral-tokens）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/ai-live-token.test.ts）；不 import _shared/gen、不 import npm 包。
// 一句话只扣一次“每人每天 50 次”（11-24 评审第 2 条，协调者定的做法）：发令牌不扣 50 次、不占 ai-parse / ai-voice 共用的每分钟 6 次；
//   50 次只由后台整理这句话的 ai-voice 扣（出了字先存只按本机规则，不调 ai-parse；负责人 11-24 选“松手马上用已出的字存”）。
//   令牌自己另有一套键和上限（成本保护）。
// 顺序（每一步不过就直接回，后面的都不做）：
//   ① 只收 POST（别的 405）→ ② requireActiveUser（JWT；停用、没有 profiles 行原样回 403 account_disabled）
//   → ③ AI 同意（没同意 {consent_required}；读出错 503）
//   → ④ 开关：app_config.features.live（LIVE_FLAG，迁移 20261124100000 打开），并且至少开着一种 AI 类型（wire.ts 的 aiFeatures need 'live'）；
//      没开 {fallback, reason: 'feature_off'}
//   → ⑤ 读 app_config.ai（50 次的上限 per_user_daily、全项目 global_daily、令牌自己的 ai.live.per_user_daily）；读出错 {fallback, reason: 'error'}
//   → ⑥ 密钥：服务商固定是 Gemini（Live 只有 Gemini 有），index.ts 按 wire.ts 的 projectKey 取（Vault ai_key_gemini → 环境变量 GEMINI_API_KEY）；
//      没配 {fallback, reason: 'error'}；不看“我的 AI”自己的密钥（Live 令牌只用柠檬记的）
//   → ⑦ 每分钟：独立的键 ai-live-rate（liveRateKey），每人每分钟 LIVE_PER_MINUTE 次，超了 429；管理员不限
//   → ⑧ 50 次只看不扣：不是管理员、也没在用自己的密钥（R-494：自带密钥的不占柠檬记的 50 次；看的是 ai-voice 那一项 stt 的密钥）时，
//      只读 ai:<uid>:<日期> 今天的合计（deps.quotaUsed，和 my_ai_usage、ai_quota_take 同一口径：同一个键所有窗口行合计；评审第 9 条，不再“先扣再退”），
//      已经到上限 → {quota_out, quota_left: 0}（客户端不开连接、不上传录音，直接按“今天用完”收尾）
//   → ⑨ 令牌自己的每天上限（gate.ts 的 takeDaily，键 live:<uid>:<日期>、live:global:<日期>）：每人每天 ai.live.per_user_daily（默认 LIVE_PER_USER_DEFAULT），
//      全项目每天沿用 ai.global_daily（没配当 0，和 AI 一样一律不发）；管理员个人这一项不设上限、全项目照算。用完 {fallback, reason: 'live_quota'}
//   → ⑩ 调 POST LIVE_TOKEN_URL（v1beta/auth_tokens）（密钥只在 x-goog-api-key 请求头），请求体就是 AuthToken（官方 Live API 参考）：
//      只能开 1 次会话（uses 1）、LIVE_NEW_SESSION_S 秒内必须开连接、LIVE_TOKEN_TTL_S 秒后作废；
//      模型和“只转写”的配置写进 bidiGenerateContentSetup，不带 fieldMask——官方参考 AuthToken.fieldMask：为空且带了 bidiGenerateContentSetup 时
//      “The setup message from the Live API connection is ignored”，整份配置按令牌里的，客户端改不了任何一项
//   → ⑪ 成功回 {token, expire_at, model, api, setup}：setup 就是锁进令牌的那一份，客户端连上以后原样发（配置只有这一处）；
//      失败（非 2xx、超时、回包里没有 name）退回第 ⑨ 步的两个键、写 logs（只写固定码和 HTTP 状态），回 {fallback, reason: 'error'}，客户端退回录音上传 ai-voice。
// 长期密钥绝不出现在回包和日志里；日志只记固定的码和 HTTP 状态（deps.log、deps.logFail）。
import type { AuthResult } from '../_shared/auth-result.ts';
import { json } from '../_shared/http.ts';
import { utcMinuteKey } from '../_shared/rate-key.ts';
import { ADMIN_DAILY_CAP, PER_MINUTE_LIMIT, adminOf, pacificDate, takeDaily, userQuotaKey, type QuotaStore } from '../_shared/ai/gate.ts';
import { readAiConfig, type AiConfig } from '../_shared/ai/router.ts';

export const SRC = 'ai-live-token';
/** 实时转写模型（官方文档 live-transcribe：gemini-3.5-transcribe-live） */
export const LIVE_MODEL = 'gemini-3.5-transcribe-live';
/** 令牌接口和 Live 连接用的 API 版本（官方 ephemeral-tokens：短期令牌只在 v1beta 上能用）；客户端的 LIVE_API（src/platform/live-proto.ts）和它钉成一样（tests/edge/ai-live-client.test.ts） */
export const LIVE_API = 'v1beta';
/** 短期令牌接口（整串写死，和 LIVE_API 同一个版本；tests/build/deno-config.test.ts 的出站地址名单里有这一串） */
export const LIVE_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
/** 令牌多久以后作废（秒）：一次按住说话最长 60 秒，加上连接、收尾，2 分钟够用（评审第 9 条） */
export const LIVE_TOKEN_TTL_S = 120;
/** 拿到令牌以后多久内必须开连接（秒）：客户端拿到就连，正常几百毫秒（评审第 9 条） */
export const LIVE_NEW_SESSION_S = 30;
/** 调令牌接口最多等多久 */
export const MINT_TIMEOUT_MS = 8_000;
/** 客户端界面语言（x-locale）→ 偏向的识别语言；不认识的不带（自动识别） */
export const LIVE_LANGS: readonly string[] = ['zh-CN', 'ko-KR'];
/** 这个函数自己的功能开关（app_config.features.live；评审第 17 条） */
export const LIVE_FLAG = 'live';
/** 令牌每人每分钟几次（独立的键，不占 AI 共用的那 6 次；数和 AI 的一样） */
export const LIVE_PER_MINUTE = PER_MINUTE_LIMIT;
/** 令牌每人每天默认几个（app_config.ai.live.per_user_daily 没配时）：50 次 AI 的两倍，留给退回上传、开了没说的 */
export const LIVE_PER_USER_DEFAULT = 100;

export const liveRateKey = (userId: string, ms: number) => utcMinuteKey('ai-live-rate', userId, ms);
export const liveUserKey = (userId: string, ms: number) => `live:${userId}:${pacificDate(ms)}`;
export const liveGlobalKey = (ms: number) => `live:global:${pacificDate(ms)}`;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  consent(userId: string): Promise<boolean>;
  /** features.live 开着、并且至少开着一种 AI 类型（wire.ts 的 aiFeatures need LIVE_FLAG 不为空） */
  liveOn(userId: string, appVersion: string): Promise<boolean>;
  /** app_config.ai 原样（readLiveConfig 读）；读出错抛 */
  config(): Promise<unknown>;
  /** 柠檬记的 Gemini 密钥；没配回 null */
  key(): Promise<string | null>;
  /** 这个人正在用自己的密钥（“我的 AI”，管整理的那一项）；读出错抛（按没有算） */
  own(userId: string): Promise<boolean>;
  isAdmin(userId: string): Promise<boolean>;
  /** private.take_rate(key, limit, window_s) */
  rate(key: string, limit: number, windowS: number): Promise<boolean>;
  quota: QuotaStore;
  /** 只读：这个键今天一共用了几次（private.counters 同一个键所有窗口行合计，store.ts 的 quotaUsed）；读出错抛 */
  quotaUsed(key: string): Promise<number>;
  /** 令牌发失败写 logs（只写固定码和 status=；评审第 18 条） */
  logFail(userId: string, code: string, fields: string[]): Promise<void>;
  fetch: Fetch;
  now(): number;
  log(code: string): void;
}

export interface LiveConfig {
  ai: AiConfig;
  /** 令牌每人每天 */
  perUser: number;
}

/** app_config.ai → AI 的配置和令牌每人每天（ai.live.per_user_daily：非负整数，别的当没配） */
export function readLiveConfig(ai: unknown): LiveConfig {
  const live = typeof ai === 'object' && ai !== null ? (ai as { live?: unknown }).live : undefined;
  const n = typeof live === 'object' && live !== null ? (live as { per_user_daily?: unknown }).per_user_daily : undefined;
  return { ai: readAiConfig(ai), perUser: typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : LIVE_PER_USER_DEFAULT };
}

/** 锁进令牌、也原样回给客户端发的 Live 配置（官方 live-transcribe 原始 WebSocket 的 setup 写法，camelCase）。lang 是 LIVE_LANGS 里的才带 languageCodes */
export function liveSetup(lang: string | null): Record<string, unknown> {
  return {
    model: `models/${LIVE_MODEL}`,
    generationConfig: { responseModalities: ['TEXT'] },
    inputAudioTranscription: lang !== null && LIVE_LANGS.includes(lang) ? { languageCodes: [lang] } : {},
  };
}

/** 令牌接口的请求体（AuthToken）。不带 fieldMask：整份 setup 按令牌里的（见文件头第 ⑩ 步） */
export function mintBody(now: number, setup: Record<string, unknown>): Record<string, unknown> {
  return {
    uses: 1,
    expireTime: new Date(now + LIVE_TOKEN_TTL_S * 1000).toISOString(),
    newSessionExpireTime: new Date(now + LIVE_NEW_SESSION_S * 1000).toISOString(),
    bidiGenerateContentSetup: setup,
  };
}

/** 失败：code 是固定码（日志、logs.code），status 是令牌接口的 HTTP 状态（有才带） */
type Mint = { ok: true; token: string } | { ok: false; code: string; status?: number };

/** 调令牌接口；不抛错 */
export async function mintToken(fetchFn: Fetch, key: string, now: number, setup: Record<string, unknown>): Promise<Mint> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MINT_TIMEOUT_MS);
  try {
    const res = await fetchFn(LIVE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(mintBody(now, setup)),
      signal: ac.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: 'mint_http', status: res.status };
    }
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    const name = body?.name;
    if (typeof name !== 'string' || name === '' || name.length > 2048) return { ok: false, code: 'mint_bad_body' };
    return { ok: true, token: name };
  } catch {
    return { ok: false, code: ac.signal.aborted ? 'mint_timeout' : 'mint_err' };
  } finally {
    clearTimeout(timer);
  }
}

const tryLater = (deps: Pick<Deps, 'log'>, code: string): Response => {
  deps.log(code);
  return json(503, { error: 'try_later' });
};
const fallback = (reason: string): Response => json(200, { fallback: true, reason });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const uid = auth.user.userId;
  const now = deps.now();
  // ③
  let allowed: boolean;
  try {
    allowed = await deps.consent(uid);
  } catch {
    return tryLater(deps, 'consent_read_failed');
  }
  if (!allowed) return json(200, { consent_required: true });
  // ④
  if (!(await deps.liveOn(uid, req.headers.get('x-app-version') ?? ''))) return fallback('feature_off');
  // ⑤
  let cfg: LiveConfig;
  try {
    cfg = readLiveConfig(await deps.config());
  } catch {
    deps.log('config_read_failed');
    return fallback('error');
  }
  // ⑥
  const key = await deps.key().catch(() => null);
  if (!key) {
    deps.log('ai_not_configured');
    return fallback('error');
  }
  const admin = await adminOf(deps, uid);
  // ⑦
  try {
    if (!admin && !(await deps.rate(liveRateKey(uid, now), LIVE_PER_MINUTE, 60))) return json(429, { error: 'rate_limited' });
  } catch {
    return tryLater(deps, 'store_failed');
  }
  // ⑧
  let own = false;
  try {
    own = await deps.own(uid);
  } catch {
    deps.log('own_read_failed');
  }
  if (!admin && !own) {
    try {
      if ((await deps.quotaUsed(userQuotaKey(uid, now))) >= cfg.ai.per_user_daily) return json(200, { quota_out: true, quota_left: 0 });
    } catch {
      return tryLater(deps, 'store_failed');
    }
  }
  // ⑨
  const userKey = liveUserKey(uid, now);
  const globalKey = liveGlobalKey(now);
  const t = await takeDaily(deps.quota, cfg.ai, admin ? ADMIN_DAILY_CAP : cfg.perUser, userKey, globalKey);
  if (!t.ok) {
    if (t.out !== 'failed') {
      deps.log(`live_${t.out}_out`);
      return fallback('live_quota');
    }
    if (t.userTaken) await deps.quota.refund(userKey).catch(() => deps.log('settle_failed'));
    return tryLater(deps, 'store_failed');
  }
  // ⑩
  const setup = liveSetup(req.headers.get('x-locale'));
  const r = await mintToken(deps.fetch, key, now, setup);
  if (!r.ok) {
    deps.log(r.status !== undefined ? `${r.code} ${r.status}` : r.code);
    await deps.quota.refund(userKey).catch(() => deps.log('settle_failed'));
    await deps.quota.refund(globalKey).catch(() => deps.log('settle_failed'));
    await deps.logFail(uid, r.code, r.status !== undefined ? [`status=${r.status}`] : []).catch(() => deps.log('log_write_failed'));
    return fallback('error');
  }
  deps.log('minted');
  return json(200, { token: r.token, expire_at: now + LIVE_TOKEN_TTL_S * 1000, model: LIVE_MODEL, api: LIVE_API, setup });
}
