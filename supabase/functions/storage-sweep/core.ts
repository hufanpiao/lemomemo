// storage-sweep 的处理逻辑（架构 3.4“30 天清理分两段做”“孤儿清理”、第 6 节 storage-sweep 行；接手清单 P-b4-sweep-gate、P-b4-quota-sweep）：
// cron 函数，只收 POST，先鉴权（x-cron-secret 定长比较）再判配置。pg_cron 每天 17:30 UTC（首尔 02:30）调一次，03:00 的 SQL 清理删行之前先删对象。
// 数据库、R2 由 index.ts 注入，Vitest 直接测这一份。
// 一轮做什么：四个 R2 桶（_shared/objstore-buckets.ts）逐桶按页列对象（ListObjectsV2，每页最多 1000 个），
//   每个键按清单的路径规则拆出 user_id、note_id、id（或纪念日 id、头像 id），按页一次查回对应的行（只读定位列），逐个判：
//   • 对得上一行、行没删或删了不到 30 天 → 留着；
//   • 对得上一行、行的 deleted_at 早于 30 天前 → 删（“30 天清理”那一段：03:00 删行之前先删对象）；
//   • 对不上任何行（行没了、移进移出隐私记中断、附件被判 rejected、缩略图没登记、换掉的头像）→ 孤儿：对象超过 24 小时才删，
//     不到 24 小时的留着（先写行再传，传的那一刻还没行的不会被误删）；R2 没给 LastModified 的一律当新对象、不按孤儿删；
//   • 键拆不出来（不是清单里的任何一种路径）→ 不删，只计数 unknown（不是我们写的，交给人看）。
// 判“对得上”时 user_id 一律取路径第一段，并且要等于行的 user_id（H7：防止按别人的行删）；路径由 user_id、note_id、id、kind 重新拼，不用存下来的字符串。
// 服务器备份保留期（B7a 收口第 2 条，架构 15.7 第 7 项“服务器备份 7 天”；原来由 backup-daily 每人写完当天后删自己的，停用账号不再备份就永远不删）：
//   每一轮先做 backups 桶（Supabase Storage）：首尔日期早于“当天和前 6 天”、而且不在桶里最新 BACKUP_KEEP_DAYS 个日期里的日期目录
//   （时钟出错也删不到最近的备份），所有人（含停用、冷静期的）的 uuid 目录下的文件全删；不是 uuid 的目录、散放的文件、
//   用户目录里的子目录不删，只计 unknown（account-purge 遇到子目录也停）。只删不写：account-purge 的日期游标前提
//   （没人往旧日期里写，PURGE-date-cursor）不变。这一步最多用 BACKUP_BUDGET_MS，一轮最多删 BACKUP_MAX_DELETES 个，到了记 backup_budget_hit、backup_cap_hit
//   （和 R2 那一段的 budget_hit、cap_hit 分开，lemo-ops 的 sweep.ts 分开提示）；detail 加 backup_dates、backup_files 两个个数。
// 不碰 vault-preview（归 vault-file sweep），也不读 8 张私有表和 scan_ 视图（TC-B0-92、TC-B5-41）。
// 不经 account_usable：停用、冷静期的账号照常清理（TC-B1-109 all-users）。
// 护栏：一轮最多删 MAX_DELETES 个（到了就只列不删，cap_hit）；一轮最多跑 TIME_BUDGET_MS（到了停在当前桶，budget_hit）；
//   请求体带 {"dry_run": true} 时只数不删、不写心跳（上线前在预览先看一眼数字）。
// 轮换（B7a 评审第 10 条）：每天从不同的桶开始（UTC 日序号 ÷ 4 的余数），时间预算不够时后面的桶隔天也轮得到；
//   detail 记 start（这一轮从第几个桶开始）、buckets_done（列完了几个桶），budget_hit、cap_hit 为真时 lemo-ops 报“文件清理一轮没做完”
//   （usage-report 的 DETAIL_FIELDS_BY_NAME 放行这几个字段，workers/lemo-ops/src/sweep.ts 判）。
// 心跳 storage-sweep：只在这一轮没有删失败时写（删失败、读库失败都不写，lemo-ops 26 小时没心跳就告警）；detail 只是个数和布尔。
// 日志只记错误码（A23），不记路径、user_id。
import { BACKUP_DATE_RE, BACKUP_KEEP_DAYS, UUID_RE, backupDate } from '../_shared/backup-format.ts';
import { cronGate, json } from '../_shared/http.ts';
import { R2_BUCKETS, type R2Bucket } from '../_shared/objstore-buckets.ts';

