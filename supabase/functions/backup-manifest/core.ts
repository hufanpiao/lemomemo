// backup-manifest 的处理逻辑（架构第 6 节 backup-manifest 行、第 10 节“拉回本机”第 1 步；ADR-016 第 2 条；TC-B7a-24）。
// 给负责人本机的 tools/backup/pull.ps1 用：最近 7 天的服务器备份清单（每个文件一条 5 分钟有效的签名链接）、deleted_accounts、拉完写心跳。
// 鉴权：Authorization: Bearer <BACKUP_PULL_TOKEN>，定长比较（_shared/http.ts 的 bearerGate）；网关不验 JWT（config.toml verify_jwt = false，
//   check_backend F9 的 BEARER_SECRET_FUNCTIONS 名单）。先鉴权、再限流，没带对密钥的调用方不消耗次数、看不出配没配。
//
// 按日期、按人分页（B7a 复审第 5 条：原来一次回 7 天全部文件，MAX_FILES 5000 ÷ 每人每天约 23 个文件 ÷ 7 天，约 32 个账号就 503）。请求体（JSON 对象）：
//   • {}                      目录：today（服务器算的首尔日期，pull.ps1 不用本机时钟，复审第 7 条）、dates（最近 7 个日期目录）、deleted_accounts、limits；
//   • {date, after?}          这一天的一页：user_id 大于 after 的人按顺序最多 PAGE_USERS 个，文件到 PAGE_FILES 个就停；每个文件一条签名链接；
//                             next 是这一页最后一个人（还有下一页），没有了为 null；
//   • {date, after?, wait: true}  发布前等待用的一页：只回 complete、manifest_at，不签名、不带文件（复审第 6 条：单独计数）；
//   • {done: true}            pull.ps1 拉完、没有失败时调：写心跳 backup-pull（复审第 8 条；lemo-ops 超过 26 小时没写就告警），
//                             detail 是服务器自己数的个数（每天最多几个账号、拉一遍要几次调用、等待每轮几次），接近上限时 lemo-ops 提示。
// 限流（全站，按 UTC 小时）：目录、页、done 合用 backup-manifest-pull:global:<小时>（PULL_HOURLY），等待的页用 backup-manifest-wait:global:<小时>（WAIT_HOURLY）；
//   第二段必须是 global（counters_key_check 只认 uuid、global、ip、mail），用 rate-key 的 utcHourKey 拼。
// 按 1000 个账号算（每人每天约 23 个文件）：拉一遍 = 目录 1 + 7 天 × 20 页 + done 1 = 142 次，PULL_HOURLY 300 够一小时跑两遍；
//   一页最多 50 人约 1150 个文件、12 批签名、51 次列目录；发布前等待每轮 20 页，pull.ps1 按 WAIT_HOURLY 把间隔拉到 150 秒，一小时 480 次 < 600。
//   拉一遍的次数超过 PULL_HOURLY 的 70%（约 1480 个账号）时 lemo-ops 提示（workers/lemo-ops/src/backup-pull.ts）。
// 不按用户鉴权（fn-account-disabled-coverage 的 no-user），不读任何表的行内容，只列 backups 桶、读 private.deleted_accounts、写 private.heartbeat。
// 日志只记错误码（A23）：不打印请求头、签名链接、user_id。响应 no-store。
// 不 import npm 包、不碰 Deno 全局，Vitest 直接测。

import { BACKUP_DATE_RE, BACKUP_FILE_RE, BACKUP_KEEP_DAYS, MANIFEST_FILE, UUID_RE, backupDate, runningNo } from '../_shared/backup-format.ts';
import { readJsonObjectCapped } from '../_shared/body.ts';
import { bearerGate, json } from '../_shared/http.ts';
import { utcHourKey } from '../_shared/rate-key.ts';
import type { StorageItem } from '../_shared/storage-list.ts';

