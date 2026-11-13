// 按 user_id 批量读的两件共用小事（B5 整块评审第 25 条：push-dispatch/store.ts 和 anniv-roll/store.ts 原来各写一份）：
// • inChunks：.in(...) 分批（代码审查 M5：一批最多 IN_CHUNK 个 UUID，500 个约 18.5 KB 查询串可能被网关回 414 / 400）；先去重，批与批之间按顺序发
// • liveSettings：只认“活着”的设置（没软删、没撤销，和本机 remind-settings 同一口径；撤销了的按没设处理，11-04），按人合成 {key: value}
// 出错怎么报由调用方的 must 决定（push-dispatch 要分超时、数据类错误；anniv-roll 只要失败）。
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;
type Must = <T>(r: { data: T | null; error: unknown }) => T;

/** .in(...) 一批最多放多少个 UUID（100 个约 3.7 KB） */
export const IN_CHUNK = 100;

/** 按 IN_CHUNK 分批跑同一个查询、合并结果（先去重；空列表不发请求）。批与批之间按顺序发，不并发 */
export async function inChunks<T>(ids: readonly string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const all = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < all.length; i += IN_CHUNK) out.push(...(await run(all.slice(i, i + IN_CHUNK))));
  return out;
}

/** 这些人的这几个设置（没软删、没撤销的）：user_id → {key: value}；一项都没有的人不在 Map 里 */
export async function liveSettings(admin: Admin, userIds: readonly string[], keys: readonly string[], must: Must): Promise<Map<string, Record<string, unknown>>> {
  const rows = await inChunks(userIds, async (c) => must(await admin.from('settings').select('user_id, key, value').in('user_id', c)
    .in('key', [...keys]).is('deleted_at', null).eq('undone', false)) as { user_id: string; key: string; value: unknown }[]);
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) out.set(r.user_id, { ...(out.get(r.user_id) ?? {}), [r.key]: r.value });
  return out;
}
