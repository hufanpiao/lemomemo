// usage-report 的 {part: "usage"}（架构 3.4 用量盯防、6.1 第二条；B0-R2 任务单 R2 提醒线；开发计划 B7a）。
// lemo-ops 每天 UTC 00:07 调一次（USAGE_CHECK=on 时），把 items 里每项的 pct 和 rules.ts 的 USAGE_LINES 比。
// 只回百分比、个数和字节数，不回任何 user_id、文件名。不 import npm 包、不碰 Deno 全局：读取由 index.ts 注入。
//
// 每项读取各自计时（side.ts）：哪项读不到只把它挪进 unreadable，其余照常回 200——
// lemo-ops 的 parseUsageItems 要求 items 里每项都有数字 pct，读不到的项不能放进 items（否则整份当成“用量查询失败”）。
//
// 测不了的（如实写在这里，不造数）：
//   • Supabase 流出流量（egress）：Supabase 没有公开接口能读，只能在控制台 Usage 页看；
//   • R2 的存储是**整个 Cloudflare 账号**的免费额度，这里只数本环境四个桶（预览、正式各算各的），两边加起来才是账号总量。
import { json } from '../_shared/http.ts';
import { backupDate } from '../_shared/backup-format.ts';
import { utcDate } from '../_shared/rate-key.ts';
import { startSide } from './side.ts';

/** 免费版额度（十进制字节，比控制台的 GiB 小一点、提醒更早）：Supabase 数据库 500 MB、文件存储 1 GB；R2 存储 10 GB-月、A 类 100 万次、B 类 1000 万次（每月） */
export const LIMITS = {
  db_bytes: 500e6,
  storage_bytes: 1e9,
  r2_bytes: 10e9,
  r2_write_ops: 1_000_000,
  r2_read_ops: 10_000_000,
} as const;

/** 本环境的四个 R2 桶：和 storage-sweep、account-purge 共用 _shared/objstore-buckets.ts 一份（B7a 评审第 15 条）；shared/manifests 里 store: 'r2' 的桶测试核对 */
export { R2_BUCKETS } from '../_shared/objstore-buckets.ts';

/** 当天导出分片上限：和 account/common.ts 的 EXPORT_LIMITS.partDailyLimit 是同一个数（测试核对两边一致） */
export const EXPORT_PART_DAILY_LIMIT = 72;

/** 每项读取的超时：lemo-ops 等 usage-report 10 秒（USAGE_REPORT_TIMEOUT_MS），各项并行，留出余量 */
export const USAGE_SIDE_TIMEOUT_MS = 7_000;

/** private.usage_stats() 的一行（迁移 20261126100000） */
export interface UsageStats {
  db_bytes: number;
  vectors_bytes: number;
  storage_bytes: number;
  media_max_pct: number;
  media_near_full: number;
  export_capped: number;
}

/** R2 本月（UTC 月初到现在）操作次数，整个账号：write = A 类，read = B 类 */
export interface R2Ops {
  write: number;
  read: number;
}

/** 各读取都必须尊重 signal（超时后中止） */
export interface UsageSources {
  /** rpc private.usage_stats(p_days, p_export_cap)；回第一行（不判对错，交给 pickStats） */
  stats(days: readonly string[], exportCap: number, signal: AbortSignal): Promise<unknown>;
  /** 本环境四个 R2 桶的字节合计；R2 没配时不提供 */
  r2Bytes?(signal: AbortSignal): Promise<number>;
  /** Cloudflare GraphQL 读本月操作次数；没配 CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN 时不提供（这两项就不出现） */
  r2Ops?(signal: AbortSignal): Promise<R2Ops>;
  /** rpc private.backup_missing(p_date)：这一天该有服务器备份、却没有 _manifest 的账号数（迁移 20261126130000，B7a 评审第 11 条） */
  backupMissing(date: string, signal: AbortSignal): Promise<unknown>;
}


interface Item {
  key: string;
  label: string;
  pct: number;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** 百分比向下取整；超过 100 照报（R2 存储到 100 就是“已开始收费”） */
export const pctOf = (used: number, limit: number): number => Math.floor((used * 100) / limit);

function pickStats(r: unknown): { out: UsageStats | null; code?: string } {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return { out: null, code: 'stats:bad_data' };
  const d = r as Record<string, unknown>;
  const keys = ['db_bytes', 'vectors_bytes', 'storage_bytes', 'media_max_pct', 'media_near_full', 'export_capped'] as const;
  // bigint 列经 PostgREST 可能是字符串：只收纯数字串，转成数后仍须是安全整数
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = d[k];
    const n = typeof v === 'string' && /^[0-9]{1,18}$/.test(v) ? Number(v) : v;
    if (!isCount(n)) return { out: null, code: 'stats:bad_data' };
    out[k] = n;
  }
  return { out: out as unknown as UsageStats };
}