export const HEARTBEAT = 'storage-sweep';
/** 归 storage-sweep 的四个桶（清单里 orphanSweep 不为 null 的 r2 桶；tests/functions/storage-sweep.test.ts 和清单比对） */
export const SWEEP_BUCKETS = R2_BUCKETS;
export type SweepBucket = R2Bucket;
/** “最近删除”留 30 天（和 03:00 的 SQL 清理、files_authorize_impl 的 keep_ms 同一口径） */
export const KEEP_MS = 30 * 86_400_000;
/** 孤儿超过 24 小时才删（清单 orphanSweep.after = '24 hours'） */
export const ORPHAN_AFTER_MS = 24 * 3_600_000;
/** 一轮最多删几个对象：读行出了没报错的问题（比如查回空）时，最多误删这么多，不会一轮清空整个桶 */
export const MAX_DELETES = 5000;
/** 一轮的时间预算（毫秒）：Edge Function 免费版墙钟上限 150 秒，留出写心跳和回应的余量 */
export const TIME_BUDGET_MS = 100_000;
export const LIST_PAGE = 1000;
/** backups 这一步最多用多久（剩下的留给四个 R2 桶） */
export const BACKUP_BUDGET_MS = 40_000;
/** backups 一轮最多删几个文件：1000 个账号每人每天约 23 个，每天到期一个日期约 2.3 万个，留一倍余量 */
export const BACKUP_MAX_DELETES = 50_000;
/** 一次删几个（Storage remove 一次最多 1000 个路径） */
export const BACKUP_DELETE_BATCH = 1000;
/** 同时列几个用户目录（1000 个账号一个日期 1000 次列目录） */
export const BACKUP_LIST_CONCURRENCY = 8;
const DAY_MS = 86_400_000;

const U = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** 附件扩展名 = note_files.kind（0004 的 check、清单 attachments.ts 的 DOC_TYPES） */
export const DOC_KINDS = ['pdf', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'doc', 'xls', 'ppt'] as const;
const NOTE_IMAGE_RE = new RegExp(`^(${U})/(${U})/(${U})(\\.t)?\\.webp$`);
const ANNIV_AVATAR_RE = new RegExp(`^(${U})/anniv/(${U})/(${U})\\.webp$`);
const ME_AVATAR_RE = new RegExp(`^(${U})/me/(${U})\\.webp$`);
const NOTE_FILE_RE = new RegExp(`^(${U})/(${U})/(${U})(?:\\.(${DOC_KINDS.join('|')})|(\\.t\\.webp))$`);

/** 拆出来的键 */
export type ParsedKey =
  | { kind: 'image'; uid: string; noteId: string; id: string; thumb: boolean }
  | { kind: 'file'; uid: string; noteId: string; id: string; ext: string | null; thumb: boolean }
  | { kind: 'anniv'; uid: string; annivId: string; avatarId: string }
  | { kind: 'me'; uid: string; avatarId: string };

