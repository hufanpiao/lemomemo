// UUID 整串核对（改善报告第七节“低风险的重复清理”：原来 src、sw 里各写一份正则，有的区分大小写有的不区分）
// • isUuid(v)：只认小写（Postgres、crypto.randomUUID 给的都是小写）
// • isUuid(v, true)：大小写都认（原来带 /i 的那几处；要不要统一成只认小写由主持人定，这里不改行为）
// 拼进更长的正则里的（推送 tag、提醒路由、对象存储前缀、zod 的 regex）不走这里
const LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 是不是一个整串的 UUID（8-4-4-4-12 位十六进制）；anyCase 为 true 时大写也认 */
export function isUuid(v: unknown, anyCase = false): v is string {
  return typeof v === 'string' && (anyCase ? ANY_CASE : LOWER).test(v);
}
