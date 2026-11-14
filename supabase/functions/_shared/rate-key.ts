// 每分钟限流的 counters 键（附录 A 三段写法 <用途>:<user_id>:<UTC 分钟>），第三段一律 yyyymmddhhmm（12 位数字，不带 T）。
// 11-14 隐私记整块评审第 15 条：原来 vault/common.ts、vault-image/core.ts、_shared/ai/gate.ts 各写一份，前两份带 T、ai 那份不带；
//   以已上线的 ai-rate 写法为准（不带 T），vault-min、vault-img-min 跟着改（还没上线，没有旧键要兼容）。
// 纯函数，不 import 任何东西，Vitest 直接测的 core.ts 可以引。

export function utcMinuteKey(prefix: string, userId: string, ms: number): string {
  return `${prefix}:${userId}:${new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, '')}`;
}

/** 每小时限流的键：第三段 yyyymmddhh（10 位数字；B4b-1 vault-file 的 ms_preview 每人每小时 20 次用） */
export function utcHourKey(prefix: string, userId: string, ms: number): string {
  return `${prefix}:${userId}:${new Date(ms).toISOString().slice(0, 13).replace(/[-T:]/g, '')}`;
}
