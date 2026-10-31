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
  /** 这个邮箱已占的 code_hash（迁移 20261031150000）；只读，putPending 不写它（upsert 不带这一列，原值保留） */
  claimed_code?: string | null;
}

/** ok：这次新占；reused：这个邮箱之前已经占过（同一个码沿用，或换码时旧码已退、新码占上） */
export type ClaimResult = 'ok' | 'reused' | 'invalid' | 'no_pending';

/** 数据库（index.ts 用 service role 的 supabase-js 实现，private 表经 schema('private')）。出错一律抛错 */
export interface Store {
  /** private.take_rate(key, limit, window_s)：true = 放行 */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** 只读 max_uses、used_count、expires_at（不读 created_by、note） */
  getInvite(codeHash: string): Promise<InviteRow | null>;
  /**
   * private.invite_claim（迁移 20261031150000，INVITE-late-commit）：锁住这个邮箱、这一版验证码的 pending 行，
   * 已占过这个码回 reused 不再加；换码回 reused（旧码退、新码占）；没占过就原子 used_count + 1、记下 claimed_code、回 ok。用完、过期、不存在回 invalid；pending 没了或换了版回 no_pending
   */
  claimInvite(emailHash: string, otpHash: string, codeHash: string, notExpiredAt: string): Promise<ClaimResult>;
  /** private.invite_release：这个邮箱的 claimed_code 正是这个码才减一并清掉；true = 退了 */
  releaseInvite(emailHash: string, codeHash: string): Promise<boolean>;
  /** upsert private.pending_signups（同一邮箱重新发码就覆盖：新验证码、tries 归 0；claimed_code 不在写入的列里，原值保留） */
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
  /**
   * insert public.profiles (user_id, ui_locale) on conflict do nothing。返回 true = 这一次插进去了；false = 已经有了（认领的用户已是注册完的账号）
   */
  insertProfile(userId: string, locale: Locale): Promise<boolean>;
  /** app_config.min_client_version；读不到返回 null（放行，和转发层同一口径） */
  minClientVersion(): Promise<string | null>;
}

export type CreateUserResult = { ok: true; userId: string } | { ok: false; exists: boolean };

/** GoTrue 管理接口（service role） */
export interface AuthAdmin {
  /**
   * auth.admin.createUser({id, email, email_confirm: true, user_metadata: {locale}})——不传 password（账号不许有密码，0.36）。
   * id 由 core 按邮箱哈希 + 邀请码哈希派生（wire.ts 的 signupUserId，INVITE-auth-timeout）：超时晚到建出来的用户，重试（含重新发码后）时能认出是自己这一次建的
   */
  createUser(id: string, email: string, locale: Locale): Promise<CreateUserResult>;
  /** auth.admin.getUserById(id)：有这个用户 true、没有 false；出错抛错 */
  userExists(id: string): Promise<boolean>;
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
