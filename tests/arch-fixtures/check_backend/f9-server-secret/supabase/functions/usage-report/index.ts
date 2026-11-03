// D2-3 ② 样例：读了头，但用 !== 比较，没调 safeEqual
export function handle(req: Request, secret: string): Response {
  const got = req.headers.get('x-ops-secret') ?? '';
  if (got === '' || got !== secret) return new Response(null, { status: 401 });
  return new Response('ok');
}
