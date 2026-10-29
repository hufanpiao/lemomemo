// 登录和邀请注册的接口（架构 5.6、15.2 中 1、15.6 第 1 点总表）
// - 已有用户：signInWithOtp({shouldCreateUser: false, captchaToken}) → 填满 6 位 → verifyOtp({type: 'email'})
// - 新邮箱：signInWithOtp 回“Signups not allowed”→ 界面要邀请码（R-108：有意接受能试出邮箱是否注册过）
//   → fn invite-signup {step: start}（带 Turnstile 令牌）→ {step: verify}（邮箱验证码）→ 拿到 token_hash → verifyOtp({type: 'magiclink'})
// - verifyOtp 先不带 captchaToken（官方文档只写发码和注册要；B1 实测 TC-B1-08，要的话在这里补）
// 只认错误码，不把服务器原文显示给用户
import type { ApiError } from '../../../../shared/schema/api.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import { readStoredAccessToken } from './local-exit.ts';

export type AuthLocale = 'zh-CN' | 'ko-KR';

/** 界面认的错误（每种一张卡片，线框“加载与出错”） */
export type AuthErr =
  | 'not_registered'
  /** 同一个邮箱 60 秒内只能发一次（GoTrue：“For security purposes, you can only request this after N seconds”） */
  | 'rate_limited'
  /** 全站发信额度用完（GoTrue：每小时约 30 封，“email rate limit exceeded”）或按 IP 的请求限流：不是等 60 秒能好的 */
  | 'send_quota'
  /** 邀请注册已建好账号，但 token_hash 换会话失败：请用邮箱验证码登录 */
  | 'registered_login'
  /** 邀请注册的服务暂时不通（invite-signup 503 try_later）：可以重试 */
  | 'try_later'
  /** 邀请注册的邮箱验证码试错太多次（400 too_many_tries）：回到填邮箱那一步重新开始 */
  | 'too_many_tries'
  /** 邀请注册 verify 被按 IP 限流（429 rate_limited，每小时 30 次）：“试得太频繁” */
  | 'verify_limited'
  | 'captcha_failed'
  | 'code_invalid'
  | 'code_wrong'
  | 'code_expired'
  | 'invite_invalid'
  | 'email_exists'
  | 'offline'
  | 'unknown';

/** waitS：单个邮箱限频时服务器说的还要等几秒（解析不到就没有，界面按 60 秒算） */
export type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: AuthErr; waitS?: number };

/**
 * GoTrue 单个邮箱限频的原文：“For security purposes, you can only request this after N seconds.”
 * supabase/tests/auth/login-probe.mjs 用同一个正则检查真 GoTrue 的原文（auth-api.test.ts 守着两边一致）
 */
export const RATE_LIMIT_MSG = /only request this after (\d+) seconds?/i;

/** 从限频原文里取 N 秒；取不到、不合理（0 或超过 1 小时）回 undefined */
export function retryAfterSeconds(e: unknown): number | undefined {
  const msg = typeof e === 'object' && e !== null ? str((e as ErrLike).message) : '';
  const n = Number(RATE_LIMIT_MSG.exec(msg)?.[1]);
  return Number.isInteger(n) && n > 0 && n <= 3600 ? n : undefined;
}

/** 出错结果；单个邮箱限频时带上还要等几秒 */
function fail(error: AuthErr, e?: unknown): { ok: false; error: AuthErr; waitS?: number } {
  const waitS = error === 'rate_limited' ? retryAfterSeconds(e) : undefined;
  return waitS === undefined ? { ok: false, error } : { ok: false, error, waitS };
}

/** supabase-js 的 AuthError、FunctionsHttpError 里用得到的几个字段 */
interface ErrLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** GoTrue 的错误 → 界面的错误（错误码见 supabase/auth 的 ErrorCode；老版本只有 message，兼顾一下） */
export function mapAuthError(e: unknown): AuthErr {
  if (typeof e !== 'object' || e === null) return 'unknown';
  const x = e as ErrLike;
  const code = str(x.code);
  const msg = str(x.message);
  const name = str(x.name);
  const status = typeof x.status === 'number' ? x.status : -1;
  if (code === 'otp_disabled' || code === 'signup_disabled' || /signups not allowed/i.test(msg)) return 'not_registered';
  // 安全审查（K4 必改 2）：两种限频分开。GoTrue 对“同一邮箱 60 秒一次”和“全站每小时发信额度用完”回的都是
  // over_email_send_rate_limit，只能按 message 分：带“after N seconds”的是单个邮箱的 60 秒限频，其余算额度用完
  if (RATE_LIMIT_MSG.test(msg)) return 'rate_limited';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || status === 429) return 'send_quota';
  if (code === 'captcha_failed' || /captcha/i.test(msg)) return 'captcha_failed';
  // GoTrue 对“填错”和“过期”回的是同一个 otp_expired（Token has expired or is invalid），由调用方按发码时间再分
  if (code === 'otp_expired' || /token has expired or is invalid/i.test(msg)) return 'code_invalid';
  if (name === 'AuthRetryableFetchError' || name === 'FunctionsFetchError' || name === 'TypeError' || status === 0) return 'offline';
  return 'unknown';
}

