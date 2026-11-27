// F12 样例：函数里自己拼 json 响应（注释里写 new Response(JSON.stringify( 不算）
Deno.serve(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
