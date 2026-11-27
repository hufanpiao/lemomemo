// “刚用邮箱验证码登录过”的判断（架构 0.29 续第 131 条④、5.5 重设“不看 iat、看 amr 里 otp 的 timestamp”、复审 N1）。
// account（restore、rebind_device）和 vault（reset）共用这一份；原来写在 account/core.ts，B5 挪到这里（任务单：两处用、只写一份）。
// JWT 由调用方先经 requireActiveUser 验过签名，这里只读 payload 里的 amr（解 payload 用 _shared/jwt-claims.ts，和 auth.ts 同一份）。
// 不 import npm 包、不碰 Deno 全局，Vitest 直接测。
import { jwtClaims } from './jwt-claims.ts';

/** 默认 10 分钟（account restore、vault reset 都是 600 秒） */
export const OTP_MAX_AGE_S = 600;

/**
 * amr 里 otp 那一项在 maxAgeS 秒以内（刚用邮箱验证码登录就满足；刷新令牌时 amr 的 timestamp 不变，所以刷新出来的令牌照样按原登录时刻算）。
 * GoTrue 的写法是 [{method: 'otp', timestamp: 秒}]；只认 otp（magiclink、password 等不算），取最近的一次；允许 1 分钟时钟误差。
 */
export function otpFresh(jwt: string, nowMs: number, maxAgeS = OTP_MAX_AGE_S): boolean {
  const amr = jwtClaims(jwt).amr;
  if (!Array.isArray(amr)) return false;
  let latest = -Infinity;
  for (const e of amr) {
    if (typeof e !== 'object' || e === null) continue;
    const { method, timestamp } = e as { method?: unknown; timestamp?: unknown };
    if (method === 'otp' && typeof timestamp === 'number' && Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  if (latest === -Infinity) return false;
  const age = nowMs / 1000 - latest;
  return age >= -60 && age <= maxAgeS;
}
