// 名单外的函数：照抄了按哈希查表，也不准关 verify_jwt
import { tokenHash } from '../_shared/intake-token.ts';
export async function handle(req: Request, db: { from(t: string): { eq(c: string, v: string): Promise<unknown> } }): Promise<Response> {
  await db.from('api_tokens').eq('token_hash', await tokenHash(req.headers.get('authorization') ?? ''));
  return new Response('ok');
}
