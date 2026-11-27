// backup-daily 的处理逻辑（架构第 10 节“服务器端”、第 6 节 backup-daily 行；ADR-016 第 1 条；0.29 续第 33、84 条；0.47 第 18 条提醒；
// TC-B7a-23、TC-B1-109、TC-DEL-bucket-backups）。数据库、备份桶、发下一段、心跳都由 index.ts 注入，Vitest 直接测这一份。
// 不 import npm 包、不碰 Deno 全局。
//
// 一次备份 = 一个人一天一份，放在 backups/<日期>/<user_id>/（文件约定见 _shared/backup-format.ts）：
//   • 日期按首尔时间（YYYY-MM-DD 一种写法，桶里不放别的目录；account-purge 的日期游标靠这一条，PURGE-date-cursor）；
//   • 按表一个文件 <代>_<表>.json.gz（内容 {"format":"lemomemo-backup","version":1,"table":…,"rows":[…]}），contentType 显式 application/gzip；
//   • 一张表在一段里写不完就切片：<代>_<表>.1.json.gz、<代>_<表>.2.json.gz…（恢复脚本按序号拼回）；
//   • 最后写 _manifest.json.gz：每张表的行数、主键列、每个文件的字节数和 sha256。没有它就是“这一天这个人的备份没做完”，
//     backup-manifest 标 complete: false，pull.ps1 不下载、写“失败原因.txt”。
// 同一天再做一次（发布前触发、补跑）不先删旧的（评审第 5 条）：新一轮写另一代（a、b 轮换），最后覆盖 _manifest 才算换过去，再删旧一代；
//   中途失败时旧的 _manifest 和旧一代文件原样留着，当天已有的那份备份不丢。
// 正在做的认领标记 _running.<轮次 × 1000 + 段号>.json.gz（_shared/backup-format.ts；评审第 6 条、B7a 复审第 3、4 条、收口第 1 条）：
//   一律原子创建（files.create = Storage upsert=false，已有就回 false），不再“覆盖写再读回”（两轮交错时两边都能读回自己写的，
//   同一毫秒覆盖写同一个对象本机实测还会 503）：
//   • 新一轮：轮次 = 目录里最大的轮次 + 1，建 _running.<轮次×1000>；建不成就是别人同时开始了，这一轮不开工（skipped: running）。
//     过期接管也走这一条（两边同时接管抢同一个新轮次号，只有一边建成）；建成了才删这一代的残片；
//   • 接力的一段：开头标记还是这一轮的（_running.<轮次×1000> 里的 run_id 对得上），再建 _running.<轮次×1000+段号>，
//     建不成就是同一段被重发了第二份；建成后目录里没有更大的轮次（没被接管）才接着做，否则停下（superseded）；
//   • 写 _manifest 前再核一次开头标记和轮次；做完删掉全部标记。
//   最新的标记没过期（RUNNING_TTL_MS 内建的）时 start、retry、publish 一律跳过；每段建一个新标记，等于续上有效期。
//   接管只在最新标记过期 10 分钟以后发生，一段的墙钟时间远小于它，所以被接管的旧一轮不会和新一轮同时写同一代。
// 保留期（服务器备份 7 天）不归这里：storage-sweep 每天统一删所有人（含停用的）过期的日期目录（B7a 收口第 2 条）。
// 哪些表进备份按数据清单 backup: 'json'（0.22），按清单 userLookup 的列找这个人的行（invites 按 created_by）；
//   没有用户数据的表（app_config）按人拆的备份放不进去，跳过（见 GLOBAL_TABLES_SKIPPED）。
//   隐私记四张表和 AI 长期记忆（TABLE_KEYS 里 rpc: true）经 private.backup_read 读（负责人 11-26：只给备份开一个专用读取口，
//   不给 service role 授这几张表的表级权限；迁移 20261126130000），其余表经 PostgREST 只读。
//
// 分段（0.47 第 18 条：一次调用 CPU 上限 2 秒，满载账号一次导不完）：每段原文预算 SEGMENT_RAW_BYTES（16 MB，和 account export 每片一样，
//   R1 实测单片 CPU 最多 0.52 秒），按主键往后翻页读，每读完一页查一次预算；到了就把手上这张表写成一片、把进度（state）交给下一段。
//   下一段由本函数自己发（deps.next，带 x-cron-secret 调自己，响应之后在后台发），每段都是一次新的调用、各自 2 秒 CPU。
//   发不出去重试一次；还不行这一天这个人就没有新的 _manifest，02:30 的补跑（mode: retry）在标记过期后从头再做一遍。
// mode：start（00:30 定时）、retry（02:30 补跑：已有 _manifest 跳过）、publish（发布前触发：单独计次数，不占每天的 startDailyLimit）。
//   三种都由 private.backup_dispatch(mode) 发（迁移 20261126130000）。
// 鉴权 x-cron-secret（_shared/http.ts 的 cronGate）；每段开头都过 isUsable：停用、冷静期账号跳过（TC-B1-109；冷静期里不再新增备份，0.29 续第 131 条③）。
// 日志只记错误码（A23），不打印 user_id、请求体、行内容。

