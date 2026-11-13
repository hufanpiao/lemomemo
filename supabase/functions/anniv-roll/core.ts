// anniv-roll 的处理逻辑（B5 S13；架构 5.4“倒数日到期后”、第 6 节 anniv-roll 行、0.29（P-08））：cron 函数，只收 POST，先鉴权（x-cron-secret 定长比较）再判配置。
// pg_cron 每天 00:10 UTC 调一次（迁移 20261113181000_anniv_roll_cron.sql）。数据库、共享 logic 由 index.ts 注入，Vitest 直接测这一份。
// 一轮做什么：
// • 挑行：没删的纪念日里 next_date 为空、或 next_date 早于“全世界最晚的明天”（UTC 今天 + 2 天）且还没归档的；外加已归档、但 next_date 又回到今天以后的
//   （用户把已过去的倒数日改到以后，push-dispatch 重算了 next_date，这里把 archived_at 清掉）。一轮最多 BATCH 行，按 next_date 从早到晚。
// • 只处理可用账号（_shared/auth.ts 的 isUsable，经 private.account_usable；停用、注销冷静期的跳过，0.29 续第 138 条④）。
// • 每行按这个人的 current_tz、设置（anniv.default_offsets、anniv.default_time）用 shared/logic/anniv/next-date.ts 的 annivNextOf 重算
//   next_date、remind_at（每年的滚到下一次；倒数日到期第二天起算“已过去”）；倒数日 archive 的过了目标日写 archived_at = 现在，回到以后的清空。
//   值没变不写；写的时候带乐观条件（rev、remind_at 还是读到的值，同 push-dispatch），读完以后被改了的不覆盖（触发器已入队，push-dispatch 会重算）。
//   还有没到的“稍后”、免打扰顺延（snooze_at 或 defer_until 晚于现在）的行，remind_at 不动，只滚 next_date、archived_at（整块评审第 7 条）。
// • 判可用账号按人并发（最多 USABLE_CONCURRENCY 个，整块评审第 10 条）。
// • 日志带表名和 id 前 8 位（整块评审第 11 条），不记名字、日期。
// • 写心跳 anniv-roll（detail 只是个数，usage-report 按白名单转发）。日志只记原因码（A23），不记名字、日期。
import { cronGate, json } from '../_shared/http.ts';
import { pool } from '../_shared/pool.ts';

export const HEARTBEAT = 'anniv-roll';
/** 一轮最多处理几行（PostgREST 一次读回；每天一次，量大时下一天接着滚，到期的行 next_date 早，排在前面） */
export const BATCH = 1000;
/** 判可用账号最多几个并发（private.account_usable 每人一次 RPC） */
export const USABLE_CONCURRENCY = 8;

/** 读出来的一行（只取用得到的列） */
export interface RollRow {
  id: string;
  user_id: string;
  rev: number;
  kind: unknown;
  after_due: unknown;
  next_date: string | null;
  remind_at: number | null;
  archived_at: number | null;
  [k: string]: unknown;
}

export interface RollPatch {
  next_date: string | null;
  remind_at: number | null;
  archived_at: number | null;
}

export interface RollStore {
  /** 见文件头“挑行”：lo、hi 是 UTC 日期（'YYYY-MM-DD'） */
  candidates(lo: string, hi: string, limit: number): Promise<RollRow[]>;
  /** user_id → current_tz */
  profiles(userIds: readonly string[]): Promise<Map<string, string>>;
  /** user_id → { anniv.default_offsets, anniv.default_time }（没软删、没撤销的） */
  settings(userIds: readonly string[]): Promise<Map<string, Record<string, unknown>>>;
  /** 带乐观条件写回（remind_at 还是 prevRemindAt）；回是否写到 1 行 */
  write(row: RollRow, patch: RollPatch): Promise<boolean>;
  writeHeartbeat(detail: HeartbeatDetail): Promise<void>;
}

