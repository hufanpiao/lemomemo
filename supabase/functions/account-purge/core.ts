// account-purge 的处理逻辑（架构第 6 节“account-purge 怎么执行”，0.38 第 24 条 S9、第 43、44、46 条；0.29 续第 131 条⑤、137、138、143 条；
// TC-B1-97 ②、101、102、104 ④、107、108，TC-B0-117）。数据库、Auth、R2、备份桶、发信都由 index.ts 注入，Vitest 直接测这一份。
// 不 import npm 包、不碰 Deno 全局；不用 fn_vault、不直连数据库：数据库里的行全部靠 auth.admin.deleteUser 的外键级联删。
//
// 每天 03:30～05:30（首尔）由 pg_cron 经 pg_net 每 15 分钟调一次（带 x-cron-secret；迁移 20261029171000 是 03:30 那一次，
// PURGE-cpu-budget 的补跑迁移 20261104120000 是 03:45～05:30；0.38 第 46 条）。每一次都先跑第一段、再跑第二段，两段都幂等：
//   第一段  到期前提醒：notice_sent = false、purge_after 在 48 小时以内的（含已经过了的），按 purge_after 从早到晚，最急的先发；
//           发成功再把 notice_sent 比较并交换成 true（K3 安全审查低 11）。发信失败什么都不改，下一次运行照样补发。
//           代价：两次运行同时跑（手动补跑撞上 cron）可能各发一封；反过来“先改再发”在改完、发信前崩掉就永远不发了。
//           提醒信少一封比多一封坏（用户会以为不会删），所以选先发。cron 每 15 分钟一次、一次最长 110 秒，cron 自己不会撞上。
//           **补发并顺延**（负责人 11-04 定，架构 0.29 续第 137 条④）：purge_after 已经过了还没提醒（窗口里那几轮发信都失败、
//           标记失败、或 cron 漏跑）的，补发一封“删除时间已顺延”的提醒，信里写新的时刻 = 现在 + 24 小时，发成功后用一条 CAS
//           同时改 notice_sent = true 和 purge_after = 新时刻（条件：notice_sent 还是 false、purge_after 还是原值、没认领），
//           顺延只发生一次（改完 notice_sent 就是 true，不再进这一段）；顺延以后 purge_after 在将来，restore 照常能用。
//   第二段  逐个执行 purge_after <= t0（本轮开始时刻）的账号（一个失败不影响其他，下一次运行重试）：
//     0. 不在同一轮里先提醒、后删除（负责人 11-04 定，B1 代码审查复审中 A）：按 t0 列到期的（第一段按 t0 判“还没到期”的不会被列进来），
//        并跳过这一轮第一段刚发过提醒（含补发）的，记 purge_held_just_reminded:<前 8 位>，算进 held，下一轮再删。
//        离到期不足 24 小时才收到提醒的不另外顺延（负责人定），最短间隔是一轮（15 分钟）。
//     0'. notice_sent 还是 false 的不删、不认领（**不能没收到到期提醒就被删**，TC-B1-107），记函数日志 purge_held_no_notice:<前 8 位>，
//        算进心跳的 held；正常情况下第一段这一轮已经给它补发并顺延了，走到这里说明补发也没成功，下一次运行再补。
//        例外（负责人 11-04 定“等 3 天后照删并告警”，复审中 B）：Auth 里没有邮箱的（第一段取到 null，本来就收不到信）直接删，
//        记 purge_no_email_no_notice；从 purge_after 起超过 3 天（PURGE_HOLD_MAX_MS）还是发不出去的照删，记 purge_forced_no_notice
//        （两个码都只在真删成时记，没删成记 purge_forced_attempt）。进了照删期，第一段就不再给它补发、不再顺延（第三轮中 C）。
//        局限（第三轮低 J）：发信接口超时、Resend 其实收下了的那次，用户手里有一封写着“现在 + 24 小时”的补发信，
//        而第 3 天照删可能早于信里的时刻（只在接口超时时出现，见执行记录“局限”）。
//        这几个日志码只在函数日志里；心跳里的 held、remaining、forced 三个数字经 usage-report 白名单转发，
//        lemo-ops 据此提示（PURGE-heartbeat-ops，workers/lemo-ops/src/purge-detail.ts），purge:overdue（到期超过 1 天还没执行）照旧兜底。
//     1. 认领：单条 update 写 purge_started_at（只认没认领的、或认领超过 1 小时的，0.38 第 44 条、TC-B1-108 ③）；
//        认领不到就跳过（restore 抢先了，或别的一次正在做）。
//        认领后再核对：不在 admins 里、profile 还在且是停用状态（冷静期里被管理员停用的照样删，0.38 第 43 条）；
//        不满足就清掉认领、跳过、记日志。邮箱用 getUserById 取出留在内存里。
//     2. R2 四个桶（images、files、vault-images、vault-files）各按 `<user_id>/` 删，删完再列一次，不为 0 就整个账号报错停下。
//        vault-preview 不在这里删（路径不含 user_id，靠 vault-file sweep 到期删）。
//     3. backups 桶（Supabase Storage）下 `*/<user_id>/` 全删：逐个日期列、有文件就删、删完再列一次为 0 才算这个日期干净
//        （PURGE-cpu-budget：原来是先全删一遍再全列一遍，改成同一遍里逐日期核对，空日期只列一次，结果一样、调用少一半）。
//     4. 用邮箱的 HMAC（_shared/email-hash.ts，算法只此一处）删 pending_signups 那一行、counters 的 signup-mail:mail:<它>；
//        SIGNUP_HASH_SECRET 换过的话删不到（10 分钟、1 小时就失效的东西），不影响注销；没配这把钥匙只记日志。
//     5. counters 里第二段是这个 user_id 的键全删。
//     6. 写 deleted_accounts 之前再查一次认领还在（第 138 条③；被删了就不写、不删账号）；写入 on conflict do nothing。
//     7. auth.admin.deleteUser：各表经外键级联删。之后核对 profiles、pending_deletions 里这个人都是 0 行，不是就算失败（告警）。
//     8. 发最后一封信（第 1 步留在内存里的邮箱；失败只记日志、不重试）。
//   最后写心跳 account-purge（字段见 handle 末尾）。
// 第 2～7 步出错（包括 R2 删完不为 0、backups 里有子目录）：清掉自己的认领（purge_started_at 置空），下一次运行重新认领；
// purge_after 已过，restore 照样拒。进程崩了来不及清的认领，1 小时后可以重新认领；lemo-ops 的“认领超过 26 小时”告警不变（第 143 条）。
// 预算（K3 安全审查低 10；PURGE-cpu-budget，11-04；B1 代码审查高 1 返工）：每次调用 CPU 硬上限 2 秒（架构 0.47），超了 worker
// 当场被掐、一行代码都不再执行，账号会停在半截、认领要等 1 小时、这一轮也没有心跳。函数里拿不到 CPU 用量，墙钟又随线上延迟变，
// 所以按**调用次数**估（列、删、查各算一次；R2 的 deletePrefix 按“列 + 每千个删一次 + 再列”折算，见 countedDeps）：
//   • 两段各用各的上限（REMIND_WORK_OPS、PURGE_WORK_OPS），互不挤占；另有墙钟上限 PURGE_TIME_BUDGET_MS（110 秒）两段共用兜底。
//   • 第一段超了上限：这一轮不再发，剩下的交给 15 分钟后的补跑（记 remind_budget:<剩几封>，心跳 remind_left）；按 purge_after 排序，最急的先发。
//   • 第二段超了上限：不再认领新账号（deferred）；正在做的账号在下一个检查点停下、清掉认领（干净地放回去，下一次运行马上能认领）。
//     检查点只设在**真删了东西**之后（B1 代码审查中 1、低 3）：R2 某个桶删掉了对象（最后一个桶除外，交给备份段判断）、
//     backups 某个日期删掉了文件（最后一个日期除外）。空桶、空日期只列一次、不停，所以每一轮停下之前至少真删掉一样东西，
//     后面几轮不会在“列空日期”上原地打转。
//     写 deleted_accounts 之前（不可逆的几步之前）只看 110 秒墙钟上限：备份都删完了，剩下几次小查询，领了的账号尽量走完。
//     已经删掉的 R2、备份不会回来，下一次从头再走一遍，删过的那些列出来是空的——同一个账号数据再多也能分几轮删完。
//   上限的依据和本机实测见 docs/03-评审/B1/PURGE-cpu-budget-执行记录.md。
// 日志只记错误码和 user_id 前 8 位（A23）：不打印邮箱、请求头、请求体。