import {
  BACKUP_DATE_RE, DATA_FILE_RE, FILE_FORMAT, GZIP, MANIFEST_FILE, MANIFEST_FORMAT, RUN_SLOTS, RUNNING_FORMAT, RUNNING_TTL_MS, UUID_RE,
  backupDate, dataFileName, genOf, runningFile, runningNo, type Gen,
} from '../_shared/backup-format.ts';
import { cronGate, json } from '../_shared/http.ts';
import { utcDayKey } from '../_shared/rate-key.ts';
import { sha256Hex } from '../_shared/body.ts';
import { gzipAll, keyOk as pagerKeyOk, nextKey, pageSize, type PageKeyType } from '../_shared/table-pager.ts';

export { BACKUP_BUCKET, GZIP, MANIFEST_FILE, RUNNING_RE, backupDate, runningFile } from '../_shared/backup-format.ts';

// ---------------- 常量（出处见行尾） ----------------
export const HEARTBEAT = 'backup-daily';
/** 文本主键（每人一次读完的小表 invites.code_hash、vault_credentials.credential_id）认的字符；比账号导出的宽 */
const TEXT_KEY = /^[A-Za-z0-9._~+/=-]{1,200}$/;

export const BACKUP_LIMITS = {
  /** 每段原文预算（每读完一页查一次，一段原文 ≤ 预算 + 一页） */
  segmentRawBytes: 16 * 1024 * 1024,
  /** 每页最多取几行；平均行宽超过 wideRowBytes 时按 pageRawBytes ÷ 平均行宽取，至少 minPage 行；每张表第一页 firstPage 行 */
  page: 250,
  firstPage: 50,
  minPage: 10,
  wideRowBytes: 8 * 1024,
  pageRawBytes: 2 * 1024 * 1024,
  /** 一次备份最多几段（80 × 16 MB ≈ 1.25 GB 原文，比 account export 预检放行的 480 MB 宽得多）；超了算数据异常、这次备份失败 */
  maxSegments: 80,
  /** 单个文件压缩后的上限（桶的单文件上限 50 MB，留 10 MB 余量；0.29 续第 33 条的 40 MB） */
  maxFileGzBytes: 40 * 1024 * 1024,
  /** 每人每天 start、retry 合计几次（cron 一次、补跑一次，再留两次余量）；publish 另算 */
  startDailyLimit: 4,
  /** 每人每天发布前触发几次（同一个 tag 原样重跑、换 tag 再发都算；够一天发几次版） */
  publishDailyLimit: 8,
  /** 一次备份从开始到最后一段最多多久（超过的 state 不认，免得旧进度写进新的一天） */
  runTtlMs: 6 * 3600_000,
  /** 正在做的标记多久没重写算过期 */
  runningTtlMs: RUNNING_TTL_MS,
  /** 请求体上限（state 里有已写文件的清单，几十张表也就几 KB） */
  maxBodyBytes: 64 * 1024,
};
export type BackupLimits = typeof BACKUP_LIMITS;

/** 按人拆的备份放不进去的表：没有用户数据（清单 noUserData）。全站配置在迁移里，恢复靠迁移和控制台 */
export const GLOBAL_TABLES_SKIPPED: readonly string[] = ['app_config'];

type KeyType = PageKeyType;
interface KeySpec {
  keyCol: string; keyType: KeyType; conflict: readonly string[]; maxRows: number;
  /** 经 private.backup_read 读（service role 没有这张表的表级权限；迁移 20261126130000 的 case 里写死了这几张） */
  rpc?: true;
}

