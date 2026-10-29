// account-purge 的处理逻辑（架构第 6 节“account-purge 怎么执行”，0.38 第 24 条 S9、第 43、44、46 条；0.29 续第 131 条⑤、137、138、143 条；
// TC-B1-97 ②、101、102、104 ④、107、108，TC-B0-117）。数据库、Auth、R2、备份桶、发信都由 index.ts 注入，Vitest 直接测这一份。
// 不 import npm 包、不碰 Deno 全局；不用 fn_vault、不直连数据库：数据库里的行全部靠 auth.admin.deleteUser 的外键级联删。
//
// 每天 03:30（首尔）由 pg_cron 经 pg_net 调一次（带 x-cron-secret；迁移 20261029171000，0.38 第 46 条）：
//   第一段  到期前提醒：purge_after 在 48 小时以内、还没到、notice_sent = false 的，先发提醒，发成功再把 notice_sent 比较并交换成 true
//           （K3 安全审查低 11）。发信失败什么都不改，下一次运行（还没到期的话）照样补发。
//           代价：两次运行同时跑（cron 和手动补跑撞上）可能各发一封；反过来“先改再发”在改完、发信前崩掉就永远不发了。
//           提醒信少一封比多一封坏（用户会以为不会删），所以选先发。
//   第二段  逐个执行 purge_after <= now 的账号（一个失败不影响其他，第二天重试）：
//     1. 认领：单条 update 写 purge_started_at（只认没认领的、或认领超过 1 小时的，0.38 第 44 条、TC-B1-108 ③）；
//        认领不到就跳过（restore 抢先了，或别的一次正在做）。
//        认领后再核对：不在 admins 里、profile 还在且是停用状态（冷静期里被管理员停用的照样删，0.38 第 43 条）；
//        不满足就清掉认领、跳过、记日志。邮箱用 getUserById 取出留在内存里。
//     2. R2 四个桶（images、files、vault-images、vault-files）各按 `<user_id>/` 删，删完再列一次，不为 0 就整个账号报错停下。
//        vault-preview 不在这里删（路径不含 user_id，靠 vault-file sweep 到期删）。
//     3. backups 桶（Supabase Storage）下 `*/<user_id>/` 全删，删完再列，为 0 才往下。
//     4. 用邮箱的 HMAC（_shared/email-hash.ts，算法只此一处）删 pending_signups 那一行、counters 的 signup-mail:mail:<它>；
//        SIGNUP_HASH_SECRET 换过的话删不到（10 分钟、1 小时就失效的东西），不影响注销；没配这把钥匙只记日志。
//     5. counters 里第二段是这个 user_id 的键全删。
//     6. 写 deleted_accounts 之前再查一次认领还在（第 138 条③；被删了就不写、不删账号）；写入 on conflict do nothing。
//     7. auth.admin.deleteUser：各表经外键级联删。之后核对 profiles、pending_deletions 里这个人都是 0 行，不是就算失败（告警）。
//     8. 发最后一封信（第 1 步留在内存里的邮箱；失败只记日志、不重试）。
//   最后写心跳 account-purge（purged、failed、sent、deferred、ms）。
// 第 2～7 步出错（包括 R2 删完不为 0、backups 里有子目录）：清掉自己的认领（purge_started_at 置空），下一次运行重新认领；
// purge_after 已过，restore 照样拒。进程崩了来不及清的认领，1 小时后可以重新认领；lemo-ops 的“认领超过 26 小时”告警不变（第 143 条）。
// 时间预算（K3 安全审查低 10）：一次运行最多 PURGE_TIME_BUDGET_MS；用完就不再认领新账号，正在做的账号在写 deleted_accounts 之前
// 发现超时就停下、清掉认领（不可逆的几步之前才停），剩下的下一次运行再做。
// 日志只记错误码和 user_id 前 8 位（A23）：不打印邮箱、请求头、请求体。

import { deletionDoneMail, deletionReminderMail, mailLocale, type Mail } from '../_shared/account-mail.ts';
import { emailHash } from '../_shared/email-hash.ts';
import { safeEqual } from '../_shared/proxy-headers.ts';

