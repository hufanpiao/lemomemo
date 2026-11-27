// 样例用的哈希（真的在 supabase/functions/_shared/intake-token.ts）
export async function tokenHash(t: string): Promise<string> {
  return t.length.toString(16);
}
