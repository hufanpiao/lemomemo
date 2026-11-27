// 样例用的 Bearer 闸（真的在 supabase/functions/_shared/http.ts）
export function bearerGate(authorization: string | null, secret: string | undefined): Response | null {
  return authorization !== null && secret !== undefined ? null : new Response(null, { status: 401 });
}