import { deletionDoneMail, deletionReminderLateMail, deletionReminderMail, mailLocale, type Mail } from '../_shared/account-mail.ts';
import { emailHash } from '../_shared/email-hash.ts';
import { safeEqual } from '../_shared/proxy-headers.ts';

// ---------------- 常量（出处见行尾） ----------------
export const R2_BUCKETS = ['images', 'files', 'vault-images', 'vault-files'] as const;   // 0.32、0.38 第 24 条第 2 步
export const BACKUP_BUCKET = 'backups';
export const CLAIM_STALE_MS = 3600_000;         // 认领超过 1 小时可以重领（0.38 第 44 条，以 TC-B1-108 ③ 为准）
/** 一次运行的墙钟上限：Edge Function 墙钟上限 150 秒（免费档），留出写心跳和回响应的余量；两段共用 */
export const PURGE_TIME_BUDGET_MS = 110_000;
/**
 * 第二段（删除）一次运行最多发多少次调用（列、删、查各算一次；PURGE-cpu-budget 返工，B1 代码审查高 1）。
 * 依据（执行记录“上限怎么定的”）：本机 lemo-b2push 一次请求做 3 × 400 个备份日期时，约 3400 次调用碰到 2 秒 CPU 硬上限，
 * 折合每次约 0.6 ms CPU（http、无 TLS）；线上 https 按 3 倍算约 1.8 ms，400 次约 0.7 秒 CPU。检查点只设在真删了东西之后，
 * 一轮实际会多出“这个账号已删空的日期各列一次”（普通账号约 7 个日期，可以忽略；400 个日期的极端情况本机实测一轮最多 424 次）。
 * 一个约 7 个备份日期的普通账号约 46 次，一轮约 8 个，一天 9 次运行约 72～80 个（B1 代码审查复审问题 3）
 */
