// push-dispatch 测试用的内存数据库（按 store.ts 那几条查询的语义实现，含 private.remind_queue_pop 的出队规则）和共享 logic 接线。
// LOGIC 和 supabase/functions/push-dispatch/index.ts 的 LOGIC 同一写法（那边从 _shared/gen 引，这里直接引 shared/）。
// 推送服务用测试开发的替身 tests/fakes/push-service.ts（进程内 fake.fetch）；造数据按“少量设备、每台多条”（替身复核 N1）。
import { msAt, parseHm, todayOf } from '../../shared/core/date.ts';
import { isValidTz } from '../../shared/core/tz.ts';
import { t } from '../../shared/i18n/i18n.ts';
import { notifyText } from '../../shared/logic/notify-text.ts';
import { allDayTimeOf, dndDeferUntil, eventRemindAt, todoRemindAt } from '../../shared/logic/remind.ts';
import { startAtOf } from '../../shared/logic/remind-actions.ts';
import type { DispatchStore, HeartbeatDetail } from '../../supabase/functions/push-dispatch/core.ts';
import type { DeviceOutcome, DeviceRow, ItemRow, LogRow, Profile, QueueItem, QueueRef, RoundLogic, Table } from '../../supabase/functions/push-dispatch/round.ts';
import { SETTING_KEYS, TABLES } from '../../supabase/functions/push-dispatch/round.ts';
import { makeLogic } from '../../supabase/functions/push-dispatch/logic.ts';

/** 和 index.ts 同一份接线（logic.ts 的 makeLogic），名字一一对应，只是从 shared/ 引（tests/edge/push-dispatch-logic-wiring.test.ts 核对） */
export const LOGIC: RoundLogic = makeLogic({
  todoRemindAt, eventRemindAt, allDayTimeOf, startAtOf, msAt, parseHm, todayOf, isValidTz, dndDeferUntil, notifyText, t,
});

export const UA = 'aaaaaaaa-0000-4000-8000-000000000001';
export const UB = 'bbbbbbbb-0000-4000-8000-000000000002';

