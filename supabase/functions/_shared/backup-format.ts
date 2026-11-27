// 每日备份在 backups 桶里的文件约定（架构第 10 节；backup-daily 写、backup-manifest 列、tools/backup 的 pull.ps1 和 restore-lib.mjs 读）。
// 服务器这边只此一份；PowerShell（tools/backup/backup-lib.ps1）和 Node（tools/backup/restore-lib.mjs）各有一份同名常量，
// tests/build/backup-format-sync.test.ts 逐个核对字面值一致。只 import _shared/rate-key.ts（UTC 日期的截取只此一份），Vitest 直接测。
//
// 目录：backups/<首尔日期 YYYY-MM-DD>/<user_id>/，下面只有文件、没有子目录（account-purge 遇到子目录就停，TC-DEL-bucket-backups）：
//   • 数据文件 <代>_<表>.json.gz 或切片 <代>_<表>.<序号>.json.gz：代是 a 或 b，同一天再做一次就写另一代，
//     写完最后的 _manifest.json.gz（覆盖上传，一次到位）才算换过去，然后删掉旧一代。中途失败时旧的 _manifest 和旧一代文件都还在；
//   • _manifest.json.gz：这一份备份的清单（每张表的行数、主键、文件名、字节数、sha256）。有它才算“做完了”；
//   • _running.<编号>.json.gz：正在做的认领标记（B7a 收口第 1 条），编号 = 轮次 × RUN_SLOTS + 段号（轮次从 1 起，段号 0 是这一轮的开头）。
//     一律“不存在才建”（Storage upsert=false：已有就回 statusCode 409 / KeyAlreadyExists，本机 lemo-e2e 实测同时 6 个只建成 1 个），
//     同一个编号只有一个请求建得成：两轮同时开始抢同一个轮次号、同一段被重发两份抢同一个段号、两边同时接管过期的一轮抢同一个新轮次号。
//     最新的一个标记没过期（RUNNING_TTL_MS 内建的）时补跑、再发起都跳过；做完全删。
// 文件名都过得了清单 backups 桶的 pathPattern（[a-z_]+(\.\d+)?\.json\.gz）。
// 保留：只留最近 BACKUP_KEEP_DAYS 个日期（当天和前 6 天），更早的由 storage-sweep 每天统一删（所有人，含停用的；B7a 收口第 2 条，架构 15.7 第 7 项“服务器备份 7 天”）。

import { utcDate } from './rate-key.ts';

export const BACKUP_BUCKET = 'backups';
export const MANIFEST_FILE = '_manifest.json.gz';
/** 每一轮留多少个段号（maxSegments 80 远小于它） */
export const RUN_SLOTS = 1000;
/** 认领标记：_running.<轮次 × RUN_SLOTS + 段号>.json.gz（轮次 ≥ 1，所以编号至少 4 位） */
export const RUNNING_RE = /^_running\.([1-9][0-9]{3,8})\.json\.gz$/;
export const runningFile = (epoch: number, k: number): string => `_running.${epoch * RUN_SLOTS + k}.json.gz`;
/** 标记的编号；不是标记回 null */
export function runningNo(name: string): number | null {
  const m = RUNNING_RE.exec(name);
  return m ? Number(m[1]) : null;
}
export const FILE_FORMAT = 'lemomemo-backup';
export const MANIFEST_FORMAT = 'lemomemo-backup-manifest';
export const RUNNING_FORMAT = 'lemomemo-backup-running';
export const GZIP = 'application/gzip';
/** 日期目录只有这一种写法（account-purge 的日期游标靠它，PURGE-date-cursor） */
export const BACKUP_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 数据文件：<代>_<表>[.<序号>].json.gz（序号 1～9999） */
export const DATA_FILE_RE = /^[ab]_[a-z_]+(\.[1-9][0-9]{0,3})?\.json\.gz$/;
/** 一个人目录下认得的全部文件名（数据文件、_manifest、_running） */
export const BACKUP_FILE_RE = /^(?:_manifest|_running\.[1-9][0-9]{3,8}|[ab]_[a-z_]+(?:\.[1-9][0-9]{0,3})?)\.json\.gz$/;
/** 最新的认领标记建了多久算过期（每段开头建一个新的；发下一段最多等 60 秒、重试一次；一段的墙钟时间远小于它） */
export const RUNNING_TTL_MS = 10 * 60_000;
/** 服务器备份留几天（按首尔日期数，含当天）；backup-manifest 列这么多天，account-purge 的日期游标永远照列最新的 BACKUP_KEEP_DAYS + 1 个 */
export const BACKUP_KEEP_DAYS = 7;

/** 首尔比 UTC 早 9 小时（没有夏令时） */
export const SEOUL_OFFSET_MS = 9 * 3_600_000;

/**
 * 首尔日期 YYYY-MM-DD：backup-daily 的日期目录、backup-manifest 回给 pull.ps1 的“今天”、usage-report 查当天没做完的人数，都用这一份
 * （B7a 复审“重复和简化”：原来 backup-daily/core.ts 的 backupDate、usage-report/usage.ts 的 seoulDate 各写一份）
 */
export function backupDate(ms: number): string {
  const d = utcDate(ms + SEOUL_OFFSET_MS);   // 首尔的 yyyymmdd，再加回横线
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export type Gen = 'a' | 'b';

/** 数据文件名：没切过的整张表 <代>_<表>.json.gz，切过的 <代>_<表>.<序号>.json.gz（序号从 1 起） */
export function dataFileName(gen: Gen, table: string, slice: number | null): string {
  return slice === null ? `${gen}_${table}.json.gz` : `${gen}_${table}.${slice}.json.gz`;
}

/** 数据文件属于哪一代；不是数据文件返回 null */
export function genOf(name: string): Gen | null {
  if (!DATA_FILE_RE.test(name)) return null;
  return name.startsWith('a_') ? 'a' : 'b';
}
