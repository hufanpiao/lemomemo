// 违规 F4：Pages 里读服务器函数的令牌 R2_FN_*
export const x = (env: Record<string, string>) => env['R2_FN_ACCESS_KEY_ID'];