let seq = 0;
/** 小写 UUID（负载校验 S3 要求） */
export function uuid(prefix = 'c'): string {
  seq++;
  return `${prefix.repeat(8).slice(0, 8)}-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
}

const base = (user: string): ItemRow => ({
  id: uuid('1'), user_id: user, deleted_at: null, undone: false, source: 'page', push_show_title: null,
  remind_at: null, notified_for: null, snooze_at: null, pushed_for: null, defer_until: null,
});
export const todoRow = (user: string, over: Partial<ItemRow> = {}): ItemRow => ({
  ...base(user), title: '买柠檬', done: false, due: null, due_time: null, remind_before_min: null, remind_days: null, remind_time: '09:00', ...over,
});
export const eventRow = (user: string, over: Partial<ItemRow> = {}): ItemRow => ({
  ...base(user), title: 'NEOX 会议', date: '2026-11-03', time: null, tz: null, remind_min: null, remind_days: null, ...over,
});

/** remind_queue_pop 每人每轮最多出队几条（和迁移 20261103130000 一致） */
export const POP_PER_USER = 50;

type Ranked = { table: Table; row: ItemRow; k: number };
const cmpRanked = (a: Ranked, b: Ranked): number =>
  a.k - b.k || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0) || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);

/** 每人按 k（再按表名、id）编号，留前 perUser 条，再按 (k, 表名, id) 排序取 limit 条（≤ 500）——对应两个 SQL 函数的 row_number 写法 */
function perUserCap(c: Ranked[], perUser: number, limit: number): { table: Table; row: ItemRow }[] {
  const n = new Map<string, number>();
  return [...c].sort(cmpRanked).filter((x) => {
    const i = (n.get(x.row.user_id) ?? 0) + 1;
    n.set(x.row.user_id, i);
    return i <= Math.max(0, perUser);
  }).slice(0, Math.max(0, Math.min(limit, 500))).map((x) => ({ table: x.table, row: { ...x.row } }));
}

/** 内存库：所有写都在一个同步段里完成（JS 单线程，条件更新天然原子，对应 SQL 的行锁） */
export class MemDb implements DispatchStore {
  tables: Record<Table, Map<string, ItemRow>> = { events: new Map(), todos: new Map(), anniversaries: new Map() };
  queue = new Map<string, QueueRef>();
  /** 账号可用（account_usable）；不在里面的按“没有 profile”算 */
  usable = new Map<string, boolean>();
  profs = new Map<string, Profile>();
  sets = new Map<string, Record<string, unknown>>();
  devs: (DeviceRow & { deleted_at: number | null })[] = [];
  logs: LogRow[] = [];
  beats: HeartbeatDetail[] = [];
  /** 调用记录（核对“传了什么”） */
  calls: string[] = [];
  /** 注入故障：方法名 → 抛错 */
  failOn = new Set<string>();

  user(id: string, p: Partial<Profile> = {}, usable = true): this {
    this.usable.set(id, usable);
    this.profs.set(id, { current_tz: 'Asia/Seoul', ui_locale: 'zh-CN', ...p });
    return this;
  }
  put(table: Table, row: ItemRow, enqueue = false): ItemRow {
    this.tables[table].set(row.id, row);
    if (enqueue) this.queue.set(`${table}:${row.id}`, { table_name: table, id: row.id });
    return row;
  }
  /**
   * 客户端编辑一行（对应真库 UPDATE 时的三个触发器，真库语义在 rls/32 ⑧ 和 0001 的 touch()）：
   * events_occ_reset——日程的 date、remind_days 变了，或 time 在空和非空之间变了，清 notified_for、snooze_at（这次没改它们的值时，R3-L2）和 pushed_for（二轮审查 N-M1）；
   * 和真库一样按“值有没有变”判断（R3-L3），不看补丁里写没写这一列（客户端常常整行写回）；
   * touch()——提醒相关列变了清 pushed_for、defer_until；events_remind / todos_remind——这些列变了入 remind_queue
   */
  edit(table: Table, id: string, patch: Partial<ItemRow>): ItemRow {
    const old = this.tables[table].get(id);
    if (!old) throw new Error(`没有这一行 ${table}:${id}`);
    const row: ItemRow = { ...old, ...patch };
    const changed = (k: string) => row[k] !== old[k];
    if (table === 'events' && (changed('date') || changed('remind_days') || (old['time'] == null) !== (row['time'] == null))) {
      for (const k of ['notified_for', 'snooze_at'] as const) {
        if (!changed(k)) row[k] = null;
      }
      row.pushed_for = null;
    }
    const remindCols = ['date', 'time', 'tz', 'due', 'due_time', 'remind_before_min', 'remind_min', 'remind_days', 'remind_time', 'done', 'deleted_at'];
    if (remindCols.some(changed)) {
      row.pushed_for = null;
      row.defer_until = null;
    }
    this.tables[table].set(id, row);
    if ([...remindCols, 'snooze_at'].some(changed)) this.queue.set(`${table}:${id}`, { table_name: table, id });
    return row;
  }
  device(user: string, sub: { endpoint: string; p256dh: string; auth: string }): DeviceRow {
    const d = { id: uuid('d'), user_id: user, push_endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, push_fail_count: 0, deleted_at: null };
    this.devs.push(d);
    return d;
  }
  private check(name: string) {
    this.calls.push(name);
    if (this.failOn.has(name)) throw new Error('db');
  }

  async writeHeartbeat(d: HeartbeatDetail) {
    this.check('writeHeartbeat');
    this.beats.push(d);
  }
  async popQueue(limit: number): Promise<QueueItem[]> {
    this.check('popQueue');
    for (const [k, q] of this.queue) if (!this.tables[q.table_name].has(q.id)) this.queue.delete(k);   // 孤儿
    // 照 remind_queue_pop：可用账号的按人编号（按 table_name:id），先比编号再比键，每人最多 POP_PER_USER 条
    const rank = new Map<string, number>();
    const cand: { k: string; q: QueueRef; u: string; rn: number }[] = [];
    for (const k of [...this.queue.keys()].sort()) {
      const q = this.queue.get(k) as QueueRef;
      const u = (this.tables[q.table_name].get(q.id) as ItemRow).user_id;
      if (!this.usable.get(u)) continue;
      const rn = (rank.get(u) ?? 0) + 1;
      rank.set(u, rn);
      if (rn <= POP_PER_USER) cand.push({ k, q, u, rn });
    }
    cand.sort((a, b) => a.rn - b.rn || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    const out: QueueItem[] = [];
    for (const x of cand.slice(0, Math.max(0, Math.min(limit, 500)))) {
      this.queue.delete(x.k);
      out.push({ ...x.q, user_id: x.u });
    }
    return out;
  }
  async requeue(items: readonly QueueRef[]) {
    this.check('requeue');
    for (const q of items) this.queue.set(`${q.table_name}:${q.id}`, { ...q });
  }
  async rows(table: Table, ids: readonly string[]) {
    this.check('rows');
    return ids.map((id) => this.tables[table].get(id)).filter((r): r is ItemRow => !!r).map((r) => ({ ...r }));
  }
  async profiles(users: readonly string[]) {
    this.check('profiles');
    return new Map(users.filter((u) => this.profs.has(u)).map((u) => [u, { ...(this.profs.get(u) as Profile) }]));
  }
  async settings(users: readonly string[]) {
    this.check('settings');
    const keys: readonly string[] = SETTING_KEYS;
    return new Map(users.filter((u) => this.sets.has(u)).map((u) => [u, Object.fromEntries(Object.entries(this.sets.get(u) ?? {}).filter(([k]) => keys.includes(k)))]));
  }
  async writeRemind(table: Table, id: string, user: string, patch: { remind_at: number | null; next_date?: string | null }, prev: number | null) {
    this.check('writeRemind');
    const r = this.tables[table].get(id);
    if (!r || r.user_id !== user || r.remind_at !== prev) return false;   // 乐观条件
    r.remind_at = patch.remind_at;
    if (patch.next_date !== undefined) r.next_date = patch.next_date;
    return true;
  }
  /** 照 private.remind_due 的 SQL 写（不调 round.ts 的 isDue，两边各写一遍才对得出差异）：精确条件、只回可用账号的、
   *  只回至少有一台可推设备（未删、push_endpoint 不空）的人的（代码审查 M4）、每人最多 perUser 条 */
  async dueRows(lo: number, hi: number, perUser: number, limit: number) {
    this.check('dueRows');
    const c: Ranked[] = [];
    for (const table of TABLES) {
      for (const r of this.tables[table].values()) {
        if (r.deleted_at !== null || r.undone || (table === 'todos' && r.done) || r.remind_at === null || r.remind_at > hi) continue;
        if ((r.notified_for ?? 0) === r.remind_at) continue;
        const d = Math.max(...[r.remind_at, r.snooze_at, r.defer_until].filter((v): v is number => v !== null));
        if (!(d > lo && d <= hi) || (r.pushed_for ?? 0) === d || !this.usable.get(r.user_id)) continue;
        if (!this.devs.some((x) => x.user_id === r.user_id && x.deleted_at === null && x.push_endpoint !== null)) continue;
        c.push({ table, row: r, k: d });
      }
    }
    return perUserCap(c, perUser, limit);
  }
  /** 照 private.remind_pushed 的 SQL 写 */
  async pushedRows(lo: number, hi: number, perUser: number, limit: number) {
    this.check('pushedRows');
    const c: Ranked[] = [];
    for (const table of TABLES) {
      for (const r of this.tables[table].values()) {
        if (r.pushed_for === null || !(r.pushed_for > lo && r.pushed_for <= hi) || !this.usable.get(r.user_id)) continue;
        const vs = [r.remind_at, r.snooze_at, r.defer_until].filter((v): v is number => v !== null);
        const d = vs.length ? Math.max(...vs) : null;
        const gone = r.deleted_at !== null || r.undone || (table === 'todos' && r.done);   // R-317
        if (gone || (r.remind_at !== null && r.notified_for === r.remind_at) || d === null || d !== r.pushed_for) c.push({ table, row: r, k: r.pushed_for });
      }
    }
    return perUserCap(c, perUser, limit);
  }
  async setDeferUntil(table: Table, id: string, user: string, until: number) {
    this.check('setDeferUntil');
    const r = this.tables[table].get(id);
    if (r && r.user_id === user) r.defer_until = until;
  }
  async claim(table: Table, id: string, user: string, due: number) {
    this.check('claim');
    const r = this.tables[table].get(id);
    if (!r || r.user_id !== user || r.pushed_for === due) return false;
    r.pushed_for = due;
    return true;
  }
  async releasePushed(table: Table, id: string, user: string, pushedFor: number) {
    this.check('releasePushed');
    const r = this.tables[table].get(id);
    if (!r || r.user_id !== user || r.pushed_for !== pushedFor) return false;
    r.pushed_for = null;
    return true;
  }
  async devices(users: readonly string[]) {
    this.check('devices');
    return this.devs.filter((d) => users.includes(d.user_id) && d.deleted_at === null && d.push_endpoint !== null).map((d) => ({ ...d }));
  }
  async deviceOutcome(dev: DeviceRow, r: DeviceOutcome) {
    this.check('deviceOutcome');
    const d = this.devs.find((x) => x.id === dev.id && x.push_endpoint === dev.push_endpoint);
    if (!d) return;
    if (r.drop) Object.assign(d, { push_endpoint: null, p256dh: null, auth: null });
    else if (r.ok) d.push_fail_count = 0;
    else if (r.fails > 0) d.push_fail_count = dev.push_fail_count + r.fails;
  }
  async insertLogs(rows: readonly LogRow[]) {
    this.check('insertLogs');
    this.logs.push(...rows);
  }
  async tzLoggedSince(users: readonly string[], since: number) {
    this.check('tzLoggedSince');
    return new Set(this.logs.filter((l) => l.act === 'tz_invalid' && l.t > since && users.includes(l.user_id)).map((l) => l.user_id));
  }
}
