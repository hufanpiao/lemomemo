// 迷你 objstore.ts：读 R2_FN_*
export const store = () => Deno.env.get('R2_FN_ACCESS_KEY_ID');
