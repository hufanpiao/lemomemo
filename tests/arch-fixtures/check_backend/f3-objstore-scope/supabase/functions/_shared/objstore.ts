// 迷你 _shared/objstore.ts：服务器函数里读 R2_* 的只有它
import { createObjStore } from './gen/objstore.ts';
export const store = () => createObjStore(Deno.env.get('R2_FN_ACCESS_KEY_ID'), Deno.env.get('R2_ENDPOINT'));
