// ⑦ 合规样例：读 Authorization、交给 _shared/http.ts 的 bearerGate、读 BACKUP_PULL_TOKEN
import { bearerGate } from '../_shared/http.ts';
export function handle(req: Request): Response {
  const denied = bearerGate(req.headers.get('authorization'), Deno.env.get('BACKUP_PULL_TOKEN'));
  if (denied) return denied;
  return new Response('ok');
}