export const PURGE_WORK_OPS = 400;
/** 第一段（提醒）一次运行最多发多少次调用：一封提醒约 4 次（取邮箱、取 profile、发信、标记），另列一次，200 次约 49 封、一天约 440 封；和第二段分开算 */
export const REMIND_WORK_OPS = 200;
/** 到期了还没提醒的：补发提醒，删除时刻顺延到“现在 + 24 小时”（负责人 11-04 定，架构 0.29 续第 137 条④） */
export const REMIND_LATE_POSTPONE_MS = 24 * 3600_000;
/**
 * 到期后还没提醒成功的最多扣多久（负责人 11-04 定“等 3 天后照删并告警”，B1 代码审查复审中 B）：从 purge_after 起超过 3 天
 * 补发还是发不出去（没配发信钥匙、Resend 一直拒收、@lemomemo.test 测试邮箱），第二段照删，记 purge_forced_no_notice（告警）
 */
export const PURGE_HOLD_MAX_MS = 3 * 24 * 3600_000;
export const REMIND_WINDOW_MS = 48 * 3600_000;  // 满 7 天前 48 小时以内发提醒（第 137 条①）
export const HEARTBEAT = 'account-purge';
/** 冷静期里被管理员停用（disabled_reason = 'admin'）不取消注销，照样删（0.38 第 43 条；0.29 续第 134 条⑥、TC-B1-104 ④） */
export const PURGE_ADMIN_DISABLED = true;
const MIN_SECRET_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------- 注入的依赖 ----------------
export interface DueRow { user_id: string; purge_after: string; notice_sent?: boolean }

