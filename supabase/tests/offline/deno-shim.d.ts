// 离线类型检查用：supabase/functions/_shared 里用到的 Deno 全局（真跑在 Deno 里，用 Deno 自带的类型）
declare namespace Deno {
  const env: { get(key: string): string | undefined };
}
