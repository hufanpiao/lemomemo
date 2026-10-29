// 邀请码（架构 5.6、15.3 第 8 条：12 位，32 个字符的字母表，去掉 0/O/1/I 等易混字符，约 60 bit；库里只存哈希）。
// invite-signup 校验、invite-admin 发码都用这一份，不另写一套。
// 不读环境变量、不 import npm 包。

/** 32 个字符：A–Z 去掉 I、O（24 个）+ 2–9（8 个） */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_LEN = 12;

const FORMAT = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_LEN}}$`);

/** 去掉空格和横线、转大写（和前端 normalizeInvite 同一个规则） */
export function normalizeInviteCode(s: string): string {
  return s.replace(/[\s-]/g, '').toUpperCase();
}

export function isInviteCode(s: string): boolean {
  return FORMAT.test(s);
}

/**
 * 生成一个新邀请码（invite-admin 用）：12 个字符，每个字符取 crypto.getRandomValues 一个字节的低 5 位。
 * 字母表正好 32 个字符、256 是 32 的倍数，所以每个字符均匀，不用拒绝采样。random 只给测试注入。
 */
export function randomInviteCode(random: (buf: Uint8Array) => void = (b) => { crypto.getRandomValues(b); }): string {
  const buf = new Uint8Array(INVITE_LEN);
  random(buf);
  let out = '';
  for (const b of buf) out += INVITE_ALPHABET.charAt(b & 31);
  return out;
}

/** private.invites.code_hash：规范化以后的 SHA-256（十六进制）。码本身约 60 bit 随机、7 天过期，不另加密钥 */
export async function inviteCodeHash(code: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`invite:${normalizeInviteCode(code)}`)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