export interface PurgeStore {
  /**
   * 提醒的候选：notice_sent = false、since < purge_after <= until（含已经过了的，补发并顺延；since = now - 3 天，照删期的不列，
   * PURGE-r4-low 低 L）、没认领，按 purge_after 从早到晚
   */
  listRemind(untilIso: string, sinceIso: string): Promise<DueRow[]>;
  /** update pending_deletions set notice_sent = to where user_id = $1 and notice_sent = from：改到 1 行返回 true */
  casNotice(userId: string, from: boolean, to: boolean): Promise<boolean>;
  /**
   * 补发后顺延（只一次）：update pending_deletions set notice_sent = true, purge_after = newIso
   *   where user_id = $1 and notice_sent = false and purge_after = oldIso and purge_started_at is null：改到 1 行返回 true
   */
  postponeNotice(userId: string, oldIso: string, newIso: string): Promise<boolean>;
  /** purge_after <= now、没认领或认领早于 staleIso 的（只是候选，真正以 claim 为准），带 notice_sent */
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

// ---------------- 调用计数（预算按调用次数，见文件头） ----------------
export interface Ops { n: number }
const PAGE = 1000;   // index.ts 列、删每次最多 1000 个
type FullDeps = Deps & { store: PurgeStore; r2: R2; backups: Backups };

/** 同一套依赖，每次调用给 ops 记数；两段各用一份，互不挤占 */
function countedDeps(d: FullDeps, ops: Ops): FullDeps {
  // 每个方法一次（逐个列出：PurgeStore 加了方法，这里不写 TypeScript 就报缺字段）
  const c = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A): Promise<R> => { ops.n++; return f(...a); };
  const s = d.store;
  const store: PurgeStore = {
    listRemind: c(s.listRemind.bind(s)),
    casNotice: c(s.casNotice.bind(s)),
    postponeNotice: c(s.postponeNotice.bind(s)),
    listDue: c(s.listDue.bind(s)),
    claim: c(s.claim.bind(s)),
    release: c(s.release.bind(s)),
    stillClaimed: c(s.stillClaimed.bind(s)),
    isAdmin: c(s.isAdmin.bind(s)),
    profile: c(s.profile.bind(s)),
    deletePendingSignup: c(s.deletePendingSignup.bind(s)),
    deleteCounterKey: c(s.deleteCounterKey.bind(s)),
    deleteUserCounters: c(s.deleteUserCounters.bind(s)),
    insertDeletedAccount: c(s.insertDeletedAccount.bind(s)),
    remainingRows: c(s.remainingRows.bind(s)),
    writeHeartbeat: c(s.writeHeartbeat.bind(s)),
  };
  const pages = (n: number) => 1 + Math.floor(n / PAGE);
  return {
    ...d,
    store,
    r2: {
      // 列 → 每千个删一次 → 再列（shared/objstore.ts 的 deletePrefix）；列本身每千个一页
      async deletePrefix(b, p) { const r = await d.r2.deletePrefix(b, p); ops.n += 2 * pages(r.deleted) + Math.ceil(r.deleted / PAGE); return r; },
    },
    backups: {
      async listDates() { const r = await d.backups.listDates(); ops.n += pages(r.length); return r; },
      async listUserFiles(date, uid) { ops.n++; const r = await d.backups.listUserFiles(date, uid); ops.n += pages(r.length) - 1; return r; },
      async remove(paths) { ops.n += Math.max(1, Math.ceil(paths.length / PAGE)); return d.backups.remove(paths); },
    },
    userEmail: (u) => { ops.n++; return d.userEmail(u); },
    deleteUser: (u) => { ops.n++; return d.deleteUser(u); },
    sendMail: (to, m) => { ops.n++; return d.sendMail(to, m); },
  };
}

// ---------------- 第一段：到期前提醒（含到期了还没提醒的补发并顺延） ----------------
interface RemindResult {
  sent: number; postponed: number; left: number;
  /** 这一轮发出了提醒（含补发）的：第二段这一轮不删它们（复审中 A：不在同一轮里先提醒、后删除） */
  reminded: Set<string>;
  /** 这一轮取邮箱是 null 的（Auth 里没有邮箱，本来就收不到信）：到期了第二段直接删（复审中 B） */
  noEmail: Set<string>;
}

