// invite-signup 的类型（从 core.ts 拆出，B1 第九批 lint 超行清零；内容原样搬过来，core.ts 原名转出，外面照旧从 core.ts 引）。
// 只放类型：数据库、Auth 管理接口、Turnstile 结果、注入的依赖。

import type { EnvKind } from '../_shared/env-kind.ts';

export type Locale = 'zh-CN' | 'ko-KR';
/** 环境（index.ts 用 _shared/env-kind.ts 按 SUPABASE_URL 判断；拿不准一律正式） */
export type Env = EnvKind;

/** 回给客户端的错误码（前端 src/features/auth/data/auth-api.ts 的 INVITE_ERRORS 按 error 字段认） */
export type InviteErr =
  | 'bad_request'
  | 'method_not_allowed'
  | 'misconfigured'
  | 'captcha_failed'
  | 'rate_limited'
  | 'code_wrong'
  | 'code_expired'
  | 'too_many_tries'
  | 'invite_invalid'
  | 'email_exists'
  | 'link_failed'
  | 'try_later';

export interface InviteRow {
  max_uses: number | null;
  used_count: number | null;
  expires_at: string | null;
}

export interface PendingRow {
  otp_hash: string;
  tries: number;
  expires_at: string;
}

/** 数据库（index.ts 用 service role 的 supabase-js 实现，private 表经 schema('private')）。出错一律抛错 */
export interface Store {
  /** private.take_rate(key, limit, window_s)：true = 放行 */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** 只读 max_uses、used_count、expires_at（不读 created_by、note） */
  getInvite(codeHash: string): Promise<InviteRow | null>;
  /**
   * 比较并交换：update private.invites set used_count = to where code_hash = $1 and used_count = from
   *   [and expires_at > notExpiredAt]，返回是否恰好改到 1 行。单条 UPDATE，并发时只有一个能从 from 改成功。
   */
  casInviteUsed(codeHash: string, from: number, to: number, notExpiredAt: string | null): Promise<boolean>;
  /** upsert private.pending_signups（同一邮箱重新发码就覆盖：新验证码、tries 归 0） */
  putPending(emailHash: string, row: PendingRow): Promise<void>;
  getPending(emailHash: string): Promise<PendingRow | null>;
  /**
   * update … set tries = to where email_hash = $1 and tries = from and otp_hash = otpHash，返回是否改到 1 行。
   * 带上 otp_hash：读完以后同一邮箱重新发了码（行被覆盖、tries 归 0），这次尝试不会记到新码头上（K2 安全审查低 4）
   */
  casPendingTries(emailHash: string, from: number, to: number, otpHash: string): Promise<boolean>;
  /**
   * delete … where email_hash = $1 [and otp_hash = otpHash]。
   * 带 otpHash 时只删读到的那一版：读完以后用户重新点了 start 拿到新码，新码不会被误删（第三轮复审）
   */
  deletePending(emailHash: string, otpHash?: string): Promise<void>;
  /** insert public.profiles (user_id, ui_locale) */
  insertProfile(userId: string, locale: Locale): Promise<void>;
  /** app_config.min_client_version；读不到返回 null（放行，和转发层同一口径） */
  minClientVersion(): Promise<string | null>;
}

export type CreateUserResult = { ok: true; userId: string } | { ok: false; exists: boolean };

/** GoTrue 管理接口（service role） */
export interface AuthAdmin {
  /** auth.admin.createUser({email, email_confirm: true, user_metadata: {locale}})——不传 password（账号不许有密码，0.36） */
  createUser(email: string, locale: Locale): Promise<CreateUserResult>;
  deleteUser(userId: string): Promise<void>;
  /** auth.admin.generateLink({type: 'magiclink', email}) 的 properties.hashed_token；失败返回 null */
  magiclinkTokenHash(email: string): Promise<string | null>;
}

/** siteverify 返回里用得到的三项 */
export interface TurnstileResult {
  success: boolean;
  hostname: string | null;
  action: string | null;
}

export interface Deps {
  store: Store;
  auth: AuthAdmin;
  env: Env;
  /** Cloudflare siteverify；网络出错抛错 */
  verifyTurnstile(token: string, remoteIp: string | null): Promise<TurnstileResult>;
  /** Resend 发验证码：true = 发出去了 */
  sendMail(to: string, mail: { subject: string; text: string }): Promise<boolean>;
  /** 邮箱、IP、验证码哈希的 HMAC 密钥 */
  hashSecret: string | undefined;
  /** 正式环境没配就拒绝（misconfigured）；预览、本机只记 proxy_secret_missing（K2 安全审查低 3） */
  proxySecret: string | undefined;
  /** TURNSTILE_SECRET、RESEND_API_KEY 有没有配（值不进 core） */
  configured: boolean;
  now: () => number;
  /** 0～999999 的均匀随机整数（测试注入固定值） */
  randomOtp?: () => number;
  log?: (code: string) => void;
}
