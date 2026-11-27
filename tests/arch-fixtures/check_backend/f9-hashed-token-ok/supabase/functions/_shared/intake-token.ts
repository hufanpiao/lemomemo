// 样例用的哈希和有效期（真的在 supabase/functions/_shared/intake-token.ts）
export async function tokenHash(t: string): Promise<string> {
  return t.length.toString(16);
}
export function tokenLive(row: { created_at: string; revoked_at: string | null }, now: number): boolean {
  return row.revoked_at === null && now >= 0;
}
