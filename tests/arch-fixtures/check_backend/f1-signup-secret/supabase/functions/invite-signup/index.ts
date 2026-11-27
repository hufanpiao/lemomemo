// 对照：invite-signup 能读；注释里写 SIGNUP_HASH_SECRET 不算
export const k = Deno.env.get('SIGNUP_HASH_SECRET');