/** 同步表每张上限 2 万行（row_quota），多读一点余量 */
const SYNC_MAX_ROWS = 25_000;
/**
 * 每张进备份的表怎么翻页、恢复时按哪几列 upsert（主键，见各建表迁移）。清单里新加 backup: 'json' 的表、这里没写的，
 * backupTablesOf 直接报错（tests/edge/backup-daily.test.ts 拿真清单核对），不会悄悄漏备份。
 * text 主键（invites、vault_credentials）每人只有几条，不翻页、一页读完（库里的排序规则和 JS 比大小可能不一样，翻页会漏行）
 */
export const TABLE_KEYS: ReadonlyMap<string, KeySpec> = new Map<string, KeySpec>([
  ['profiles', { keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1 }],
  ['settings', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['devices', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['api_tokens', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 1000 }],
  ['admins', { keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1 }],
  ['invites', { keyCol: 'code_hash', keyType: 'text', conflict: ['code_hash'], maxRows: 5000 }],
  ['deleted_accounts', { keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1 }],
  // AI 长期记忆（负责人 11-26 选“加进备份”）：每人没删的最多 5000 条，加上删了等撤销的，给一倍余量
  ['ai_memories', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 10_000, rpc: true }],
  ['user_limits', { keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1 }],
  ['events', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['todos', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['todo_items', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['categories', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['notes', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['note_images', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['note_files', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['anniversaries', { keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: SYNC_MAX_ROWS }],
  ['vault', { keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1, rpc: true }],
  ['vault_credentials', { keyCol: 'credential_id', keyType: 'text', conflict: ['credential_id'], maxRows: 1000, rpc: true }],
  ['device_secrets', { keyCol: 'device_id', keyType: 'uuid', conflict: ['device_id'], maxRows: SYNC_MAX_ROWS, rpc: true }],
  // 主键 (kind, source_id)；source_id 是图片或文档的 id，同一个人里不重复，按它翻页
  ['vault_ai', { keyCol: 'source_id', keyType: 'uuid', conflict: ['kind', 'source_id'], maxRows: SYNC_MAX_ROWS * 2, rpc: true }],
]);

/** 进备份的一张表 */
export interface BackupTable extends KeySpec {
  name: string;
  schema: 'public' | 'private';
  /** 按哪一列找这个人的行（清单 userLookup.col） */
  lookupCol: string;
}

interface ManifestLike {
  tables: readonly { name: string; schema: 'public' | 'private'; backup: string; userLookup?: { by: string; col?: string } | undefined; noUserData?: true | undefined }[];
}

/** 按数据清单挑出进备份的表（backup: 'json'），顺序照清单（先 core，外键的父表在子表前面，恢复按这个顺序写） */
export function backupTablesOf(manifests: readonly ManifestLike[]): BackupTable[] {
  const out: BackupTable[] = [];
  for (const m of manifests) {
    for (const t of m.tables) {
      if (t.backup !== 'json') continue;
      if (t.noUserData) {
        if (!GLOBAL_TABLES_SKIPPED.includes(t.name)) throw new Error(`backup_table_no_user_data:${t.name}`);
        continue;
      }
      const lookup = t.userLookup;
      if (lookup?.by !== 'column' || !lookup.col) throw new Error(`backup_table_lookup:${t.name}`);
      const spec = TABLE_KEYS.get(t.name);
      if (!spec) throw new Error(`backup_table_keys:${t.name}`);
      out.push({ name: t.name, schema: t.schema, lookupCol: lookup.col, ...spec });
    }
  }
  return out;
}

// ---------------- 注入的依赖 ----------------
export interface BackupStore {
  /**
   * 读这个人一张表的一页：where <lookupCol> = $userId [and <keyCol> > after] order by <keyCol> limit $limit
   * （rpc 表经 private.backup_read，函数里同样只按 user_id 读）。service role 绕过 RLS，所以这里必须带找人的条件（core 再逐行核对一遍）
   */
  readPage(t: BackupTable, userId: string, after: string | number | null, limit: number): Promise<Record<string, unknown>[]>;
  writeHeartbeat(detail: HeartbeatDetail): Promise<void>;
  /** private.take_rate：true = 放行 */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
}

/** backups 桶里的一个文件 */
export interface ListedFile { name: string; updatedAt: string | null }

/** backups 桶（Supabase Storage） */
export interface BackupFiles {
  /** 目录下的文件（不递归；没有返回空） */
  list(dir: string): Promise<ListedFile[]>;
  /** 读一个文件；不存在回 null */
  read(path: string): Promise<Uint8Array | null>;
  remove(paths: string[]): Promise<void>;
  /** 覆盖写；contentType 必须显式传（桶只收 application/gzip，0.29 续第 33 条） */
  upload(path: string, body: Uint8Array, opts: { contentType: string }): Promise<void>;
  /** 不存在才建（认领标记用）：建成回 true，已经有了回 false，别的错误照抛 */
  create(path: string, body: Uint8Array, opts: { contentType: string }): Promise<boolean>;
}

export interface HeartbeatDetail { rows: number; files: number; segments: number }

export interface Deps {
  cronSecret: string | undefined;
  /** null = 函数没配好；鉴权之后才回 misconfigured */
  store: BackupStore | null;
  files: BackupFiles | null;
  tables: readonly BackupTable[];
  isUsable(userId: string): Promise<boolean>;
  /** 发下一段（带 x-cron-secret 调自己），返回 HTTP 状态码；网络出错抛错 */
  next(body: ContinueBody): Promise<number>;
  /** 响应之后还要做的事（EdgeRuntime.waitUntil）；测试里收集起来 await */
  background(p: Promise<unknown>): void;
  now: () => number;
  newId?: () => string;
  log?: (code: string) => void;
  limits?: Partial<BackupLimits>;
  /** 这份备份出自哪个项目（SUPABASE_URL 的 ref），写进 _manifest；恢复脚本拿它挡住把一个项目的备份写进另一个项目（0.29 续第 95 条②） */
  project?: string;
}

// ---------------- 进度 ----------------
/** 已写的一个文件（t = 表序号） */
export interface WrittenFile { t: number; name: string; bytes: number; sha256: string }

/**
 * 一次备份的进度（段与段之间经请求体传，不落库）：
 * r 这次备份的随机 id；e 轮次（认领标记的编号 = e × RUN_SLOTS + 段号）；d 日期；s 开始时刻（毫秒）；g 这一轮写哪一代；k 已经跑完几段；
 * t 当前表序号；after 这张表上一行的主键；n 这张表已读行数；p 这张表已写的切片数；rows 每张已写完的表的行数（下标 = 表序号）；files 已写的文件
 */
export interface RunState {
  r: string; e: number; d: string; s: number; g: Gen; k: number; t: number; after: string | number | null; n: number; p: number;
  rows: number[]; files: WrittenFile[];
}
/** 轮次上限（编号最多 9 位：RUNNING_RE；一天正常只有几轮） */
const MAX_EPOCH = 999_999;
export interface ContinueBody { user_id: string; state: RunState }

const isCount = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const HEX64 = /^[0-9a-f]{64}$/;
const STATE_KEYS = ['r', 'e', 'd', 's', 'g', 'k', 't', 'after', 'n', 'p', 'rows', 'files'];

/** 主键值按这张表主键的类型收窄（规则在 _shared/table-pager.ts，和账号导出同一份；文本主键用本文件的 TEXT_KEY） */
const keyOk = (t: BackupTable, v: unknown, userId: string): v is string | number => pagerKeyOk(t.keyType, v, userId, TEXT_KEY);

/** 请求体里带来的进度逐项校验；不对返回 undefined（回 bad_request），多一个字段也不收 */
export function decodeState(raw: unknown, tables: readonly BackupTable[], userId: string, nowMs: number, lim: BackupLimits): RunState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !STATE_KEYS.includes(k))) return undefined;
  const { r, e, d, s, g, k, t, after, n, p, rows, files } = o;
  if (typeof r !== 'string' || !UUID_RE.test(r)) return undefined;
  if (!isCount(e, MAX_EPOCH) || e < 1) return undefined;
  if (g !== 'a' && g !== 'b') return undefined;
  if (!isCount(s, Number.MAX_SAFE_INTEGER) || s > nowMs || nowMs - s > lim.runTtlMs) return undefined;
  if (typeof d !== 'string' || !BACKUP_DATE_RE.test(d) || d !== backupDate(s)) return undefined;
  if (!isCount(k, lim.maxSegments) || !isCount(t, tables.length) || !isCount(p, 9999)) return undefined;
  const tbl = tables.at(t);
  if (after !== null && (!tbl || !keyOk(tbl, after, userId))) return undefined;
  if (!isCount(n, tbl?.maxRows ?? 0)) return undefined;
  if (!Array.isArray(rows) || rows.length !== t || !rows.every((x) => isCount(x, Number.MAX_SAFE_INTEGER))) return undefined;
  if (!Array.isArray(files) || files.length > (tables.length + 1) * 100) return undefined;
  const fs: WrittenFile[] = [];
  for (const f of files as unknown[]) {
    if (typeof f !== 'object' || f === null) return undefined;
    const x = f as Record<string, unknown>;
    if (Object.keys(x).some((kk) => !['t', 'name', 'bytes', 'sha256'].includes(kk))) return undefined;
    if (!isCount(x.t, t) || typeof x.name !== 'string' || genOf(x.name) !== g || !isCount(x.bytes, lim.maxFileGzBytes)) return undefined;
    if (typeof x.sha256 !== 'string' || !HEX64.test(x.sha256)) return undefined;
    fs.push({ t: x.t, name: x.name, bytes: x.bytes, sha256: x.sha256 });
  }
  return { r, e, d, s, g, k, t, after: typeof after === 'string' && tbl?.keyType === 'uuid' ? after.toLowerCase() : (after as string | number | null), n, p, rows: rows as number[], files: fs };
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** 解开一个 gzip 的 JSON 文件；坏了回 null */
async function gunzipJson(b: Uint8Array): Promise<Record<string, unknown> | null> {
  try {
    const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const v: unknown = JSON.parse(DEC.decode(await new Response(stream).arrayBuffer()));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 数据导致的失败（行不是这个人的、主键不前进、行数超上限、文件太大）：日志码 backup_<它> */
export class BackupError extends Error {}

/** 不用方括号取列（check_backend F7）：主键列、找人的列都是固定的几个名字 */
function col(row: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(row, name) ? row[name] : undefined;
}

const userDir = (d: string, userId: string) => `${d}/${userId}`;

interface SegmentOut { state: RunState; done: boolean; written: WrittenFile[]; rows: number }

/** 写一个文件：压缩、核对大小、上传（覆盖） */
async function putFile(files: BackupFiles, lim: BackupLimits, userId: string, st: RunState, table: string, slice: number | null, parts: Uint8Array[]): Promise<WrittenFile> {
  const gz = await gzipAll(parts);
  if (gz.byteLength > lim.maxFileGzBytes) throw new BackupError('file_too_large');
  const name = dataFileName(st.g, table, slice);
  await files.upload(`${userDir(st.d, userId)}/${name}`, gz, { contentType: GZIP });
  return { t: st.t, name, bytes: gz.byteLength, sha256: await sha256Hex(gz) };
}

/**
 * 跑一段：从 state 处接着读，每读完一页查一次本段原文预算。到了预算时手上的表还没读完，就把读到的写成一片（<代>_<表>.<p+1>.json.gz）、
 * 进度停在这一行后面；表读完了就写成整张（没切过）或最后一片（切过），换下一张表，预算到了就停在新表开头。
 */
export async function runSegment(deps: Deps, store: BackupStore, files: BackupFiles, userId: string, start: RunState, lim: BackupLimits): Promise<SegmentOut> {
  const st: RunState = { ...start, rows: [...start.rows], files: [...start.files] };
  const written: WrittenFile[] = [];
  let used = 0;
  let readRows = 0;
  for (;;) {
    const tbl = deps.tables.at(st.t);
    if (!tbl) return { state: st, done: true, written, rows: readRows };
    const head = `${JSON.stringify({ format: FILE_FORMAT, version: 1, table: tbl.name }).slice(0, -1)},"rows":[`;
    const parts: Uint8Array[] = [ENC.encode(head)];
    let wrote = false;
    let avg: number | undefined;
    for (;;) {
      const single = tbl.keyType === 'text' || tbl.keyType === 'self';
      const size = single ? tbl.maxRows + 1 : pageSize(avg, lim);
      const page = await store.readPage(tbl, userId, single ? null : st.after, size);
      let pageRaw = 0;
      for (const row of page) {
        if (col(row, tbl.lookupCol) !== userId) throw new BackupError('foreign_row');
        const k = nextKey(tbl.keyType, col(row, tbl.keyCol), single ? null : st.after, userId, TEXT_KEY);
        if (k === undefined) throw new BackupError('bad_page_key');   // 类型不对，或主键不前进（不翻，免得死循环）
        st.n += 1;
        if (st.n > tbl.maxRows) throw new BackupError('too_many_rows');
        const b = ENC.encode((wrote ? ',' : '') + JSON.stringify(row));
        parts.push(b);
        pageRaw += b.byteLength;
        wrote = true;
        if (!single) st.after = k;
      }
      used += pageRaw;
      readRows += page.length;
      if (page.length) avg = Math.round(pageRaw / page.length);
      const tableDone = single || page.length < size;
      if (tableDone) {
        parts.push(ENC.encode(']}'));
        const f = await putFile(files, lim, userId, st, tbl.name, st.p === 0 ? null : st.p + 1, parts);
        written.push(f);
        st.files.push(f);
        st.rows.push(st.n);
        st.t += 1; st.after = null; st.n = 0; st.p = 0;
        break;
      }
      if (used >= lim.segmentRawBytes) {   // 预算到了、表还没读完：读到的写成一片，进度停在这一行后面
        parts.push(ENC.encode(']}'));
        const f = await putFile(files, lim, userId, st, tbl.name, st.p + 1, parts);
        written.push(f);
        st.files.push(f);
        st.p += 1;
        return { state: st, done: false, written, rows: readRows };
      }
    }
    if (used >= lim.segmentRawBytes) return { state: st, done: deps.tables.at(st.t) === undefined, written, rows: readRows };
  }
}

/** 最后写的清单文件：恢复脚本按它拼切片、核对行数和 sha256 */
export function manifestOf(userId: string, st: RunState, tables: readonly BackupTable[], finishedMs: number, project: string | null = null): Record<string, unknown> {
  return {
    format: MANIFEST_FORMAT, version: 1, user_id: userId, date: st.d, run_id: st.r, gen: st.g, project,
    started_at: new Date(st.s).toISOString(), finished_at: new Date(finishedMs).toISOString(),
    tables: tables.map((t, i) => ({
      name: t.name, schema: t.schema, key: [...t.conflict], lookup: t.lookupCol, rows: st.rows.at(i) ?? 0,
      files: st.files.filter((f) => f.t === i).map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
    })),
  };
}

/**
 * 发下一段：失败（网络出错、非 2xx）重试一次；还不行只记日志，02:30 的补跑从头再做。
 * 重试回 2xx 也记一条 next_retry_ok：失败的那次可能已经建好这一段的标记，重试就回 superseded、这一轮静默断掉，留个日志码好查
 */
async function chain(deps: Deps, body: ContinueBody): Promise<void> {
  for (let i = 0; i < 2; i++) {
    try {
      const status = await deps.next(body);
      if (status >= 200 && status < 300) {
        if (i > 0) deps.log?.('next_retry_ok');
        return;
      }
      deps.log?.(`next_status:${status}`);
      if (status === 400 || status === 401) break;   // 进度或密钥不对，重试也一样
    } catch {
      deps.log?.('next_failed');
    }
  }
  deps.log?.('chain_broken');
}

type Mode = 'start' | 'retry' | 'publish' | 'continue';
const START_MODES: readonly unknown[] = ['start', 'retry', 'publish'];

/** 目录里的认领标记（编号、建的时刻；时刻解析不了的记 NaN） */
const marksOf = (listed: readonly ListedFile[]) =>
  listed.flatMap((f) => { const n = runningNo(f.name); return n === null ? [] : [{ n, at: Date.parse(f.updatedAt ?? '') }]; });
/** 目录里最大的轮次；没有标记回 0 */
const topEpoch = (listed: readonly ListedFile[]) => Math.max(0, ...marksOf(listed).map((m) => Math.floor(m.n / RUN_SLOTS)));

/** 有没过期的标记（时刻解析不了的当过期，免得一个坏标记把这个人永远卡住） */
function runningFresh(listed: readonly ListedFile[], now: number, lim: BackupLimits): boolean {
  return marksOf(listed).some((m) => Number.isFinite(m.at) && now - m.at < lim.runningTtlMs);
}

/** 建第 k 段的认领标记（内容只给人看：这一轮的 run_id、轮次、段号）；同一个编号已经有了回 false */
const claim = async (files: BackupFiles, userId: string, st: RunState, k: number) =>
  files.create(`${userDir(st.d, userId)}/${runningFile(st.e, k)}`, await gzipAll([ENC.encode(JSON.stringify({
    format: RUNNING_FORMAT, run_id: st.r, epoch: st.e, k, started_at: new Date(st.s).toISOString() }))]), { contentType: GZIP });

/**
 * 这一轮还是当家的：这一轮开头的标记（段号 0）还在、run_id 是自己的（做完删光后同一个轮次号被下一轮重新用了也认得出来），
 * 而且目录里没有更大的轮次（没被接管）
 */
async function stillOwner(files: BackupFiles, userId: string, st: RunState): Promise<boolean> {
  const dir = userDir(st.d, userId);
  const raw = await files.read(`${dir}/${runningFile(st.e, 0)}`);
  const mark = raw ? await gunzipJson(raw) : null;
  return mark?.['run_id'] === st.r && topEpoch(await files.list(dir)) === st.e;
}

/** 当天已做完那一份是哪一代：读 _manifest 的 gen；没有、读不出来回 null */
async function committedGen(files: BackupFiles, dir: string, listed: readonly ListedFile[]): Promise<Gen | null> {
  if (!listed.some((f) => f.name === MANIFEST_FILE)) return null;
  const raw = await files.read(`${dir}/${MANIFEST_FILE}`);
  const man = raw ? await gunzipJson(raw) : null;
  const g = man?.['gen'];
  return g === 'a' || g === 'b' ? g : null;
}

/**
 * 第一段之前：定这一轮写哪一代，建这一轮开头的标记（轮次 = 目录里最大的轮次 + 1，段号 0）。建不成（两轮同时开始、两边同时接管，
 * 别人先建成了同一个编号）回 null、不开工。建成了才删这一代的残片（上一轮没做完留下的，没有 _manifest 指向它们）：
 * 原来先删再写标记，两轮同时开始时会删掉对方刚写的文件
 */
async function begin(deps: Deps, files: BackupFiles, userId: string, d: string, now: number, listed: readonly ListedFile[]): Promise<RunState | null> {
  const dir = userDir(d, userId);
  const e = topEpoch(listed) + 1;
  if (e > MAX_EPOCH) throw new BackupError('too_many_runs');
  // g 先占位：建标记只用 r、e、d、s，代在建成以后按新列表定
  const st: RunState = { r: (deps.newId ?? (() => crypto.randomUUID()))(), e, d, s: now, g: 'a', k: 0, t: 0, after: null, n: 0, p: 0, rows: [], files: [] };
  if (!(await claim(files, userId, st, 0))) return null;
  // 建成标记以后重新列一次再定代、删残片：列目录到建标记之间，上一轮可能刚做完（写了 _manifest、删光了标记），
  // 按旧列表定代会删掉或覆盖它刚提交的那一代
  const fresh = await files.list(dir);
  st.g = (await committedGen(files, dir, fresh)) === 'a' ? 'b' : 'a';
  const stale = fresh.filter((f) => genOf(f.name) === st.g).map((f) => `${dir}/${f.name}`);
  if (stale.length) await files.remove(stale);
  return st;
}

/**
 * 接力的一段：这一轮还是当家的，再建这一段的标记（段号 = state.k，同时续上有效期）。
 * 被新一轮接管、标记没了、同一段被重发了第二份（这一段的标记第一份已经建了）都回 false
 */
async function stillMine(files: BackupFiles, userId: string, st: RunState): Promise<boolean> {
  return (await stillOwner(files, userId, st)) && (await claim(files, userId, st, st.k));
}

/** 写完 _manifest 以后：删掉旧一代和全部标记。删不掉只记日志（_manifest 已经指向新一代；留下的旧一代下一轮写这一代时 begin 会清，留下的标记过期后不挡下一轮） */
async function cleanup(deps: Deps, files: BackupFiles, userId: string, st: RunState): Promise<void> {
  const dir = userDir(st.d, userId);
  try {
    const old = (await files.list(dir)).filter((f) => runningNo(f.name) !== null || (DATA_FILE_RE.test(f.name) && genOf(f.name) !== st.g));
    if (old.length) await files.remove(old.map((f) => `${dir}/${f.name}`));
  } catch {
    deps.log?.('cleanup_failed');
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
  if (denied) return denied;
  const { store, files } = deps;
  if (!store || !files) {
    deps.log?.('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const lim: BackupLimits = { ...BACKUP_LIMITS, ...deps.limits };

  const text = await req.text();
  if (ENC.encode(text).byteLength > lim.maxBodyBytes) return json(400, { error: 'bad_request' });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json(400, { error: 'bad_request' }); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return json(400, { error: 'bad_request' });
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['user_id', 'mode', 'state'].includes(k))) return json(400, { error: 'bad_request' });
  const userId = typeof b.user_id === 'string' && UUID_RE.test(b.user_id) ? b.user_id : null;
  if (!userId) return json(400, { error: 'bad_request' });
  const now = deps.now();
  let mode: Mode;
  let state: RunState | undefined;
  if (b.state !== undefined) {
    if (b.mode !== undefined) return json(400, { error: 'bad_request' });
    state = decodeState(b.state, deps.tables, userId, now, lim);
    if (!state) return json(400, { error: 'bad_request' });
    mode = 'continue';
  } else if (b.mode === undefined || START_MODES.includes(b.mode)) {
    mode = (b.mode ?? 'start') as Mode;
  } else {
    return json(400, { error: 'bad_request' });
  }

  try {
    // 停用、冷静期账号跳过（每段都查：做到一半被停用的，后面的段不再写）
    if (!(await deps.isUsable(userId))) return json(200, { ok: true, skipped: 'not_usable' });
    if (!state) {
      const d = backupDate(now);
      const listed = await files.list(userDir(d, userId));
      if (runningFresh(listed, now, lim)) return json(200, { ok: true, skipped: 'running', date: d });
      if (mode === 'retry' && listed.some((f) => f.name === MANIFEST_FILE)) return json(200, { ok: true, skipped: 'done', date: d });
      const allowed = mode === 'publish'
        ? await store.takeRate(utcDayKey('backup-daily-publish', userId, now), lim.publishDailyLimit, 86400)
        : await store.takeRate(utcDayKey('backup-daily', userId, now), lim.startDailyLimit, 86400);
      if (!allowed) return json(429, { error: 'rate_limited' });
      const st = await begin(deps, files, userId, d, now, listed);
      if (!st) return json(200, { ok: true, skipped: 'running', date: d });
      state = st;
    } else if (!(await stillMine(files, userId, state))) {
      return json(200, { ok: true, skipped: 'superseded' });
    }
    if (state.k >= lim.maxSegments) {
      deps.log?.('too_many_segments');
      return json(503, { error: 'try_later' });
    }
    const out = await runSegment(deps, store, files, userId, state, lim);
    const next: RunState = { ...out.state, k: state.k + 1 };
    const names = out.written.map((f) => f.name);
    if (!out.done) {
      deps.background(chain(deps, { user_id: userId, state: next }));
      return json(200, { ok: true, date: next.d, done: false, files: names });
    }
    // 写 _manifest 前再核一次这一轮还是当家的：这一段跑的时候被新一轮接管，就不写 _manifest、不删别人的文件
    // （同一段的第二份在开头建标记时就停了，到不了这里）
    if (!(await stillOwner(files, userId, next))) return json(200, { ok: true, skipped: 'superseded' });
    const man = ENC.encode(JSON.stringify(manifestOf(userId, next, deps.tables, deps.now(), deps.project ?? null)));
    await files.upload(`${userDir(next.d, userId)}/${MANIFEST_FILE}`, await gzipAll([man]), { contentType: GZIP });
    await cleanup(deps, files, userId, next);
    const totalRows = next.rows.reduce((a, x) => a + x, 0);
    await store.writeHeartbeat({ rows: totalRows, files: next.files.length, segments: next.k }).catch(() => deps.log?.('heartbeat_failed'));
    return json(200, { ok: true, date: next.d, done: true, files: [...names, MANIFEST_FILE] });
  } catch (e) {
    deps.log?.(e instanceof BackupError ? `backup_${e.message}` : 'store_error');
    return json(503, { error: 'try_later' });
  }
}
