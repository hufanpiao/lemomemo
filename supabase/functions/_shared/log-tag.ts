// 函数日志里认人的唯一写法（后端安全审查第 11 条）：HMAC-SHA256(服务器密钥, 'log-user:' + user_id) 的前 16 位十六进制。
// 不可反查：没有密钥算不出、也对不上 user_id；同一密钥下同一个人每次一样，能在日志里把同一个人的几行串起来。
// 原来 account-purge 的 short、invite-signup 的 orphan_user 记 user_id 前 8 位原文，account 的 userHash 是不加盐的 sha256（拿 user_id 一算就对上）。
// 密钥由 index.ts 传 SUPABASE_SERVICE_ROLE_KEY（三个函数本来就读它，不新增要负责人生成的密钥；SIGNUP_HASH_SECRET 按 check_backend F1 只准
//   invite-signup、account-purge 读，account 读不到）。'log-user:' 做域分隔，和别处同一把钥匙的用途不会撞。没配密钥记 '-'（不记）。
// 纯函数，只用 Web Crypto（经 email-hash.ts 的 hmacHex），Vitest 直接测的 core.ts 可以引。
import { hmacHex } from './email-hash.ts';

export async function logUserTag(secret: string | undefined, userId: string): Promise<string> {
  if (!secret) return '-';
  return (await hmacHex(secret, `log-user:${userId}`)).slice(0, 16);
}
