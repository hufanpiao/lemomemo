// 邮箱哈希（架构 0.29 续第 48 条：pending_signups.email_hash 由 invite-signup 写，注销时 account 用同一个函数按账号邮箱算出哈希再删；
// TC-DEL-pending_signups：“算哈希用的是和 invite-signup 同一个函数”）。附录 A counters 键表的“邮箱的 HMAC”“IP 的 HMAC”也用这里。
// HMAC-SHA256，密钥由调用方传入（invite-signup、account 读同一个 secret，名字见 invite-signup/index.ts）；不读环境变量、不 import npm 包。
// 只存哈希：库里、计数键里都看不到邮箱原文和 IP。

const enc = new TextEncoder();

/** 邮箱统一写法：去掉首尾空白、转小写（GoTrue 存的也是小写） */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  if (!secret) throw new Error('hash_secret_missing');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** pending_signups.email_hash，也是 signup-mail 计数键的第三段。前缀 'email:' 做域分隔，和 IP、验证码的哈希不会撞 */
export function emailHash(secret: string, email: string): Promise<string> {
  return hmacHex(secret, `email:${normalizeEmail(email)}`);
}

/** signup-ip 计数键的第三段 */
export function ipHash(secret: string, ip: string): Promise<string> {
  return hmacHex(secret, `ip:${ip}`);
}
