// arch-fixture: path=supabase/functions/vault/index.ts expect=no-console
// 违规：vault 函数一律不准 console.*
export function handle(): Response {
  console.info('vault called');
  return new Response('ok');
}
