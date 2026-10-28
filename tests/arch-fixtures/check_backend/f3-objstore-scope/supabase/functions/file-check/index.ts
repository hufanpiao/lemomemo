// 违规 F3：九个函数之一，却读了 Pages 的令牌 R2_FILES_*（服务器函数只用 R2_FN_*）
import { store } from '../_shared/objstore.ts';
export const k = [store, Deno.env.get('R2_FILES_ACCESS_KEY_ID')];
