// 违规 F1（K2，架构 0.38 第 24 条）：account 不在名单里（名单是 account-purge）
export const k = Deno.env.get('SIGNUP_HASH_SECRET');
