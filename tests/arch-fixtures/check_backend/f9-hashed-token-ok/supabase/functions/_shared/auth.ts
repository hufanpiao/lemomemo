// 样例用的账号检查（真的在 supabase/functions/_shared/auth.ts）
export async function isUsable(userId: string): Promise<boolean> {
  return userId !== '';
}
