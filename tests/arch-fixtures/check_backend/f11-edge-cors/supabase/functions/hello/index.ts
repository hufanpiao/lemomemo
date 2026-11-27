// F11 违规样例：Edge Function 自己加 CORS 头（注释里提到 Access-Control-Allow-Origin 不算）
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(() => {
  const h = new Headers(corsHeaders);
  h.set('Access-Control-Allow-Origin', '*');
  /* 块注释里的 access-control-allow-origin 也不算 */
  return new Response('ok', { headers: h });
});