export function parseKey(bucket: SweepBucket, key: string): ParsedKey | null {
  // 各组在正则里都是必有的（缩略图、扩展名两组除外）；?? '' 只为类型
  if (bucket === 'files' || bucket === 'vault-files') {
    const m = NOTE_FILE_RE.exec(key);
    return m ? { kind: 'file', uid: m[1] ?? '', noteId: m[2] ?? '', id: m[3] ?? '', ext: m[4] ?? null, thumb: m[5] !== undefined } : null;
  }
  const m = NOTE_IMAGE_RE.exec(key);
  if (m) return { kind: 'image', uid: m[1] ?? '', noteId: m[2] ?? '', id: m[3] ?? '', thumb: m[4] !== undefined };
  if (bucket !== 'images') return null;   // 头像只在 images 桶（清单 anniv.ts、core.ts）
  const a = ANNIV_AVATAR_RE.exec(key);
  if (a) return { kind: 'anniv', uid: a[1] ?? '', annivId: a[2] ?? '', avatarId: a[3] ?? '' };
  const me = ME_AVATAR_RE.exec(key);
  return me ? { kind: 'me', uid: me[1] ?? '', avatarId: me[2] ?? '' } : null;
}

/** deleted_at 是毫秒数（bigint，PostgREST 回数字；防万一也认数字字符串） */
type Ms = number | string | null;

export interface ImageRow { id: string; user_id: string; note_id: string; bucket: string; has_thumb: boolean; deleted_at: Ms }
export interface FileRow { id: string; user_id: string; note_id: string; kind: string; has_thumb: boolean; is_vault: boolean; check_status: string; deleted_at: Ms }
export interface AnnivRow { id: string; user_id: string; avatar_id: string | null; deleted_at: Ms }
export interface ProfileRow { user_id: string; avatar_id: string | null }

export interface SweepStore {
  /** note_images 的定位列（按 id） */
  images(ids: readonly string[]): Promise<ImageRow[]>;
  /** note_files 的定位列（按 id） */
  files(ids: readonly string[]): Promise<FileRow[]>;
  /** anniversaries 的定位列（按 id） */
  annivs(ids: readonly string[]): Promise<AnnivRow[]>;
  /** profiles 的 user_id、avatar_id（按 user_id） */
  profiles(userIds: readonly string[]): Promise<ProfileRow[]>;
  writeHeartbeat(detail: HeartbeatDetail): Promise<void>;
}

/** R2 只用到列一页、批量删（shared/objstore.ts 的 ObjStore 子集） */
export interface SweepR2 {
  list(bucket: string, prefix: string, opts?: { continuationToken?: string; maxKeys?: number }): Promise<{
    objects: { key: string; size: number; lastModified?: number }[];
    nextToken: string | null;
  }>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<number>;
}

/** backups 桶（Supabase Storage）只用到列一层、批量删 */
export interface SweepBackups {
  /** dir 下一层（'' 是桶根）：子目录 folder 为真 */
  list(dir: string): Promise<{ name: string; folder: boolean }[]>;
  /** 一次最多 BACKUP_DELETE_BATCH 个路径 */
  remove(paths: readonly string[]): Promise<void>;
}

export interface HeartbeatDetail {
  listed: number;
  kept: number;
  /** 行删了超过 30 天、这一轮要删的 */
  expired: number;
  /** 超过 24 小时、对不上任何行、这一轮要删的 */
  orphans: number;
  /** 对不上行、但不到 24 小时（或没有时刻）的，留着 */
  young: number;
  /** 键拆不出来的，留着 */
  unknown: number;
  /** 真删掉的个数（dry_run 时为 0） */
  deleted: number;
  /** 删失败的个数 */
  failed: number;
  ms: number;
  /** 这一轮从 SWEEP_BUCKETS 的第几个开始（0～3） */
  start: number;
  /** 这一轮列完了几个桶（budget_hit 时小于 4） */
  buckets_done: number;
  budget_hit: boolean;
  cap_hit: boolean;
  /** backups：这一轮处理的过期日期目录个数 */
  backup_dates: number;
  /** backups：这一轮判成要删的文件个数（真删掉的也算进 deleted，删失败的算进 failed） */
  backup_files: number;
  /** backups 这一步时间到了（BACKUP_BUDGET_MS），余下的过期日期明天接着删 */
  backup_budget_hit: boolean;
  /** backups 这一步要删的到了 BACKUP_MAX_DELETES，余下的明天接着删 */
  backup_cap_hit: boolean;
}