/** 共享 logic（index.ts 从 _shared/gen 传，测试从 shared 传） */
export interface RollLogic {
  annivNextOf(row: Readonly<Record<string, unknown>>, ctx: { tz: string; now: number; settings: Readonly<Record<string, unknown>> }): { next_date: string | null; remind_at: number | null };
  todayOf(ms: number, tz: string): string;
  addDays(d: string, n: number): string;
  isValidTz(tz: string): boolean;
}

/** 心跳 detail：rows 读到几行，written 写了几行（其中 archived 是新归档的），stale 读完被改了没写，skipped 停用账号跳过，failed 算不出或写不进 */
export type HeartbeatDetail = { rows: number; written: number; archived: number; stale: number; skipped: number; failed: number; batch_full: boolean };

export interface Deps {
  cronSecret: string | undefined;
  store: RollStore | null;
  /** private.account_usable（_shared/auth.ts 的 isUsable）；出错抛异常 */
  isUsable(userId: string): Promise<boolean>;
  logic: RollLogic;
  now(): number;
  log(code: string): void;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
  if (denied) return denied;
  if (!deps.store) {
    deps.log('misconfigured:store');
    return json(500, { error: 'misconfigured' });
  }
  let detail: HeartbeatDetail;
  try {
    detail = await runRoll(deps, deps.store);
  } catch {
    deps.log('roll_failed');
    return json(503, { error: 'try_later' });
  }
  try {
    await deps.store.writeHeartbeat(detail);
  } catch {
    deps.log('heartbeat_failed');
    return json(503, { error: 'try_later' });
  }
  return json(200, { ok: true, ...detail });
}

const isLater = (v: unknown, now: number): boolean => typeof v === 'number' && v > now;

const isPast = (row: RollRow, nextDate: string | null, today: string): boolean =>
  row.kind === 'countdown' && (row.after_due ?? 'archive') === 'archive' && nextDate !== null && nextDate < today;

export async function runRoll(deps: Deps, store: RollStore): Promise<HeartbeatDetail> {
  const { logic } = deps;
  const now = deps.now();
  const utc = logic.todayOf(now, 'UTC');
  const rows = await store.candidates(logic.addDays(utc, -1), logic.addDays(utc, 2), BATCH);
  const d: HeartbeatDetail = { rows: rows.length, written: 0, archived: 0, stale: 0, skipped: 0, failed: 0, batch_full: rows.length >= BATCH };
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const usable = new Set<string>();
  await pool(ids, USABLE_CONCURRENCY, async (u) => {
    if (await deps.isUsable(u)) usable.add(u);
  });
  const live = ids.filter((u) => usable.has(u));
  const tzs = await store.profiles(live);
  const sets = await store.settings(live);
  for (const row of rows) {
    const tag = `anniversaries:${row.id.slice(0, 8)}`;
    if (!usable.has(row.user_id)) {
      d.skipped++;
      continue;
    }
    const tz = tzs.get(row.user_id);
    if (tz === undefined || !logic.isValidTz(tz)) {
      d.failed++;
      deps.log(`tz_invalid ${tag}`);
      continue;
    }
    let patch: RollPatch;
    try {
      const nx = logic.annivNextOf(row, { tz, now, settings: sets.get(row.user_id) ?? {} });
      const past = isPast(row, nx.next_date, logic.todayOf(now, tz));
      const held = isLater(row['snooze_at'], now) || isLater(row['defer_until'], now);
      patch = { next_date: nx.next_date, remind_at: held ? row.remind_at : nx.remind_at, archived_at: past ? (row.archived_at ?? now) : null };
    } catch {
      d.failed++;
      deps.log(`bad_anniv ${tag}`);
      continue;
    }
    if (patch.next_date === row.next_date && patch.remind_at === row.remind_at && patch.archived_at === row.archived_at) continue;
    try {
      if (!(await store.write(row, patch))) {
        d.stale++;
        continue;
      }
    } catch {
      d.failed++;
      deps.log(`write_failed ${tag}`);
      continue;
    }
    d.written++;
    if (patch.archived_at !== null && row.archived_at === null) d.archived++;
  }
  return d;
}
