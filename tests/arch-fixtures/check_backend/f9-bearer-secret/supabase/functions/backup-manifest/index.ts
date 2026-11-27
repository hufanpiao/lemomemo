// ⑦ 违规 2：读了 Authorization 头和密钥，却自己用 === 比、没交给 bearerGate
export function handle(req: Request): Response {
  const auth = req.headers.get('authorization');
  const secret = Deno.env.get('BACKUP_PULL_TOKEN');
  if (auth === secret) return new Response('ok');
  return new Response(null, { status: 401 });
}