export interface Deps {
  cronSecret: string | undefined;
  store: SweepStore | null;
  r2: SweepR2 | null;
  backups: SweepBackups | null;
  now(): number;
  log(code: string): void;
  /** 测试用（默认 TIME_BUDGET_MS、MAX_DELETES、BACKUP_BUDGET_MS、BACKUP_MAX_DELETES） */
  budgetMs?: number;
  maxDeletes?: number;
  backupBudgetMs?: number;
  backupMaxDeletes?: number;
}

type Verdict = 'keep' | 'expired' | 'orphan' | 'young' | 'unknown';

const toMs = (v: Ms): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 一页里要用到的行 */
interface PageRows {
  images: Map<string, ImageRow>;
  files: Map<string, FileRow>;
  annivs: Map<string, AnnivRow>;
  profiles: Map<string, ProfileRow>;
}

async function loadRows(store: SweepStore, parsed: readonly (ParsedKey | null)[]): Promise<PageRows> {
  const ids = { image: [] as string[], file: [] as string[], anniv: [] as string[], me: [] as string[] };
  for (const p of parsed) {
    if (!p) continue;
    if (p.kind === 'image') ids.image.push(p.id);
    else if (p.kind === 'file') ids.file.push(p.id);
    else if (p.kind === 'anniv') ids.anniv.push(p.annivId);
    else ids.me.push(p.uid);
  }
  const [images, files, annivs, profiles] = await Promise.all([
    ids.image.length ? store.images(ids.image) : [],
    ids.file.length ? store.files(ids.file) : [],
    ids.anniv.length ? store.annivs(ids.anniv) : [],
    ids.me.length ? store.profiles(ids.me) : [],
  ]);
  return {
    images: new Map(images.map((r) => [r.id, r])),
    files: new Map(files.map((r) => [r.id, r])),
    annivs: new Map(annivs.map((r) => [r.id, r])),
    profiles: new Map(profiles.map((r) => [r.user_id, r])),
  };
}

/** 这个键对得上的那一行的 deleted_at（对得上返回 { deletedAt }，对不上返回 null）。user_id 一律按路径第一段比（H7） */
function matchRow(bucket: SweepBucket, p: ParsedKey, rows: PageRows): { deletedAt: number | null } | null {
  switch (p.kind) {
    case 'image': {
      const r = rows.images.get(p.id);
      if (!r || r.user_id !== p.uid || r.note_id !== p.noteId || r.bucket !== bucket || (p.thumb && !r.has_thumb)) return null;
      return { deletedAt: toMs(r.deleted_at) };
    }
    case 'file': {
      const r = rows.files.get(p.id);
      if (!r || r.user_id !== p.uid || r.note_id !== p.noteId || r.is_vault !== (bucket === 'vault-files')) return null;
      if (r.check_status === 'rejected') return null;   // 被判不合格的附件对象算孤儿（附录 A 0004 授权一行）
      if (p.thumb ? !r.has_thumb : p.ext !== r.kind) return null;
      return { deletedAt: toMs(r.deleted_at) };
    }
    case 'anniv': {
      const r = rows.annivs.get(p.annivId);
      if (!r || r.user_id !== p.uid || r.avatar_id !== p.avatarId) return null;   // 换掉的头像（不等于当前 avatar_id）是孤儿
      return { deletedAt: toMs(r.deleted_at) };
    }
    case 'me': {
      const r = rows.profiles.get(p.uid);
      return r && r.avatar_id === p.avatarId ? { deletedAt: null } : null;
    }
  }
}

