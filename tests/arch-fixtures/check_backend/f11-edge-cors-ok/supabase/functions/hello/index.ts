// F11 对照样例：函数只回业务头；注释里提到 Access-Control-Allow-Origin 不算
Deno.serve(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