// ---------------- 常量（出处见行尾） ----------------
export const R2_BUCKETS = ['images', 'files', 'vault-images', 'vault-files'] as const;   // 0.32、0.38 第 24 条第 2 步
export const BACKUP_BUCKET = 'backups';
export const CLAIM_STALE_MS = 3600_000;         // 认领超过 1 小时可以重领（0.38 第 44 条，以 TC-B1-108 ③ 为准）
/** 一次运行的时间预算：Edge Function 墙钟上限 150 秒（免费档），留出写心跳和回响应的余量 */
export const PURGE_TIME_BUDGET_MS = 110_000;
export const REMIND_WINDOW_MS = 48 * 3600_000;  // 满 7 天前 48 小时以内发提醒（第 137 条①）
export const HEARTBEAT = 'account-purge';
/** 冷静期里被管理员停用（disabled_reason = 'admin'）不取消注销，照样删（0.38 第 43 条；0.29 续第 134 条⑥、TC-B1-104 ④） */
export const PURGE_ADMIN_DISABLED = true;
const MIN_SECRET_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------- 注入的依赖 ----------------
export interface DueRow { user_id: string; purge_after: string }

export interface PurgeStore {
  /** 到期前提醒的候选：notice_sent = false、now < purge_after <= until */
  listRemind(nowIso: string, untilIso: string): Promise<DueRow[]>;
  /** update pending_deletions set notice_sent = to where user_id = $1 and notice_sent = from：改到 1 行返回 true */
  casNotice(userId: string, from: boolean, to: boolean): Promise<boolean>;
  /** purge_after <= now、没认领或认领早于 staleIso 的（只是候选，真正以 claim 为准） */
  listDue(nowIso: string, staleIso: string): Promise<DueRow[]>;
  /**
   * 认领：单条 update pending_deletions set purge_started_at = nowIso where user_id = $1 and purge_after <= nowIso
   *   and (purge_started_at is null or purge_started_at < staleIso) returning purge_started_at。认领到返回 true。
   * restore 先锁了这一行的话，这条 update 等锁；restore 提交后行已不在，认领不到（TC-B1-108 ②）。
   */
  claim(userId: string, nowIso: string, staleIso: string): Promise<boolean>;
  /** 清掉自己的认领：update … set purge_started_at = null where user_id = $1 and purge_started_at = claimedIso */
  release(userId: string, claimedIso: string): Promise<void>;
  /** 认领还在：pending_deletions 这一行还在且 purge_started_at = claimedIso */
  stillClaimed(userId: string, claimedIso: string): Promise<boolean>;
  isAdmin(userId: string): Promise<boolean>;
  /** profiles 的停用状态和发信用的两列；没有 profile 返回 null */
  profile(userId: string): Promise<{ disabled_at: string | null; disabled_reason: string | null; ui_locale: string | null; current_tz: string | null } | null>;
  /** delete from private.pending_signups where email_hash = $1 */
  deletePendingSignup(emailHash: string): Promise<void>;
  /** delete from private.counters where key = $1（一个键的所有窗口） */
  deleteCounterKey(key: string): Promise<void>;
  /** delete from private.counters where split_part(key, ':', 2) = $1 */
  deleteUserCounters(userId: string): Promise<void>;
  /** insert into private.deleted_accounts (user_id) on conflict do nothing */
  insertDeletedAccount(userId: string): Promise<void>;
  /** profiles、pending_deletions 里这个人的行数之和（deleteUser 以后应该是 0） */
  remainingRows(userId: string): Promise<number>;
  writeHeartbeat(detail: Record<string, number>): Promise<void>;
}

/** R2：经 _shared/objstore.ts（shared/objstore.ts 的 deletePrefix：列 → 每次最多 1000 个批量删 → 再列一次，不为 0 抛 not_empty） */
export interface R2 {
  deletePrefix(bucket: string, prefix: string): Promise<{ deleted: number }>;
}

/** Supabase Storage 的 backups 桶（路径 <日期>/<user_id>/<表>.json.gz，第 10 节） */
export interface Backups {
  /** 第一级目录（各个日期） */
  listDates(): Promise<string[]>;
  /**
   * <日期>/<user_id>/ 下的对象路径（完整路径）。这一层只该有文件：遇到子目录抛 BackupsSubdirError
   * （Storage 的 list 不递归，子目录里的东西删不到、再列也看不出来；K3 安全审查低 9）
   */
  listUserFiles(date: string, userId: string): Promise<string[]>;
  remove(paths: readonly string[]): Promise<void>;
}

