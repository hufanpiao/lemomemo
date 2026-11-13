// push-dispatch 的数据库读写（supabase-js，service role）：只在 index.ts 里用；查询写法由 tests/functions/push-dispatch-store.test.ts 核对，逻辑测试用内存替身。
// 系统写入（remind_at、next_date、pushed_for、defer_until、push_fail_count、last_push_ok_at）在 table_meta.system_cols 里，touch() 不加 rev、不入队；
//   清订阅三列不是系统列，会加 rev、同步给那台设备。每条写都带 user_id 条件；标题只在内存里组文案，不进日志。
// 出错一律抛 Error：请求超时（_shared/net.ts 到点中止）抛 DB_TIMEOUT，其余抛 'db'（调用方按 failCode 记 `<码>` 或 `<码>:timeout`）。
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import type { DispatchStore } from './core.ts';
import { DB_TIMEOUT, LOG_SRC, SETTING_KEYS, TABLES, type DeviceRow, type ItemRow, type Profile, type QueueItem, type Table, type UserSettings } from './round.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

// anniversaries 没有 source 列（0005_anniv.sql；代码审查 M1）：source 只在 events、todos 两支里读；纪念日的 source 按 'page' 补
const COMMON = 'id, user_id, deleted_at, undone, push_show_title, remind_at, notified_for, snooze_at, pushed_for, defer_until';
/** 每张表读哪些列（switch：check_backend F7 不许用变量做方括号键；tests/build/push-dispatch-cols.test.ts 核对每列都在 db.types.ts 里） */
export function colsOf(table: Table): string {
  switch (table) {
    case 'events': return `${COMMON}, source, title, date, time, tz, remind_min, remind_days`;
    case 'todos': return `${COMMON}, source, title, done, due, due_time, remind_before_min, remind_days, remind_time`;
    default: return `${COMMON}, name, kind, calendar, lunar_variant, month, day, is_leap, year, remind_offsets, remind_time, after_due, next_date`;
  }
}
const DEVICE_COLS = 'id, user_id, push_endpoint, p256dh, auth, push_fail_count';

/**
 * supabase-js 把 fetch 抛的异常转成 error 返回，message 是“异常名: 文字”（@supabase/postgrest-js 2.118 的 executeWithRetry 之后那段）；
 * timedFetch 中止时异常名是 TimeoutError，手动中止是 AbortError。只看开头的异常名，不看文字
 */
export function dbError(error: unknown): Error {
  const m = (error as { message?: unknown } | null)?.message;
  return new Error(typeof m === 'string' && /^(TimeoutError|AbortError):/.test(m) ? DB_TIMEOUT : 'db');
}
function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw dbError(r.error);
  return r.data as T;
}

type Key = { table_name: Table; id: string; user_id: string };

/** .in(...) 一批最多放多少个 UUID（代码审查 M5）：500 个约 18.5 KB 查询串，可能被网关回 414 / 400、整轮失败；100 个约 3.7 KB */
export const IN_CHUNK = 100;

/** 按 IN_CHUNK 分批跑同一个查询、合并结果（先去重；空列表不发请求）。批与批之间按顺序发，不并发 */
export async function inChunks<T>(ids: readonly string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const all = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < all.length; i += IN_CHUNK) out.push(...(await run(all.slice(i, i + IN_CHUNK))));
  return out;
}