/**
 * invite-signup 回的错误码（架构 5.6、0.38 第 20 条；supabase/functions/invite-signup/core.ts 的 InviteErr）。
 * - start 只会回 captcha_failed、try_later，其余（限流、码错、发信失败）一律 {ok}（0.38 第 27 条）
 * - 429（不管 error 是什么）只在 verify → verify_limited，见 inviteError
 * - 502 link_failed：账号已建好、没换到会话 → registered_login（回邮箱那一屏，邮箱保留）
 * - bad_request、misconfigured 和表里没有的 → unknown
 */
const INVITE_ERRORS: Readonly<Record<string, AuthErr>> = {
  captcha_failed: 'captcha_failed',
  code_wrong: 'code_wrong',
  code_expired: 'code_expired',
  too_many_tries: 'too_many_tries',
  invite_invalid: 'invite_invalid',
  email_exists: 'email_exists',
  link_failed: 'registered_login',
  try_later: 'try_later',
  bad_request: 'unknown',
  misconfigured: 'unknown',
};

/**
 * FunctionsHttpError 的 context 是原始 Response，错误码在响应体的 error 字段里（shared/schema/api.ts 的 apiError，0.38 第 54 条）。
 * 只借它的类型、不在登录页引 zod 做运行时校验：字段不是字符串时按空码处理。
 * 429 只会出现在 verify（架构 0.38 第 27 条：start 被限流也回 {ok}）→ verify_limited“试得太频繁”；
 * start 万一收到 429（网关之类），不出“太频繁”，按 try_later 让人稍后重试
 */
async function inviteError(e: unknown, step: 'start' | 'verify'): Promise<AuthErr> {
  const ctx = typeof e === 'object' && e !== null ? (e as { context?: unknown }).context : undefined;
  if (ctx instanceof Response) {
    if (ctx.status === 429) return step === 'verify' ? 'verify_limited' : 'try_later';
    try {
      const body = (await ctx.clone().json()) as Partial<Record<keyof ApiError, unknown>> | null;
      // 只查表自己的键：error 是 constructor、toString 之类时不能取到 Object.prototype 上的函数（K2 复审低 1）
      const code = str(body?.error);
      const mapped = Object.hasOwn(INVITE_ERRORS, code) ? INVITE_ERRORS[code] : undefined;
      if (mapped) return mapped;
    } catch {
      // 响应体不是 JSON：按下面的通用规则
    }
  }
  return mapAuthError(e);
}

export interface AuthApi {
  sendCode(email: string, captchaToken: string): Promise<Result>;
  verifyCode(email: string, code: string): Promise<Result>;
  inviteStart(args: { email: string; code: string; captchaToken: string; locale: AuthLocale }): Promise<Result>;
  inviteVerify(args: { email: string; code: string; emailOtp: string; locale: AuthLocale }): Promise<Result>;
  /**
   * “退出并换账号”的服务器一半（架构 4.1、0.38 第 35 条，和设置页的“退出这台设备”同一顺序）：
   * ① 删本会话那一行 devices（del 策略只许删本会话那一行；断网、已被删都不挡退出）；
   * ② signOut({scope: 'local'})，只吊销本会话，不动别的设备。
   * 不先 getSession 预检；不是 ok 的一律回错（含断网、令牌过期、客户端拿不到），调用方据此兜底清本机会话。
   * 本机库和缓存由调用方接着清（local-exit.ts）
   */
  signOutHere(): Promise<Result>;
}

/** 从 access token 的 payload 里读 session_id（找本会话那一行 devices 用；真正的判断在服务器 RLS） */
export function sessionIdOfToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { session_id?: unknown };
    return typeof json.session_id === 'string' && json.session_id ? json.session_id : null;
  } catch {
    return null;
  }
}

