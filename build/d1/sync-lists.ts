// D1 第 7 节（R-350 评审第 1 条，11-13）：数据库里三处手写的同步表名单，和清单的 tables.filter(sync) 逐张比对。
// 加一张同步表时这三处都要跟着改，以前没有检查守着，漏了只能靠人看（R-350 一开始就漏了 cleanup_batch 和 export_size_over）：
// • public.tombstones 的 tombstones_tbl_check：check 里的表名 = 全部同步表（write_tombstone 挂在每张同步表上，少一张硬删就写不进墓碑）；
// • public.apply_patch 的 case p_table：每个 when '表' then array[…] = 全部同步表（少一张，客户端的修改回 patch_table_not_allowed 被丢）；
// • private.cleanup_batch：每张软删同步表都有一句 “public.表 where deleted_at < cut30”（少一张，软删的行永远不硬删）。
//   devices 除外：设备行按“会话已不在”和“180 天没用”两条规则清（迁移 20261111120000 起），不按 deleted_at。
// 以后改成 table_meta 驱动（patch_cols、purge_30d 两列）时，这里改成比 table_meta（方案-R350 “以后加表前先做”）。
// 纯函数 syncListProblems 单独导出给 tests/build/d1-sync-lists.test.ts 逐条证明
import type { Query } from './checks.ts';

/** 软删同步表里不走 30 天清理的表和理由 */
export const CLEANUP_30D_EXEMPT: Readonly<Record<string, string>> = { devices: '按会话已不在、180 天没用两条规则清' };

export interface SyncListSources {
  /** pg_get_constraintdef(tombstones_tbl_check)；约束不在是 null */
  tombCheck: string | null;
  /** public.apply_patch 的 prosrc；函数不在是 null */
  applyPatch: string | null;
  /** private.cleanup_batch 的 prosrc；函数不在是 null */
  cleanup: string | null;
}

const names = (re: RegExp, s: string): string[] => [...s.matchAll(re)].map((m) => m[1] ?? '');
const same = (a: readonly string[], b: readonly string[]): boolean => [...new Set(a)].sort().join(',') === [...new Set(b)].sort().join(',');
const gap = (want: readonly string[], have: readonly string[]): string => {
  const miss = want.filter((x) => !have.includes(x)), extra = have.filter((x) => !want.includes(x));
  return [miss.length ? `少了 ${miss.sort().join(', ')}` : '', extra.length ? `多了 ${[...new Set(extra)].sort().join(', ')}` : ''].filter(Boolean).join('；');
};

/** sync = 清单里 sync: true 的 public 表名；softDel = 其中 softDelete: true 的 */
export function syncListProblems(src: SyncListSources, sync: readonly string[], softDel: readonly string[]): string[] {
  const out: string[] = [];
  if (src.tombCheck === null) out.push('tombstones_tbl_check 不在');
  else {
    const have = names(/'([a-z_0-9]+)'/g, src.tombCheck);
    if (!same(have, sync)) out.push(`tombstones_tbl_check 的表名单和清单的同步表不一致：${gap(sync, have)}`);
  }
  if (src.applyPatch === null) out.push('public.apply_patch 不在');
  else {
    const have = names(/when\s+'([a-z_0-9]+)'\s+then\s+array\s*\[/gi, src.applyPatch);
    if (!same(have, sync)) out.push(`apply_patch 的 case p_table 表名单和清单的同步表不一致：${gap(sync, have)}`);
  }
  if (src.cleanup === null) out.push('private.cleanup_batch 不在');
  else {
    for (const t of softDel) {
      if (Object.hasOwn(CLEANUP_30D_EXEMPT, t)) continue;
      if (!new RegExp(`\\bpublic\\.${t}\\s+where\\s+deleted_at\\s*<\\s*cut30\\b`, 'i').test(src.cleanup)) {
        out.push(`cleanup_batch 没有清 ${t} 软删超过 30 天的行（要有 “public.${t} where deleted_at < cut30”）`);
      }
    }
  }
  return out;
}

/** 从库里取三处来源再比 */
export async function syncListDbProblems(q: Query, sync: readonly string[], softDel: readonly string[]): Promise<string[]> {
  const one = async (sql: string): Promise<string | null> => (await q<{ s: string }>(sql))[0]?.s ?? null;
  return syncListProblems({
    tombCheck: await one(`select pg_get_constraintdef(c.oid) as s from pg_constraint c
      where c.conname = 'tombstones_tbl_check' and c.conrelid = 'public.tombstones'::regclass`),
    applyPatch: await one(`select p.prosrc as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'apply_patch'`),
    cleanup: await one(`select p.prosrc as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'cleanup_batch'`),
  }, sync, softDel);
}