export function verdictOf(bucket: SweepBucket, p: ParsedKey | null, lastModified: number | undefined, rows: PageRows, now: number): Verdict {
  if (!p) return 'unknown';
  const m = matchRow(bucket, p, rows);
  if (m) return m.deletedAt !== null && m.deletedAt < now - KEEP_MS ? 'expired' : 'keep';
  return lastModified !== undefined && now - lastModified > ORPHAN_AFTER_MS ? 'orphan' : 'young';
}

class OverBudget extends Error {}

/** 这一轮从第几个桶开始：UTC 日序号对桶数取余（一天一换） */
export function sweepStart(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) % SWEEP_BUCKETS.length;
}

/** 从 start 开始转一圈的桶顺序 */
export function rotate(start: number): SweepBucket[] {
  return SWEEP_BUCKETS.map((_, i) => SWEEP_BUCKETS.at((start + i) % SWEEP_BUCKETS.length) ?? 'images');
}

/**
 * backups 桶里该删的日期目录（升序）：首尔日期早于“当天和前 BACKUP_KEEP_DAYS - 1 天”，而且不在桶里最新的 BACKUP_KEEP_DAYS 个日期里
 * （服务器时钟往后跳了也删不到最近几天的备份）；不是 YYYY-MM-DD 的名字一律不碰
 */
export function expiredBackupDates(dates: readonly string[], nowMs: number): string[] {
  const valid = dates.filter((x) => BACKUP_DATE_RE.test(x)).sort();
  const newest = new Set(valid.slice(-BACKUP_KEEP_DAYS));
  const oldest = backupDate(nowMs - (BACKUP_KEEP_DAYS - 1) * DAY_MS);
  return valid.filter((x) => x < oldest && !newest.has(x));
}

/** 过期的服务器备份全删（所有人，含停用的）；列目录出错直接抛（整轮失败），删失败只计 failed、接着做 */
async function expireBackups(deps: Deps, b: SweepBackups, d: HeartbeatDetail, dryRun: boolean): Promise<void> {
  const t0 = deps.now();
  const budget = deps.backupBudgetMs ?? BACKUP_BUDGET_MS;
  const cap = deps.backupMaxDeletes ?? BACKUP_MAX_DELETES;
  const pending: string[] = [];
  const flush = async () => {
    const batch = pending.splice(0);
    if (!batch.length || dryRun) return;
    try {
      await b.remove(batch);
      d.deleted += batch.length;
    } catch {
      d.failed += batch.length;
      deps.log('delete_failed:backups');
    }
  };
  const root = await b.list('');
  d.unknown += root.filter((x) => !x.folder).length;
  for (const date of expiredBackupDates(root.filter((x) => x.folder).map((x) => x.name), t0)) {
    d.backup_dates++;
    const users = await b.list(date);
    d.unknown += users.filter((x) => !x.folder || !UUID_RE.test(x.name)).length;
    const dirs = users.filter((x) => x.folder && UUID_RE.test(x.name)).map((x) => `${date}/${x.name}`);
    for (let i = 0; i < dirs.length && !d.backup_cap_hit; i += BACKUP_LIST_CONCURRENCY) {
      if (deps.now() - t0 > budget) {
        await flush();
        throw new OverBudget();
      }
      const chunk = dirs.slice(i, i + BACKUP_LIST_CONCURRENCY);
      const listed = await Promise.all(chunk.map((dir) => b.list(dir)));
      for (const [j, items] of listed.entries()) {
        if (items.some((x) => x.folder)) { d.unknown++; continue; }   // 用户目录里不该有子目录：不删，交给人看
        for (const f of items) {
          if (d.backup_files >= cap) { d.backup_cap_hit = true; break; }
          d.backup_files++;
          pending.push(`${chunk.at(j) ?? ''}/${f.name}`);
          if (pending.length >= BACKUP_DELETE_BATCH) await flush();
        }
      }
    }
    await flush();
  }
}

