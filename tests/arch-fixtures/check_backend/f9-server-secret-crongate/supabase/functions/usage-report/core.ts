// F9 ⑤ 对照样例：读了头，直接交给 cronGate（读头写在参数里），不报
import { cronGate } from '../_shared/http.ts';

export function handle(req: Request, secret: string | undefined): Response {
  const denied = cronGate(req.headers.get('x-ops-secret'), secret);
  return denied ?? new Response('ok');
}