export function makeStore(admin: Admin): DispatchStore {
  const priv = admin.schema('private');
  async function readRows(table: Table, ids: readonly string[]): Promise<ItemRow[]> {
    const rows = await inChunks(ids, async (c) => must(await admin.from(table).select(colsOf(table)).in('id', c)) as unknown as ItemRow[]);
    return table === 'anniversaries' ? rows.map((r) => ({ ...r, source: 'page' })) : rows;
  }
  /** 按 SQL 给的 (table, id, user_id) 读整行（每表按 IN_CHUNK 分批），保持 SQL 的顺序；读的时候行没了、或 user_id 对不上的丢掉 */
  async function keyed(keys: readonly Key[]): Promise<{ table: Table; row: ItemRow }[]> {
    const by = new Map<string, ItemRow>();
    for (const table of TABLES) {
      const ids = keys.filter((k) => k.table_name === table).map((k) => k.id);
      for (const r of await readRows(table, ids)) by.set(`${table}:${r.id}`, r);
    }
    const out: { table: Table; row: ItemRow }[] = [];
    for (const k of keys) {
      const row = by.get(`${k.table_name}:${k.id}`);
      if (row && row.user_id === k.user_id) out.push({ table: k.table_name, row });
    }
    return out;
  }
  return {
    async writeHeartbeat(detail, poison) {
      // 心跳名 push-dispatch（core.ts 的 HEARTBEAT）由函数写死；queue_poison 在 SQL 里按首尔当天原子累加（迁移 20261105140000，REMIND-poison-atomic）
      const total = must(await priv.rpc('push_heartbeat_write', { p_detail: detail, p_poison: poison }));
      if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) throw new Error('db');   // 返回值不对不是超时
      return total;
    },
    async popQueue(limit, leaseS, retry, perUser, poison, ver) {
      // 强转（代码审查 L4）：生成类型按函数返回列一律给非空（claim: string），但有毒项返回的 claim 是 null。
      //   QueueItem 写的是 string | null，round-step0.ts 靠它判有毒项，不要照生成类型去掉 null 判断
      return must(await priv.rpc('remind_queue_pop', {
        p_limit: limit, p_lease_s: leaseS, p_retry: retry, p_per_user: perUser, p_poison: poison, p_ver: ver,
      })) as QueueItem[];
    },
    async finishQueue(claim, release) {
      const { error } = await priv.rpc('remind_queue_finish', { p_claim: claim, p_release: release.map((x) => ({ table_name: x.table_name, id: x.id })) });
      if (error) throw dbError(error);
    },
    async queueStats() {
      // private.remind_queue_stats（迁移 20261113100000）：一行，只算可用账号的项
      const rows = must(await priv.rpc('remind_queue_stats')) as { user_items: number; batch_items: number; oldest_user_wait_s: number }[];
      const r = rows[0];
      const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
      return { queue_wait0: n(r?.user_items), queue_wait_batch: n(r?.batch_items), queue_oldest_s: n(r?.oldest_user_wait_s) };
    },
    async rows(table, ids) {
      return readRows(table, ids);
    },
    async profiles(userIds) {
      const rows = await inChunks(userIds, async (c) => must(await admin.from('profiles').select('user_id, current_tz, ui_locale').in('user_id', c)) as
        { user_id: string; current_tz: string; ui_locale: string }[]);
      return new Map(rows.map((r) => [r.user_id, { current_tz: r.current_tz, ui_locale: r.ui_locale } satisfies Profile]));
    },
    async settings(userIds) {
      // 只认“活着”的设置：没软删、没撤销（和本机 remind-settings 同一口径；撤销了的按没设处理，11-04）
      const rows = await inChunks(userIds, async (c) => must(await admin.from('settings').select('user_id, key, value').in('user_id', c)
        .in('key', [...SETTING_KEYS]).is('deleted_at', null).eq('undone', false)) as { user_id: string; key: string; value: unknown }[]);
      const byUser = new Map<string, [string, unknown][]>();
      for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), [r.key, r.value]]);
      return new Map([...byUser].map(([u, kv]) => [u, Object.fromEntries(kv) as UserSettings]));
    },
    async writeRemind(table, id, userId, patch, prevRemindAt, prevNotifiedFor) {
      const body: Record<string, unknown> = { remind_at: patch.remind_at };
      if (table === 'anniversaries' && patch.next_date !== undefined) body.next_date = patch.next_date;
      // 乐观条件（代码审查建议 ④）：remind_at 还是读到的旧值才写
      const q0 = admin.from(table).update(body).eq('id', id).eq('user_id', userId);
      const q = prevNotifiedFor === undefined ? q0 : q0.eq('notified_for', prevNotifiedFor);   // S1 例外另比 notified_for（安全审查 A4）
      const rows = must(await (prevRemindAt === null ? q.is('remind_at', null) : q.eq('remind_at', prevRemindAt)).select('id')) as { id: string }[];
      return rows.length === 1;
    },
    async dueRows(lo, hi, perUser, limit) {
      return keyed(must(await priv.rpc('remind_due', { p_lo: lo, p_hi: hi, p_per_user: perUser, p_limit: limit })) as Key[]);
    },
    async pushedRows(lo, hi, perUser, limit) {
      return keyed(must(await priv.rpc('remind_pushed', { p_lo: lo, p_hi: hi, p_per_user: perUser, p_limit: limit })) as Key[]);
    },
    async setDeferUntil(table, id, userId, until) {
      must(await admin.from(table).update({ defer_until: until }).eq('id', id).eq('user_id', userId));
    },
    async claim(table, id, userId, dueAt) {
      // where pushed_for is distinct from due_at：PostgREST 写成 pushed_for 为空、或不等于
      const rows = must(await admin.from(table).update({ pushed_for: dueAt }).eq('id', id).eq('user_id', userId)
        .or(`pushed_for.is.null,pushed_for.neq.${dueAt}`).select('id')) as { id: string }[];
      return rows.length === 1;
    },
    async releasePushed(table, id, userId, pushedFor) {
      const rows = must(await admin.from(table).update({ pushed_for: null }).eq('id', id).eq('user_id', userId)
        .eq('pushed_for', pushedFor).select('id')) as { id: string }[];
      return rows.length === 1;
    },
    async devices(userIds) {
      return await inChunks(userIds, async (c) => must(await admin.from('devices').select(DEVICE_COLS).in('user_id', c).is('deleted_at', null)
        .not('push_endpoint', 'is', null)) as unknown as DeviceRow[]);
    },
    async deviceOutcome(dev, r, nowIso) {
      // 只在订阅还是发送时那一串时才写（这一轮里设备重新认领了新地址，就不动它）
      const q = (body: Record<string, unknown>) => admin.from('devices').update(body).eq('id', dev.id).eq('user_id', dev.user_id)
        .eq('push_endpoint', dev.push_endpoint ?? '');
      if (r.drop) must(await q({ push_endpoint: null, p256dh: null, auth: null }));
      else if (r.ok) must(await q({ last_push_ok_at: nowIso, push_fail_count: 0 }));
      else if (r.fails > 0) must(await q({ push_fail_count: dev.push_fail_count + r.fails }));
    },
    async insertLogs(rows) {
      must(await admin.from('logs').insert(rows.map((x) => ({ ...x }))));
    },
    async tzLoggedSince(userIds, since) {
      // 走 logs_account_export_idx (user_id, act, src, code)；每批最多 100 人，limit 1000 按批算
      const rows = await inChunks(userIds, async (c) => must(await admin.from('logs').select('user_id').in('user_id', c).eq('act', 'tz_invalid').eq('src', LOG_SRC)
        .gt('t', since).limit(1000)) as { user_id: string }[]);
      return new Set(rows.map((r) => r.user_id));
    },
  };
}
