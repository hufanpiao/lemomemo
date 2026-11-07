// ⑥ 合规样例：读 Authorization、从 _shared/intake-token.ts import tokenHash、按 token_hash 查 api_tokens、tokenLive、scopes 含 create、isUsable
import { isUsable } from '../_shared/auth.ts';
import { tokenHash, tokenLive } from '../_shared/intake-token.ts';
type Db = { from(t: string): { eq(c: string, v: string): Promise<{ created_at: string; revoked_at: string | null; user_id: string; scopes: string[] } | null> } };
export async function handle(req: Request, db: Db): Promise<Response> {
  const token = (req.headers.get('authorization') ?? '').slice(7);
  const row = await db.from('api_tokens').eq('token_hash', await tokenHash(token));
  if (!row || !tokenLive(row, Date.now()) || !row.scopes.includes('create')) return new Response(null, { status: 401 });
  if (!(await isUsable(row.user_id))) return new Response(null, { status: 403 });
  return new Response('ok');
}