export { BACKUP_BUCKET, MANIFEST_FILE } from '../_shared/backup-format.ts';
export const HEARTBEAT = 'backup-pull';
/** 签名链接有效期（秒）：5 分钟（第七轮）；pull.ps1 拿到一页就下这一页，不会一次签完 7 天 */
export const SIGNED_URL_TTL_S = 300;
/** 最近几天：服务器备份保留几天就列几天（更早的由 storage-sweep 每天删） */
export const RECENT_DAYS = BACKUP_KEEP_DAYS;
/** 一页最多几个人、文件到多少个就停（一页最多 PAGE_FILES + 一个人的文件） */
export const PAGE_USERS = 50;
export const PAGE_FILES = 1500;
/** 一个人一天的目录里文件超过这么多算异常（每人约 23 个，切片最多 maxSegments 80 段），503 */
export const MAX_USER_FILES = 2000;
/** 每小时几次（全站）：拉取（目录、页、done）和发布前等待分开计 */
export const PULL_HOURLY = 300;
export const WAIT_HOURLY = 600;
const MAX_BODY = 4096;

export type Listed = StorageItem;

export interface ManifestStore {
  /** 目录下一层（不递归） */
  list(dir: string): Promise<Listed[]>;
  /** 批量签名（有效期秒）；返回和 paths 同序的链接，签不出来的抛错 */
  sign(paths: string[], expiresInS: number): Promise<string[]>;
  deletedAccounts(): Promise<{ user_id: string; deleted_at: string | null }[]>;
  /** private.take_rate：true = 放行 */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  writeHeartbeat(detail: HeartbeatDetail): Promise<void>;
}

export interface Deps {
  pullToken: string | undefined;
  /** null = 函数没配好；鉴权之后才回 misconfigured */
  store: ManifestStore | null;
  now: () => number;
  log?: (code: string) => void;
}

export interface FileOut { name: string; bytes: number | null; url: string }
export interface UserOut { user_id: string; complete: boolean; manifest_at: string | null; files?: FileOut[] }
/** 心跳 detail（只是个数；usage-report 的 DETAIL_FIELDS_BY_NAME['backup-pull'] 白名单） */
export interface HeartbeatDetail {
  /** 最近 7 天里人数最多的那一天有几个账号目录 */
  accounts: number;
  /** 照现在的人数拉一遍要几次调用（目录 + 各天页数 + done）和每小时上限 */
  pull_calls: number;
  pull_limit: number;
  /** 发布前等待每轮几次（当天的页数）和每小时上限 */
  wait_pages: number;
  wait_limit: number;
}

type Req = { kind: 'index' } | { kind: 'page'; date: string; after: string | null; wait: boolean } | { kind: 'done' };

class TooMuch extends Error {}

function parse(b: Record<string, unknown>): Req | null {
  const keys = Object.keys(b);
  if (keys.length === 0) return { kind: 'index' };
  if (keys.length === 1 && b['done'] === true) return { kind: 'done' };
  const { date, after = null, wait = false } = b;
  if (keys.some((k) => !['date', 'after', 'wait'].includes(k))) return null;
  if (typeof date !== 'string' || !BACKUP_DATE_RE.test(date)) return null;
  if (after !== null && (typeof after !== 'string' || !UUID_RE.test(after))) return null;
  if (typeof wait !== 'boolean') return null;
  return { kind: 'page', date, after, wait };
}

const rateKey = (use: 'pull' | 'wait', ms: number) => utcHourKey(`backup-manifest-${use}`, 'global', ms);
const pages = (n: number) => Math.ceil(n / PAGE_USERS);

/** 日期目录只认 YYYY-MM-DD（backup-daily 只用这一种写法），取最新的 7 个 */
async function recentDates(store: ManifestStore): Promise<string[]> {
  return (await store.list('')).filter((o) => o.folder && BACKUP_DATE_RE.test(o.name)).map((o) => o.name).sort().slice(-RECENT_DAYS);
}

async function userIds(store: ManifestStore, date: string): Promise<string[]> {
  return (await store.list(date)).filter((o) => o.folder && UUID_RE.test(o.name)).map((o) => o.name).sort();
}