async function remind(deps: FullDeps, now: number, overBudget: () => boolean): Promise<RemindResult> {
  const { store, log } = deps;
  const out: RemindResult = { sent: 0, postponed: 0, left: 0, reminded: new Set(), noEmail: new Set() };
  const rows = [...await store.listRemind(new Date(now + REMIND_WINDOW_MS).toISOString(), new Date(now - PURGE_HOLD_MAX_MS).toISOString())]
    .sort((x, y) => Date.parse(x.purge_after) - Date.parse(y.purge_after));   // 最急的先发（index.ts 也按 purge_after 排）
  for (const [i, r] of rows.entries()) {
    if (overBudget()) {   // 这一轮不再发，剩下的交给 15 分钟后的补跑（notice_sent 还是 false，下一次还在候选里）
      out.left = rows.length - i;
      log?.(`remind_budget:${out.left}`);
      break;
    }
    const pa = Date.parse(r.purge_after);
    if (!UUID.test(r.user_id) || !Number.isFinite(pa) || pa > now + REMIND_WINDOW_MS) continue;
    // 已经进入照删期（从 purge_after 起超过 3 天，第二段照删）的不再补发、不再顺延（B1 代码审查第三轮中 C；listRemind 已按下限不列，这里兜底）：
    // 否则照删删了一半、信又发得出去时会被顺延回冷静期（数据已缺一块却能 restore），认领卡住时还会每轮发一封补发信
    if (pa <= now - PURGE_HOLD_MAX_MS) continue;
    const late = pa <= now;   // 到期了还没提醒：补发，删除时刻顺延到 now + 24 小时
    const due = late ? now + REMIND_LATE_POSTPONE_MS : pa;
    try {
      // 先发信，发成功再标记（顺序和理由见文件头）
      const [email, prof] = await Promise.all([deps.userEmail(r.user_id), store.profile(r.user_id)]);
      const loc = mailLocale(prof?.ui_locale);
      const mail = late ? deletionReminderLateMail(loc, due, prof?.current_tz) : deletionReminderMail(loc, due, prof?.current_tz);
      if (email === null) { out.noEmail.add(r.user_id); log?.(`remind_no_email:${short(r.user_id)}`); continue; }
      const ok = await deps.sendMail(email, mail).catch(() => false);
      if (!ok) { log?.(`remind_mail_failed:${short(r.user_id)}`); continue; }   // 什么都不改（也不顺延），下一次运行补发
      out.sent++; out.reminded.add(r.user_id);
      if (late) {
        // 改不到（restore 删了这一行、并发的另一次先顺延了、被认领了）就不顺延，记一条；
        // 这时信里写的时刻晚于实际情况也不会让账号提前被删：没顺延的仍是 notice_sent = false，第二段不删
        if (await store.postponeNotice(r.user_id, r.purge_after, new Date(due).toISOString())) {
          out.postponed++;
          log?.(`purge_postponed:${short(r.user_id)}`);
        } else {
          log?.(`remind_postpone_skipped:${short(r.user_id)}`);
        }
      } else if (!(await store.casNotice(r.user_id, false, true))) {
        // 改不到（行已被 restore 删掉，或并发的另一次先标了）不要紧；改的时候出错，下一次运行会再发一封
        log?.(`remind_mark_skipped:${short(r.user_id)}`);
      }
    } catch {
      log?.(`remind_failed:${short(r.user_id)}`);
    }
  }
  return out;
}

// ---------------- 第二段：逐个彻底删除 ----------------
type Outcome = 'purged' | 'skipped' | 'failed' | 'deferred';

