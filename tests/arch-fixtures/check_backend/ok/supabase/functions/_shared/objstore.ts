import { createObjStore } from './gen/objstore.ts';
export const store = () => createObjStore(Deno.env.get('R2_FN_ACCESS_KEY_ID'));