const pickCount = (tag: string) => (r: unknown): { out: number | null; code?: string } =>
  isCount(r) ? { out: r } : { out: null, code: `${tag}:bad_data` };

function pickOps(r: unknown): { out: R2Ops | null; code?: string } {
  if (typeof r !== 'object' || r === null) return { out: null, code: 'r2_ops:bad_data' };
  const { write, read } = r as Record<string, unknown>;
  return isCount(write) && isCount(read) ? { out: { write, read } } : { out: null, code: 'r2_ops:bad_data' };
}

/** 导出分片按 UTC 日期计数：查昨天和今天两天（lemo-ops 每天 00:07 UTC 跑，“今天”才刚开始，主要看昨天） */
export function exportDays(now: number): string[] {
  return [utcDate(now - 86_400_000), utcDate(now)];
}

export async function usagePart(src: UsageSources, now: number, log?: (code: string) => void, ms = USAGE_SIDE_TIMEOUT_MS): Promise<Response> {
  const stats = startSide((s) => src.stats(exportDays(now), EXPORT_PART_DAILY_LIMIT, s), ms, 'stats', pickStats, log);
  const r2b = src.r2Bytes ? startSide(src.r2Bytes.bind(src), ms, 'r2_bytes', pickCount('r2_bytes'), log) : null;
  const ops = src.r2Ops ? startSide(src.r2Ops.bind(src), ms, 'r2_ops', pickOps, log) : null;
  // 首尔今天（和 backup-daily 的日期目录同一份 backupDate）：lemo-ops UTC 00:07 调，是首尔 09:07，当天 00:30 的备份、02:30 的补跑都该做完了
  const miss = startSide((s) => src.backupMissing(backupDate(now), s), ms, 'backup_missing', pickCount('backup_missing'), log);
  const [st, bytes, op, missing] = await Promise.all([stats.done, r2b?.done ?? null, ops?.done ?? null, miss.done]);

  const items: Item[] = [];
  const unreadable: { key: string; label: string }[] = [];
  const add = (key: string, label: string, pct: number | null) => (pct === null ? unreadable.push({ key, label }) : items.push({ key, label, pct }));

  add('db', 'Supabase 数据库大小', st ? pctOf(st.db_bytes, LIMITS.db_bytes) : null);
  add('supabase_storage', 'Supabase 文件存储', st ? pctOf(st.storage_bytes, LIMITS.storage_bytes) : null);
  add('user_media', '单个账号存储占自己上限的最高比例', st ? st.media_max_pct : null);
  if (r2b) add('r2_storage', 'R2 存储（本环境四个桶）', bytes === null ? null : pctOf(bytes, LIMITS.r2_bytes));
  if (ops) {
    add('r2_ops_write', 'R2 本月写操作（A 类，整个账号）', op ? pctOf(op.write, LIMITS.r2_write_ops) : null);
    add('r2_ops_read', 'R2 本月读操作（B 类，整个账号）', op ? pctOf(op.read, LIMITS.r2_read_ops) : null);
  }

  // 不是百分比，不进 items；读不到时进 unreadable（lemo-ops 的 usage:backup_missing 原样保留）
  if (missing === null) unreadable.push({ key: 'backup_missing', label: '今天没有服务器备份的账号数' });

  return json(200, {
    ok: true,
    items,
    // 读不到的项（日志里有 stats:/r2_bytes:/r2_ops: 开头的错误码）；lemo-ops 报“有几项用量读不到”
    unreadable,
    // 个数：到 90% 的账号数、昨天或今天导出分片到上限的账号数（0.47 第 19 条 Q6）；读不到为 null
    media_near_full: st ? st.media_near_full : null,
    export_capped: st ? st.export_capped : null,
    // 首尔今天该有却没有服务器备份的账号数；读不到为 null（lemo-ops 大于 0 或读不到都告警）
    backup_missing: missing,
    // 原始字节数，给人看（lemo-ops 不用）
    bytes: { db: st?.db_bytes ?? null, vectors: st?.vectors_bytes ?? null, supabase_storage: st?.storage_bytes ?? null, r2: bytes },
  });
}