export interface Deps {
  cronSecret: string | undefined;
  store: PurgeStore | null;
  r2: R2 | null;
  backups: Backups | null;
  /** auth.admin.getUserById 的邮箱：用户不在返回 null；出错抛错 */
  userEmail(userId: string): Promise<string | null>;
  /** auth.admin.deleteUser（硬删）；出错抛错 */
  deleteUser(userId: string): Promise<void>;
  sendMail(to: string, mail: Mail): Promise<boolean>;
  hashSecret: string | undefined;
  now: () => number;
  log?: (code: string) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const short = (uid: string) => uid.slice(0, 8);

class StepError extends Error {}
/** backups 里 <日期>/<user_id>/ 下出现子目录 */
export class BackupsSubdirError extends Error {
  constructor() { super('backups_subdir'); }
}

// ---------------- 第一段：到期前提醒 ----------------
async function remind(deps: Deps & { store: PurgeStore }, now: number, overBudget: () => boolean): Promise<number> {
  const { store, log } = deps;
  let sent = 0;
  const rows = await store.listRemind(new Date(now).toISOString(), new Date(now + REMIND_WINDOW_MS).toISOString());
  for (const r of rows) {
    if (overBudget()) { log?.('remind_time_budget'); break; }   // 没发的下一次运行补（还在 48 小时窗口里的话）
    const pa = Date.parse(r.purge_after);
    if (!UUID.test(r.user_id) || !Number.isFinite(pa) || pa <= now || pa > now + REMIND_WINDOW_MS) continue;
    try {
      // 先发信，发成功再标记（顺序和理由见文件头）
      const [email, prof] = await Promise.all([deps.userEmail(r.user_id), store.profile(r.user_id)]);
      const ok = email !== null
        && await deps.sendMail(email, deletionReminderMail(mailLocale(prof?.ui_locale), pa, prof?.current_tz)).catch(() => false);
      if (!ok) { log?.(`remind_mail_failed:${short(r.user_id)}`); continue; }   // 什么都不改，下一次运行补发
      sent++;
      // 改不到（行已被 restore 删掉，或并发的另一次先标了）不要紧；改的时候出错，下一次运行会再发一封
      if (!(await store.casNotice(r.user_id, false, true))) log?.(`remind_mark_skipped:${short(r.user_id)}`);
    } catch {
      log?.(`remind_failed:${short(r.user_id)}`);
    }
  }
  return sent;
}

// ---------------- 第二段：逐个彻底删除 ----------------
type Outcome = 'purged' | 'skipped' | 'failed' | 'deferred';

async function purgeOne(deps: Deps & { store: PurgeStore; r2: R2; backups: Backups }, userId: string, overBudget: () => boolean): Promise<Outcome> {
  const { store, log } = deps;
  const now = deps.now();
  const claimedIso = new Date(now).toISOString();
  const staleIso = new Date(now - CLAIM_STALE_MS).toISOString();

  // 1. 认领
  if (!(await store.claim(userId, claimedIso, staleIso))) return 'skipped';
  const giveUp = async (code: string): Promise<Outcome> => {
    log?.(`${code}:${short(userId)}`);
    await store.release(userId, claimedIso).catch(() => log?.(`release_failed:${short(userId)}`));
    return code === 'time_budget' ? 'deferred' : code.startsWith('skip_') ? 'skipped' : 'failed';
  };

  let email: string | null;
  try {
    // 1'. 再核对一次：不是管理员；profile 还在、仍是停用状态（restore 过的不会走到这里：restore 会删掉这一行）
    if (await store.isAdmin(userId)) return await giveUp('skip_admin');
    const prof = await store.profile(userId);
    const reasonOk = prof?.disabled_reason === 'deletion' || (PURGE_ADMIN_DISABLED && prof?.disabled_reason === 'admin');
    if (!prof || prof.disabled_at === null || !reasonOk) return await giveUp('skip_not_disabled');
    email = await deps.userEmail(userId);   // deleteUser 以后就取不到了：留在内存里
    if (email === null) log?.(`no_email:${short(userId)}`);
    const loc = mailLocale(prof.ui_locale);

    // 2. R2 四个桶：删完再列一次，不为 0 就抛错（deletePrefix 自己做），整个账号停下
    for (const b of R2_BUCKETS) await deps.r2.deletePrefix(b, `${userId}/`);

    // 3. backups：每个日期下 <user_id>/ 全删，再列一次为 0
    const dates = await deps.backups.listDates();
    for (const d of dates) {
      const files = await deps.backups.listUserFiles(d, userId);
      if (files.length) await deps.backups.remove(files);
    }
    for (const d of dates) {
      if ((await deps.backups.listUserFiles(d, userId)).length) throw new StepError('backups_not_empty');
    }

    // 4. 邮箱哈希的两样（secret 换过就删不到，只是短期数据，不影响注销）
    if (email !== null) {
      if (deps.hashSecret) {
        const h = await emailHash(deps.hashSecret, email);
        await store.deletePendingSignup(h);
        await store.deleteCounterKey(`signup-mail:mail:${h}`);
      } else {
        log?.(`hash_secret_missing:${short(userId)}`);
      }
    }

    // 5. counters 里本人的键
    await store.deleteUserCounters(userId);

    // 时间快用完：不可逆的几步（deleted_accounts、deleteUser）之前停下，清掉认领，下一次运行从头再做（前面几步重做无害）
    if (overBudget()) throw new StepError('time_budget');

    // 6. 写 deleted_accounts 之前再查一次认领还在（TC-B1-108 ④）
    if (!(await store.stillClaimed(userId, claimedIso))) {
      log?.(`skip_claim_gone:${short(userId)}`);
      return 'skipped';
    }
    await store.insertDeletedAccount(userId);

    // 7. deleteUser，各表级联；核对 profiles、pending_deletions 都是 0 行
    await deps.deleteUser(userId);
    if ((await store.remainingRows(userId)) !== 0) {
      log?.(`verify_failed:${short(userId)}`);   // 用户已删，认领行若还在由 lemo-ops 的 26 小时告警发现
      return 'failed';
    }

    // 8. 最后一封信（失败只记日志、不重试）
    if (email !== null) {
      const ok = await deps.sendMail(email, deletionDoneMail(loc)).catch(() => false);
      if (!ok) log?.(`done_mail_failed:${short(userId)}`);
    }
    return 'purged';
  } catch (e) {
    const code = e instanceof StepError || e instanceof BackupsSubdirError ? e.message
      : (e as { code?: unknown })?.code === 'not_empty' ? 'r2_not_empty' : 'step_error';
    return await giveUp(code);
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  // 先鉴权，再判“没配好”：没带对密钥的调用方看不出函数配没配
  const secret = deps.cronSecret ?? '';
  const got = req.headers.get('x-cron-secret') ?? '';
  if (secret === '' || got === '' || !safeEqual(got, secret)) return json(401, { error: 'unauthorized' });
  const { store, r2, backups } = deps;
  if (new TextEncoder().encode(secret).length < MIN_SECRET_BYTES || !store || !r2 || !backups) {
    deps.log?.('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const d = { ...deps, store, r2, backups };
  const t0 = deps.now();
  const overBudget = () => deps.now() - t0 >= PURGE_TIME_BUDGET_MS;

  let sent = 0;
  try {
    sent = await remind(d, t0, overBudget);
  } catch {
    deps.log?.('remind_list_failed');   // 提醒查不到不挡删除
  }

  let due: DueRow[];
  try {
    due = await store.listDue(new Date(t0).toISOString(), new Date(t0 - CLAIM_STALE_MS).toISOString());
  } catch {
    deps.log?.('db_unreachable');
    return json(503, { error: 'try_later' });   // 不写心跳：lemo-ops 26 小时没心跳就告警
  }

  let purged = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  for (const r of due) {
    if (overBudget()) { deferred++; continue; }   // 时间用完：不再认领新账号，下一次运行再做
    if (!UUID.test(r.user_id)) { failed++; deps.log?.('bad_user_id'); continue; }
    let o: Outcome;
    try {
      o = await purgeOne(d, r.user_id, overBudget);
    } catch {
      o = 'failed';
      deps.log?.(`claim_error:${short(r.user_id)}`);
    }
    if (o === 'purged') purged++;
    else if (o === 'failed') failed++;
    else if (o === 'deferred') deferred++;
    else skipped++;
  }

  if (deferred) deps.log?.(`time_budget_deferred:${deferred}`);
  const detail = { purged, failed, sent, deferred, ms: Math.max(0, deps.now() - t0) };
  try {
    await store.writeHeartbeat(detail);
  } catch {
    deps.log?.('heartbeat_failed');
    return json(503, { error: 'try_later', ...detail, skipped });
  }
  return json(200, { ok: true, ...detail, skipped });
}
