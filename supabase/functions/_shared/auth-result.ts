// 各函数 core.ts 的 Deps.authenticate 回的结果（11-14 隐私记整块评审第 16 条：原来 8 个函数的 core.ts / common.ts 各写一份）。
// index.ts 用 _shared/auth.ts 的 authResult(() => requireActiveUser(…)) 生成；测试注入假的。
// 纯类型，不 import 任何东西，Vitest 直接测的 core.ts 可以引。

/** 通过：user 是 requireActiveUser 回的那个人（各函数只用到其中几项，按需收窄）；不通过：直接回 response，code 是 AuthError 的码 */
export type AuthResult<U = { userId: string }> = { ok: true; user: U } | { ok: false; response: Response; code?: string | undefined };
