// ⑥ 违规 3：自己定义 tokenHash、按明文连接码查、没查有效期（tokenLive）、没查账号（isUsable）
async function tokenHash(t: string): Promise<string> {
  return t;
}
export async function handle(req: Request, db: { from(t: string): { eq(c: string, v: string): Promise<unknown> } }): Promise<Response> {
  const token = (req.headers.get('authorization') ?? '').slice(7);
  await tokenHash(token);
  await db.from('api_tokens').eq('token', token);
  return new Response('ok');
}
