// D2-3 ① 样例：不在 SERVER_SECRET_FUNCTIONS 里
import { safeEqual } from '../_shared/eq.ts';
export function handle(req: Request, secret: string): Response {
  const got = req.headers.get('x-ops-secret') ?? '';
  if (got === '' || !safeEqual(got, secret)) return new Response(null, { status: 401 });
  return new Response('ok');
}