/** 跑一轮：先删过期的服务器备份，再清四个 R2 桶；读库、列对象出错直接抛（整轮失败）；删失败只计 failed、接着做 */
export async function runSweep(deps: Deps, store: SweepStore, r2: SweepR2, dryRun: boolean, backups: SweepBackups): Promise<HeartbeatDetail> {
  const t0 = deps.now();
  const budget = deps.budgetMs ?? TIME_BUDGET_MS;
  const cap = deps.maxDeletes ?? MAX_DELETES;
  const start = sweepStart(t0);
  const d: HeartbeatDetail = {
    listed: 0, kept: 0, expired: 0, orphans: 0, young: 0, unknown: 0, deleted: 0, failed: 0, ms: 0, start, buckets_done: 0, budget_hit: false, cap_hit: false,
    backup_dates: 0, backup_files: 0, backup_budget_hit: false, backup_cap_hit: false,
  };
  try {
    await expireBackups(deps, backups, d, dryRun);
  } catch (e) {
    if (!(e instanceof OverBudget)) throw e;
    d.backup_budget_hit = true;
    deps.log('time_budget:backups');
  }
  let planned = 0;   // 判成要删的个数（含 dry_run 没真删的），按它卡 cap
  try {
    for (const bucket of rotate(start)) {
      let token: string | undefined;
      do {
        if (deps.now() - t0 > budget) throw new OverBudget();
        const page = await r2.list(bucket, '', token === undefined ? { maxKeys: LIST_PAGE } : { continuationToken: token, maxKeys: LIST_PAGE });
        token = page.nextToken ?? undefined;
        const items = page.objects.map((o) => ({ o, p: parseKey(bucket, o.key) }));
        const rows = await loadRows(store, items.map((x) => x.p));
        const now = deps.now();
        const toDelete: string[] = [];
        for (const { o, p } of items) {
          d.listed++;
          const v = verdictOf(bucket, p, o.lastModified, rows, now);
          if (v === 'keep') d.kept++;
          else if (v === 'young') d.young++;
          else if (v === 'unknown') d.unknown++;
          else {
            if (v === 'expired') d.expired++;
            else d.orphans++;
            if (planned >= cap) { d.cap_hit = true; continue; }
            planned++;
            toDelete.push(o.key);
          }
        }
        if (toDelete.length && !dryRun) {
          try {
            await r2.deleteMany(bucket, toDelete);
            d.deleted += toDelete.length;
          } catch {
            d.failed += toDelete.length;
            deps.log(`delete_failed:${bucket}`);
          }
        }
      } while (token !== undefined);
      d.buckets_done++;
    }
  } catch (e) {
    if (!(e instanceof OverBudget)) throw e;
    d.budget_hit = true;
    deps.log('time_budget');
  }
  d.ms = deps.now() - t0;
  return d;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
  if (denied) return denied;
  if (!deps.store || !deps.r2 || !deps.backups) {
    deps.log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  let dryRun = false;
  try {
    const text = await req.text();
    const body: unknown = text.trim() === '' ? {} : JSON.parse(text);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('bad');
    const v = (body as Record<string, unknown>)['dry_run'];
    if (v !== undefined && typeof v !== 'boolean') throw new Error('bad');
    dryRun = v === true;
  } catch {
    return json(400, { error: 'bad_request' });
  }
  let detail: HeartbeatDetail;
  try {
    detail = await runSweep(deps, deps.store, deps.r2, dryRun, deps.backups);
  } catch {
    deps.log('sweep_failed');
    return json(503, { error: 'try_later' });
  }
  if (dryRun) return json(200, { ok: true, dry_run: true, ...detail });
  if (detail.failed > 0) return json(503, { error: 'try_later', ...detail });   // 不写心跳：lemo-ops 26 小时后告警
  try {
    await deps.store.writeHeartbeat(detail);
  } catch {
    deps.log('heartbeat_failed');
    return json(503, { error: 'try_later' });
  }
  return json(200, { ok: true, ...detail });
}