async function page(store: ManifestStore, r: { date: string; after: string | null; wait: boolean }, now: number) {
  const all = (await recentDates(store)).includes(r.date) ? await userIds(store, r.date) : [];
  const rest = r.after === null ? all : all.filter((u) => u > (r.after as string));
  const users: UserOut[] = [];
  const paths: string[] = [];
  const slots: FileOut[] = [];
  for (const u of rest) {
    if (users.length >= PAGE_USERS || paths.length >= PAGE_FILES) break;
    // 正在做的标记不给链接（pull.ps1 用不着）；数据文件新旧两代可能同时在，pull.ps1 只下 _manifest 里列的
    const items = (await store.list(`${r.date}/${u}`)).filter((o) => !o.folder && BACKUP_FILE_RE.test(o.name) && runningNo(o.name) === null);
    if (items.length > MAX_USER_FILES) throw new TooMuch();
    const man = items.find((o) => o.name === MANIFEST_FILE);
    const out: UserOut = { user_id: u, complete: man !== undefined, manifest_at: man?.updatedAt ?? null };
    if (!r.wait) {
      out.files = items.map((it) => ({ name: it.name, bytes: it.bytes, url: '' }));
      slots.push(...out.files);
      paths.push(...items.map((it) => `${r.date}/${u}/${it.name}`));
    }
    users.push(out);
  }
  const more = users.length < rest.length;
  if (paths.length) {
    const urls = await store.sign(paths, SIGNED_URL_TTL_S);
    if (urls.length !== slots.length) throw new Error('sign_count');
    slots.forEach((f, i) => { f.url = urls.at(i) ?? ''; });
  }
  return {
    ok: true, generated_at: new Date(now).toISOString(), expires_in: SIGNED_URL_TTL_S, date: r.date, users,
    next: more ? (users.at(-1)?.user_id ?? null) : null,
  };
}

/** 照现在的人数算心跳 detail（列根目录和 7 个日期目录，8 次列目录） */
async function usage(store: ManifestStore, now: number): Promise<HeartbeatDetail> {
  const counts = new Map<string, number>();
  for (const d of await recentDates(store)) counts.set(d, (await userIds(store, d)).length);
  const per = [...counts.values()];
  return {
    accounts: per.length ? Math.max(...per) : 0,
    pull_calls: 2 + per.reduce((s, n) => s + Math.max(1, pages(n)), 0),
    pull_limit: PULL_HOURLY,
    wait_pages: Math.max(1, pages(counts.get(backupDate(now)) ?? 0)),
    wait_limit: WAIT_HOURLY,
  };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const denied = bearerGate(req.headers.get('authorization'), deps.pullToken, deps.log);
  if (denied) return denied;
  const { store } = deps;
  if (!store) {
    deps.log?.('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const body = await readJsonObjectCapped(req, MAX_BODY);
  const r = body === null || body === 'too_large' ? null : parse(body);
  if (!r) return json(400, { error: 'bad_request' });
  const now = deps.now();
  try {
    const wait = r.kind === 'page' && r.wait;
    if (!(await store.takeRate(rateKey(wait ? 'wait' : 'pull', now), wait ? WAIT_HOURLY : PULL_HOURLY, 3600))) return json(429, { error: 'rate_limited' });
    if (r.kind === 'page') return json(200, await page(store, r, now));
    if (r.kind === 'done') {
      await store.writeHeartbeat(await usage(store, now));
      return json(200, { ok: true });
    }
    const dates = await recentDates(store);
    const deleted = (await store.deletedAccounts()).filter((x) => UUID_RE.test(x.user_id));
    return json(200, {
      ok: true, generated_at: new Date(now).toISOString(), today: backupDate(now), dates,
      deleted_accounts: deleted.map((x) => ({ user_id: x.user_id, deleted_at: x.deleted_at })),
      limits: { page_users: PAGE_USERS, pull_hourly: PULL_HOURLY, wait_hourly: WAIT_HOURLY },
    });
  } catch (e) {
    deps.log?.(e instanceof TooMuch ? 'too_many_objects' : 'store_error');
    return json(503, { error: 'try_later' });
  }
}
