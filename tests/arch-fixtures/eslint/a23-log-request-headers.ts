// arch-fixture: path=supabase/functions/remind-tick/index.ts expect=lemo/no-log-request
// 违规：不准把请求头打进日志
export async function handle(req: Request): Promise<Response> {
  console.log('got', req.headers);
  return new Response('ok');
}