/** devices 表的类型还没进生成的 Database（K1 在补），删行只用到这一小段 */
interface DevicesDeleteDb {
  from(t: 'devices'): { delete(): { eq(col: 'session_id', v: string): PromiseLike<{ error: unknown }> } };
}

export const INVITE_FN = 'invite-signup';

export function createAuthApi(getDb: () => Promise<Db>, readToken: () => string | null = readStoredAccessToken): AuthApi {
  async function run(fn: (db: Db) => Promise<Result>): Promise<Result> {
    try {
      return await fn(await getDb());
    } catch (e) {
      return { ok: false, error: mapAuthError(e) };
    }
  }

  return {
    sendCode: (email, captchaToken) =>
      run(async (db) => {
        const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: false, captchaToken } });
        return error ? fail(mapAuthError(error), error) : { ok: true, value: undefined };
      }),

    verifyCode: (email, code) =>
      run(async (db) => {
        const { data, error } = await db.auth.verifyOtp({ email, token: code, type: 'email' });
        if (error) return { ok: false, error: mapAuthError(error) };
        return data.session ? { ok: true, value: undefined } : { ok: false, error: 'unknown' };
      }),

    inviteStart: ({ email, code, captchaToken, locale }) =>
      run(async (db) => {
        const { error } = await db.functions.invoke(INVITE_FN, {
          body: { step: 'start', email, code, captchaToken, locale },
        });
        return error ? { ok: false, error: await inviteError(error, 'start') } : { ok: true, value: undefined };
      }),

    inviteVerify: ({ email, code, emailOtp, locale }) =>
      run(async (db) => {
        const { data, error } = await db.functions.invoke<{ token_hash?: unknown }>(INVITE_FN, {
          body: { step: 'verify', email, code, email_otp: emailOtp, locale },
        });
        if (error) return { ok: false, error: await inviteError(error, 'verify') };
        const tokenHash = str(data?.token_hash);
        if (!tokenHash) return { ok: false, error: 'unknown' };
        // 5.6：只对刚建出来的用户签发，客户端直接换成会话，不用再收第二封信。
        // 走到这里账号已经建好了：换会话失败时不报“出错”，单独提示“注册成功，请用邮箱验证码登录”（安全审查低 4）
        try {
          const v = await db.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
          if (!v.error && v.data.session) return { ok: true, value: undefined };
        } catch {
          // 同上
        }
        return { ok: false, error: 'registered_login' };
      }),

    signOutHere: () =>
      run(async (db) => {
        // 不先 getSession 预检（K9 退出流程审查：预检失败会跳过 signOut、令牌过期时还会先联网刷新）；
        // session_id 从本机存着的 access token 里读，只用来找要删的那一行
        const sid = sessionIdOfToken(readToken());
        if (sid) {
          try {
            await (db as unknown as DevicesDeleteDb).from('devices').delete().eq('session_id', sid);
          } catch {
            // 断网、行已被删：照样退出
          }
        }
        const { error } = await db.auth.signOut({ scope: 'local' });
        // 不是 ok 的一律报回去（断网、令牌过期也算），调用方据此兜底清本机会话
        return error ? { ok: false, error: mapAuthError(error) } : { ok: true, value: undefined };
      }),
  };
}

/** 邮箱格式（只挡明显打错的；真伪由发码决定） */
export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * 邀请码：12 位（5.6；字母表 32 个字符、去掉易混字符，由 invite-admin 定）。
 * 前端只挡位数和明显不是字母数字的输入，不按字母表细查（以服务器为准，免得两边字母表不一致时误拦）；
 * 去掉空格和横线、转大写
 */
export function normalizeInvite(s: string): string {
  return s.replace(/[\s-]/g, '').toUpperCase();
}
export function isInviteFormat(s: string): boolean {
  return /^[A-Z0-9]{12}$/.test(normalizeInvite(s));
}

/** 6 位验证码：只留数字 */
export function normalizeOtp(s: string): string {
  return s.replace(/\D/g, '').slice(0, 6);
}

/** 验证码有效期（15.6 总表：600 秒） */
export const OTP_TTL_MS = 600_000;

/** GoTrue 分不清“填错”和“过期”：按发码到现在的时间分（超过有效期算过期） */
export function splitCodeError(err: AuthErr, sentAt: number, now: number): AuthErr {
  if (err !== 'code_invalid') return err;
  return now - sentAt >= OTP_TTL_MS ? 'code_expired' : 'code_wrong';
}