async function purgeOne(
  deps: FullDeps, userId: string, overBudget: () => boolean, overWall: () => boolean,
): Promise<Outcome> {
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
    //    真删了对象的桶是一个检查点（最后一个桶除外，交给备份段）：预算用完就停下、放回认领（已删的不会回来，下一次运行再列是空的）
    for (const [i, b] of R2_BUCKETS.entries()) {
      const { deleted } = await deps.r2.deletePrefix(b, `${userId}/`);
      if (deleted > 0 && i < R2_BUCKETS.length - 1 && overBudget()) throw new StepError('time_budget');
    }

    // 3. backups：逐个日期，<user_id>/ 下有文件就删、删完再列一次为 0；真删了文件的日期是一个检查点（空日期只列一次、不停）
    const dates = await deps.backups.listDates();
    for (const [i, d] of dates.entries()) {
      const files = await deps.backups.listUserFiles(d, userId);
      if (files.length) {
        await deps.backups.remove(files);
        if ((await deps.backups.listUserFiles(d, userId)).length) throw new StepError('backups_not_empty');
      }
      // 只在真删了文件之后判断（B1 代码审查中 1）：每一轮停下之前至少真删掉一个日期，后面几轮不会在空日期上原地打转。
      // 最后一个日期做完就不停了：剩下第 4～8 步只是几次小查询，走完它（不为省这点预算把整个账号拖到下一次）
      if (files.length && i < dates.length - 1 && overBudget()) throw new StepError('time_budget');
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

    // 墙钟快用完（110 秒）：不可逆的几步（deleted_accounts、deleteUser）之前停下，清掉认领，下一次运行从头再做（前面几步重做无害）。
    // 这里只看墙钟上限、不看工作预算：备份都删完了，剩下几次小查询不会顶到 CPU 上限，已经领了的账号尽量走完
    if (overWall()) throw new StepError('time_budget');

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
  const d: FullDeps = { ...deps, store, r2, backups };
  const t0 = deps.now();
  const overWall = () => deps.now() - t0 >= PURGE_TIME_BUDGET_MS;
  // 两段各一份调用计数、各一个上限（B1 代码审查高 1：提醒不再挤占删除，删除也不再挤占提醒）
  const remindOps: Ops = { n: 0 };
  const purgeOps: Ops = { n: 0 };
  const rd = countedDeps(d, remindOps);
  const pd = countedDeps(d, purgeOps);

  let rr: RemindResult = { sent: 0, postponed: 0, left: 0, reminded: new Set(), noEmail: new Set() };
  try {
    rr = await remind(rd, t0, () => overWall() || remindOps.n >= REMIND_WORK_OPS);
  } catch {
    deps.log?.('remind_list_failed');   // 提醒查不到不挡删除（没提醒过的第二段不会删，见第 0 步）
  }

  let due: DueRow[];
  try {
    // 按本轮开始时刻 t0 列（复审中 A）：第一段按 t0 判“还没到期”、发了普通提醒的，第二段不会因为跑到了 purge_after 之后就当场删
    due = await pd.store.listDue(new Date(t0).toISOString(), new Date(deps.now() - CLAIM_STALE_MS).toISOString());
  } catch {
    deps.log?.('db_unreachable');
    return json(503, { error: 'try_later' });   // 不写心跳：lemo-ops 26 小时没心跳就告警
  }

  const overBudget = () => overWall() || purgeOps.n >= PURGE_WORK_OPS;
  let purged = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  let held = 0;
  let forced = 0;
  for (const r of due) {
    // 0. 不在同一轮里先提醒、后删除（复审中 A）：这一轮刚发过提醒（含补发）的，留给下一轮
    if (rr.reminded.has(r.user_id)) {
      held++;
      deps.log?.(`purge_held_just_reminded:${short(r.user_id)}`);
      continue;
    }
    // 0'. 没收到到期提醒的不删（第一段这一轮补发也没成功），下一次运行再补；例外（复审中 B，负责人定）：
    //     Auth 里没有邮箱的（本来就收不到信）直接删；从 purge_after 起超过 3 天还是发不出去的照删。两种都记告警日志
    let force = '';
    if (r.notice_sent !== true) {
      if (rr.noEmail.has(r.user_id)) force = 'purge_no_email_no_notice';
      else if (Date.parse(r.purge_after) <= t0 - PURGE_HOLD_MAX_MS) force = 'purge_forced_no_notice';
      else {
        held++;
        deps.log?.(`purge_held_no_notice:${short(r.user_id)}`);
        continue;
      }
    }
    if (overBudget()) { deferred++; continue; }   // 预算用完：不再认领新账号，下一次运行（15 分钟后的补跑）再做
    if (!UUID.test(r.user_id)) { failed++; deps.log?.('bad_user_id'); continue; }
    let o: Outcome;
    try {
      o = await purgeOne(pd, r.user_id, overBudget, overWall);
    } catch {
      o = 'failed';
      deps.log?.(`claim_error:${short(r.user_id)}`);
    }
    // 告警码只在真删成时记（第三轮低 I）；判了照删、这一轮没删成的另记 purge_forced_attempt，不进按码计数的告警
    if (force) deps.log?.(`${o === 'purged' ? force : 'purge_forced_attempt'}:${short(r.user_id)}`);
    if (o === 'purged') { purged++; if (force) forced++; }
    else if (o === 'failed') failed++;
    else if (o === 'deferred') deferred++;
    else skipped++;
  }

  if (deferred) deps.log?.(`time_budget_deferred:${deferred}`);
  // 心跳 detail（只放数字）：
  //   purged / failed / deferred / held：第二段这一轮的结果（deferred = 预算停手没做完或没认领的，
  //     held = 没收到提醒、或这一轮刚提醒过，这一轮不删的）；forced：purged 里没收到提醒就删的（没有邮箱、或扣满 3 天）；
  //   remaining = deferred + failed + held：这一轮列出的到期账号里**没做成、下一次运行还会再看**的个数。
  //     它不等于“还有多少账号等着删”：还没到期的不在里面；skipped（管理员、没停用、别人正在做）不算；
  //     failed 里也可能有永远不会好的（bad_user_id），会一直算进去。
  //   sent / postponed / remind_left：第一段发出的提醒、其中补发并顺延的、超了上限留给下一次的；
  //   ops / remind_ops：两段各发了多少次调用（核对上限用）；ms：这一轮的墙钟。
  const detail = {
    purged, failed, deferred, held, forced, remaining: deferred + failed + held,
    sent: rr.sent, postponed: rr.postponed, remind_left: rr.left,
    ops: purgeOps.n, remind_ops: remindOps.n, ms: Math.max(0, deps.now() - t0),
  };
  try {
    await store.writeHeartbeat(detail);
  } catch {
    deps.log?.('heartbeat_failed');
    return json(503, { error: 'try_later', ...detail, skipped });
  }
  return json(200, { ok: true, ...detail, skipped });
}
