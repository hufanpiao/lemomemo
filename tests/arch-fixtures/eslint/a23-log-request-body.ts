// arch-fixture: path=supabase/functions/ai-split/index.ts expect=lemo/no-log-request
// 违规：不准把请求体打进日志
export async function handle(req: Request): Promise<Response> {
  console.error('body', await req.json());
  return new Response('ok');
}
