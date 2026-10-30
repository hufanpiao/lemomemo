// invite-signup 的回包、请求体、邮件和哈希小工具（从 core.ts 拆出，B1 第九批 lint 超行清零；代码原样搬过来，
// 原来模块内部用的几个改成导出给 core.ts 用；对外的名字仍由 core.ts 转出）。
// 只给 core.ts 用，对外接口以 core.ts 的导出为准：别的文件（index.ts、测试）不要直接从这里引。
// 和 core.ts 一样：不 import npm 包、不碰运行时全局（只用 Web 标准的 crypto、Response）。

import { hmacHex, normalizeEmail } from '../_shared/email-hash.ts';
import type { InviteErr, Locale } from './types.ts';

const MAX_BODY = 4096;

// ---------------- 小工具 ----------------
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
export const err = (status: number, code: InviteErr) => json(status, { error: code });

export class Fail extends Error {
  readonly status: number;
  readonly code: InviteErr;
  constructor(status: number, code: InviteErr) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** 6 位数字，拒绝采样保证均匀 */
export function secureOtp(): number {
  const lim = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const a = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(a);
    const v = a[0] ?? 0;
    if (v < lim) return v % 1_000_000;
  }
}

/** UTC 日期 yyyymmdd（signup:global 键的第三段） */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 计数键（附录 A counters 键表；都得过 counters 的 check 约束，单测核对） */
export const keys = {
  ip: (ipPart: string) => `signup-ip:ip:${ipPart}`,
  verifyIp: (ipPart: string) => `signup-verify:ip:${ipPart}`,
  mail: (eh: string) => `signup-mail:mail:${eh}`,
  global: (ms: number) => `signup:global:${utcDate(ms)}`,
};

/** 验证码哈希：和邮箱、邀请码绑定（K2 安全审查低 2：换一个码就对不上，不能拿同一个验证码去占别的码） */
export function otpHash(secret: string, eh: string, codeHash: string, otp: string): Promise<string> {
  return hmacHex(secret, `otp:${eh}:${codeHash}:${otp}`);
}

// ---------------- 请求体 ----------------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface StartBody { email: string; code: string; captchaToken: string; locale: Locale }
export interface VerifyBody { email: string; code: string; otp: string; locale: Locale }

export function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}
export function locale(v: unknown): Locale {
  return v === 'ko-KR' ? 'ko-KR' : 'zh-CN';
}
export function email(v: unknown): string | null {
  const s = str(v, 254);
  if (s === null) return null;
  const e = normalizeEmail(s);
  return EMAIL.test(e) ? e : null;
}

export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------- 邮件（不写邀请人；统一称“柠檬记的负责人”，R-83、R-105） ----------------
export function signupMail(loc: Locale, otp: string): { subject: string; text: string } {
  if (loc === 'ko-KR') {
    return {
      subject: `레모 가입 인증 코드 ${otp}`,
      // R-106 B1 第一遍已审（10-31），按审校意见 K-04 改过：和登录验证码邮件 otp.html 的两句一字不差
      text: `레모 가입 인증 코드: ${otp}\n\n10분 동안 유효해요. 직접 요청하지 않았다면 이 메일은 무시해 주세요.`,
    };
  }
  return {
    subject: `柠檬记注册验证码 ${otp}`,
    text: `你的柠檬记注册验证码：${otp}\n\n10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
  };
}
