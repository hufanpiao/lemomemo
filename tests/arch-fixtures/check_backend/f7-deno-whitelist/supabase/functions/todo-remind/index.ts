// 违规 F7：标识符里的 \u 转义单独一行（不带 Deno 字样）
const \u0045 = 1; export const e = E;
// 对照：Deno.env.get / has 写字面量、Deno.serve 不报；字符串、正则里的 \u 不报；字符串里的英文 process 不报
export const k = Deno.env.get('PUSH_VAPID_KEY');
export const h = Deno.env.has("PUSH_VAPID_KEY");
const nbsp = '\u00a0'; const bad = /[\u0000-\u001f]/;
export const msg = `failed to process ${nbsp}`;
Deno.serve(() => new Response(bad.source + msg));
