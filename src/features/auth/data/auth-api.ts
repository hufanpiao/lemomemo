// 登录和邀请注册的接口（架构 5.6、15.2 中 1、15.6 第 1 点总表）
// - 已有用户：signInWithOtp({shouldCreateUser: false, captchaToken}) → 填满 6 位 → verifyOtp({type: 'email'})
// - 新邮箱：signInWithOtp 回“Signups not allowed”→ 界面要邀请码（R-108：有意接受能试出邮箱是否注册过）
//   → fn invite-signup {step: start}（带 Turnstile 令牌）→ {step: verify}（邮箱验证码）→ 拿到 token_hash → verifyOtp({type: 'magiclink'})
// - verifyOtp 先不带 captchaToken（官方文档只写发码和注册要；B1 实测 TC-B1-08，要的话在这里补）
// 只认错误码，不把服务器原文显示给用户
import type { ApiError } from '../../../../shared/schema/api.ts';
import { budgetLeft, logoutReplaced, sessionReplaced, type PriorSession } from '../../../platform/sign-out.ts';
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
   * 本机库和缓存由调用方接着清（local-exit.ts）。
   * prior（K6-signout-lib，useSessionGate 经 signOutThisDevice 传入）：删行用 prior.sid（退出一开头记下的，不在这时现读）；
   * 拿到客户端、删完行以后、紧贴 signOut 之前再读一次本机会话，已换成别的标签页的新会话就不调 signOut（它会吊销那个新会话），
   * 改用 prior.token 直接 logout（logoutReplaced）。不传 prior 时按原来的：删行的 sid 从本机令牌现读，不做这一判断
   */
  signOutHere(prior?: PriorSession): Promise<Result>;
}

/** 从 access token 的 payload 里读 session_id（找本会话那一行 devices 用）：只在 platform/session.ts 留一份（K4 复核建议 2） */
import { sessionIdOfToken } from '../../../platform/session.ts';
export { sessionIdOfToken };

/** devices 表的类型还没进生成的 Database（K1 在补），删行只用到这一小段 */
/** setHeader：会话已被换时把旧令牌定死在这次请求上（K6-signout-lib 复审建议 ①） */
type DevicesDelete = PromiseLike<{ error: unknown }> & { setHeader?(name: string, value: string): unknown };
interface DevicesDeleteDb {
  from(t: 'devices'): { delete(): { eq(col: 'session_id', v: string): DevicesDelete } };
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

    signOutHere: (prior) => {
      const t0 = Date.now();
      return run(async (db) => {
        // 不先 getSession 预检（K9 退出流程审查：预检失败会跳过 signOut、令牌过期时还会先联网刷新）；
        // session_id 用退出一开头记下的（prior）；没传时从本机存着的 access token 里读，只用来找要删的那一行
        const sid = prior ? prior.sid : sessionIdOfToken(readToken());
        // 会话已被换（复审建议 ①）：supabase-js 会带新会话的令牌，那边删不到（别的账号）就留下一条“已退出”的残留行。
        // 改用退出前的旧令牌删；没有旧令牌就不删（由服务器按会话清理，或设备列表标“已退出”）
        const replacedAtDelete = prior !== undefined && sessionReplaced(prior.sid);
        if (sid && (!replacedAtDelete || prior?.token)) {
          try {
            const q = (db as unknown as DevicesDeleteDb).from('devices').delete().eq('session_id', sid);
            if (replacedAtDelete && prior?.token) q.setHeader?.('Authorization', `Bearer ${prior.token}`);
            await q;
          } catch {
            // 断网、行已被删：照样退出
          }
        }
        // 紧贴 signOut 之前（K6-signout-lib）：本机已是别的标签页的新会话，就用旧令牌直接 logout，不调 supabase-js、不碰存储；
        // 预算扣掉 getDb、删行已经用掉的时间（复审建议 ②），外层超时以后里面的请求不再多跑
        if (prior && sessionReplaced(prior.sid)) {
          const r = await logoutReplaced(prior.token, budgetLeft(prior.budgetMs, t0));
          return r.serverDone ? { ok: true, value: undefined } : { ok: false, error: 'offline' };
        }
        const { error } = await db.auth.signOut({ scope: 'local' });
        // 不是 ok 的一律报回去（断网、令牌过期也算），调用方据此兜底清本机会话
        return error ? { ok: false, error: mapAuthError(error) } : { ok: true, value: undefined };
      });
    },
  };
}

/** 邮箱格式（只挡明显打错的；真伪由发码决定） */
export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * 邀请码：12 位，32 个字符的字母表（5.6、15.3 第 8 条：A–Z 去掉 I、O，加 2–9）。
 * 和服务端 supabase/functions/_shared/invite-code.ts 的 INVITE_ALPHABET、INVITE_LEN 同一份——那份是 Deno 源码，前端不直接 import，
 * 复制在这里，由 __tests__/invite-format.test.ts 读服务端源码比对守住。
 * 前端按字母表校验（10-30 负责人预览注册：输错一个字符，invite-signup 按设计悄悄回 {ok} 不发信，前端得先挡住）
 */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_LEN = 12;
const INVITE_RE = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_LEN}}$`);

/** 去掉空格和横线、转大写（和服务端 normalizeInviteCode 同一个规则）；不替换任何字符 */
export function normalizeInvite(s: string): string {
  return s.replace(/[\s-]/g, '').toUpperCase();
}
export function isInviteFormat(s: string): boolean {
  return INVITE_RE.test(normalizeInvite(s));
}
/** 输进了字母表里没有的易混字符 0、1、I、O（大小写都算）：输入框下当场提示，不自动替换 */
export function inviteHasConfusable(s: string): boolean {
  return /[01IO]/.test(normalizeInvite(s));
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
