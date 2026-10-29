// 违规 F7：标识符里的 \u 转义单独一行（不带 Deno 字样）
const \u0045 = 1; export const e = E;
// 对照：Deno.env.get / has 写字面量、Deno.serve 不报；正则里的 \u、字符串里的 \t 不报（字符串里的 \u 从 B1 接手清单 S3 起报，见 f7-string-escape）；字符串里的英文 process 不报
export const k = Deno.env.get('PUSH_VAPID_KEY');
export const h = Deno.env.has("PUSH_VAPID_KEY");
const nbsp = '\t'; const bad = /[\u0000-\u001f]/;
export const msg = `failed to process ${nbsp}`;
Deno.serve(() => new Response(bad.source + msg));
