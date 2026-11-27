// 违规 F1：和名单同名的预览专用函数也不准读（另报 F6：不在预览名单里）
export const k = Deno.env.get('SIGNUP_HASH_SECRET');
