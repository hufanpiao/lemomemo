// push-dispatch 测试用的内存数据库（按 store.ts 那几条查询的语义实现：入队 remind_enqueue、出队 remind_queue_pop、收尾 remind_queue_finish、
// 积压 remind_queue_stats 照迁移 20261113100000，其余照各自的迁移）和共享 logic 接线。
// LOGIC 和 supabase/functions/push-dispatch/index.ts 的 LOGIC 同一写法（那边从 _shared/gen 引，这里直接引 shared/）。
// 推送服务用测试开发的替身 tests/fakes/push-service.ts（进程内 fake.fetch）；造数据按“少量设备、每台多条”（替身复核 N1）。
import { msAt, parseHm } from '../../shared/core/date.ts';
import { isValidTz } from '../../shared/core/tz.ts';
import { t } from '../../shared/i18n/i18n.ts';
import { notifyText } from '../../shared/logic/notify-text.ts';
import { allDayTimeOf, dndDeferUntil, REMIND_RULES_VER, remindAtOf, sameRemindDay } from '../../shared/logic/remind.ts';
import { startAtOf } from '../../shared/logic/remind-actions.ts';
import { occurrenceKey, reminderTag } from '../../shared/logic/remind-route.ts';
import { annivNextOf } from '../../shared/logic/anniv/next-date.ts';
import type { DispatchStore, HeartbeatDetail, QueueStats } from '../../supabase/functions/push-dispatch/core.ts';
import { QUEUE_PER_USER, QUEUE_POISON, seoulDay } from '../../supabase/functions/push-dispatch/core.ts';
import type { DeviceOutcome, DeviceRow, ItemRow, LogRow, Profile, QueueItem, QueueRef, RoundLogic, Table } from '../../supabase/functions/push-dispatch/round.ts';
import { DB_DATA, DB_TIMEOUT, SETTING_KEYS, TABLES } from '../../supabase/functions/push-dispatch/round.ts';
import { makeLogic } from '../../supabase/functions/push-dispatch/logic.ts';

/** 和 index.ts 同一份接线（logic.ts 的 makeLogic），名字一一对应，只是从 shared/ 引（tests/edge/push-dispatch-logic-wiring.test.ts 核对） */
export const LOGIC: RoundLogic = makeLogic({
  REMIND_RULES_VER, remindAtOf, allDayTimeOf, startAtOf, msAt, parseHm, sameRemindDay, isValidTz, dndDeferUntil, notifyText, t, reminderTag, occurrenceKey, annivNextOf,
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
export const annivRow = (user: string, over: Partial<ItemRow> = {}): ItemRow => ({
  ...base(user), name: '妈妈生日', kind: 'birthday', calendar: 'solar', month: 11, day: 20, remind_offsets: null, remind_time: null, ...over,
});

/** 新项按批出队每人最多几条、取过几次就当有毒项（push-dispatch 的 LIMITS 传给出队函数，这里取同一个常量） */
export const POP_PER_USER = QUEUE_PER_USER;
export const POISON_AT = QUEUE_POISON;
/**
 * 队列的一项（private.remind_queue 的列）。测试里直接 queue.set 的可以少写：claim 为空 = 没人在处理，attempts、prio、min_ver 按 0，
 * fresh 按 false，enqueued_at 按 0；user_id 没写按行上的 user_id 补（只是造数方便：真库 user_id 非空，行被硬删了也还在）
 */
export type QEntry = QueueRef & {
  user_id?: string; prio?: number; fresh?: boolean; min_ver?: number; enqueued_at?: number;
  claim?: string | null; claimed_at?: number | null; attempts?: number;
};
/** 第 0 步没有要重算的、队列为空时，心跳里 R-411 加的六项（方案 3.7） */
export const QUIET_BEAT = { recalc_written: 0, recalc_r336: 0, recalc_failed: 0, queue_wait0: 0, queue_wait_batch: 0, queue_oldest_s: 0 } as const;
/** remind_enqueue 的批量范围（row 一支是 enqueue） */
export type EnqueueScope = 'floating' | 'allday' | 'anniv' | 'all';

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
/**
 * touch() 的提醒列，三张表合起来（纪念日那一组 11-05 补齐）。替身自己写一份、不引 shared 的 TOUCH_REMIND_COLS：
 * tests/edge/push-dispatch-mem-reset.test.ts 从 0001 的 touch() 解析出列清单，和这份、shared 那份三方比对（审查 M4）
 */
export const MEM_TOUCH_COLS: readonly string[] = ['date', 'time', 'tz', 'due', 'due_time', 'remind_before_min', 'remind_min', 'remind_days', 'remind_time',
  'remind_offsets', 'month', 'day', 'calendar', 'lunar_variant', 'is_leap', 'year', 'after_due', 'kind', 'done', 'deleted_at'];

export class MemDb implements DispatchStore {
  tables: Record<Table, Map<string, ItemRow>> = { events: new Map(), todos: new Map(), anniversaries: new Map() };
  queue = new Map<string, QEntry>();
  /** 出队函数里的 now()（租约过期判断）；测试把它接到 ctx 的时钟上 */
  clock: () => number = () => Date.now();
  private claimSeq = 0;
  /** 账号可用（account_usable）；不在里面的按“没有 profile”算 */
  usable = new Map<string, boolean>();
  profs = new Map<string, Profile>();
  sets = new Map<string, Record<string, unknown>>();
  devs: (DeviceRow & { deleted_at: number | null })[] = [];
  logs: LogRow[] = [];
  /** 每次写进心跳的 detail（queue_poison 是累计后的值） */
  beats: HeartbeatDetail[] = [];
  /** 心跳行（private.heartbeat 的 push-dispatch 那一行）：at 是毫秒，按 clock 记；detail 可以由用例直接改成不合格的旧值 */
  lastBeat: { at: number; detail: unknown } | null = null;
  /** 模拟“被用户事务锁着”的队列项（键 table:id）：finish 的放回和删除 skip locked，跳过它们（迁移 20261104130000，安全审查必改 2） */
  locked = new Set<string>();
  /** 调用记录（核对“传了什么”） */
  calls: string[] = [];
  /** 注入故障：方法名 → 抛错（store 的 'db'） */
  failOn = new Set<string>();
  /** 注入超时：方法名 → 抛 DB_TIMEOUT（store 在 timedFetch 到点中止时抛的） */
  timeoutOn = new Set<string>();
  /** 注入数据类错误：方法名 → 抛 DB_DATA（store 在 PostgREST 回 SQLSTATE 22、23 类时抛的） */
  dataOn = new Set<string>();

  user(id: string, p: Partial<Profile> = {}, usable = true): this {
    this.usable.set(id, usable);
    this.profs.set(id, { current_tz: 'Asia/Seoul', ui_locale: 'zh-CN', ...p });
    return this;
  }
  /** 插一行；enqueue 为真时照 after insert 触发器入队（prio 0，待办 fresh） */
  put(table: Table, row: ItemRow, enqueue = false): ItemRow {
    this.tables[table].set(row.id, row);
    if (enqueue) this.enqueue(table, row.id, { fresh: table === 'todos' });
    return row;
  }
  /**
   * 照 private.remind_enqueue 的 on conflict（迁移 20261113100000）：不在的新插（enqueued_at = 现在）；在的，有要改的才写——
   * user_id 换成这一次的、清租约、attempts 清零、prio 取小、fresh 取或、min_ver 取大（enqueued_at 只在 prio 变小时记成现在）。默认 prio 0（row 一支）
   */
  enqueue(table: Table, id: string, o: { prio?: number; fresh?: boolean; minVer?: number; user?: string } = {}): void {
    const k = `${table}:${id}`;
    const q = this.queue.get(k);
    const user = o.user ?? this.tables[table].get(id)?.user_id;
    if (!user) throw new Error(`入队要有 user_id：${k}`);
    const prio = o.prio ?? 0;
    const fresh = o.fresh ?? false;
    const minVer = o.minVer ?? 0;
    if (!q) {
      this.queue.set(k, { table_name: table, id, user_id: user, prio, fresh, min_ver: minVer, enqueued_at: this.clock(), claim: null, claimed_at: null, attempts: 0 });
      return;
    }
    const qu = q.user_id ?? this.tables[table].get(id)?.user_id;
    const qp = q.prio ?? 0;
    const qf = q.fresh ?? false;
    const qv = q.min_ver ?? 0;
    if (qu === user && !q.claim && (q.attempts ?? 0) === 0 && prio >= qp && !(fresh && !qf) && minVer <= qv) return;
    this.queue.set(k, { ...q, user_id: user, claim: null, claimed_at: null, attempts: 0, prio: Math.min(qp, prio), fresh: qf || fresh, min_ver: Math.max(qv, minVer),
      ...(prio < qp ? { enqueued_at: this.clock() } : {}) });
  }
  /**
   * 照 remind_enqueue 的批量几支（口径写在迁移的函数注释上）：floating 收没到点或还没算的；allday、all 的日程和待办收日期没过两天以上、
   * 或“稍后”、免打扰顺延还在 1 小时以内的；anniv、all 的纪念日不看时间。prio 1 = remind_at 为空或 24 小时内，否则 2。user 为空只给 all 用
   */
  enqueueScope(scope: EnqueueScope, user: string | null, minVer = 0): void {
    const now = this.clock();
    const soon = now + 86_400_000;
    const win = now - 3_600_000;
    const cut = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
    const prioOf = (r: ItemRow) => (r.remind_at === null || r.remind_at <= soon ? 1 : 2);
    const mine = (r: ItemRow) => r.deleted_at === null && (scope === 'all' || r.user_id === user);
    const ahead = (r: ItemRow, set: boolean) => (r.remind_at !== null && r.remind_at > now) || (r.remind_at === null && set);
    const open = (r: ItemRow, day: unknown) => (typeof day === 'string' && day >= cut) || (r.snooze_at ?? 0) > win || (r.defer_until ?? 0) > win;
    const add = (t: Table, r: ItemRow) => this.enqueue(t, r.id, { prio: prioOf(r), minVer, user: r.user_id });
    for (const r of this.tables.events.values()) {
      if (!mine(r)) continue;
      const allDay = r.time == null;
      const set = allDay ? r.remind_days != null : r.remind_min != null;
      if (scope === 'floating' ? allDay && ahead(r, r.remind_days != null)
        : scope === 'allday' ? allDay && set && open(r, r.date)
        : scope === 'all' && set && open(r, r.date)) add('events', r);
    }
    for (const r of this.tables.todos.values()) {
      if (!mine(r) || r.done) continue;
      const set = r.due != null && (r.due_time == null ? r.remind_days != null : r.remind_before_min != null);
      if (scope === 'floating' ? ahead(r, set) : scope === 'all' && set && open(r, r.due)) add('todos', r);
    }
    for (const r of this.tables.anniversaries.values()) {
      if (!mine(r)) continue;
      if (scope === 'floating' ? ahead(r, true)
        : scope === 'anniv' ? r['remind_offsets'] == null || r.remind_time == null
        : scope === 'all') add('anniversaries', r);
    }
  }
  /**
   * 客户端编辑一行（对应真库 UPDATE 时 touch() 里调的 private.remind_reset 和 after 触发器 private.enqueue_remind，迁移 20261113100000；
   * 真库语义在 rls/49、rls/33、rls/36 和 rls/38 的向量）：
   * remind_reset——日程“换了哪一次”（date、remind_days 变了，或 time 在空和非空之间变了）清 notified_for、snooze_at（这次没改它们的值时；
   *   notified_for 改成了 old.remind_at 也清）和 pushed_for；提醒输入列有一列变了清 pushed_for、defer_until；
   * 和真库一样按“值有没有变”判断，不看补丁里写没写这一列（客户端常常整行写回）；
   * enqueue_remind——提醒输入列或 snooze_at 变了入队；全天日程的 notified_for 改成不等于 remind_at 的值时也入队
   */
  edit(table: Table, id: string, patch: Partial<ItemRow>): ItemRow {
    const old = this.tables[table].get(id);
    if (!old) throw new Error(`没有这一行 ${table}:${id}`);
    const row: ItemRow = { ...old, ...patch };
    // 同 SQL 的 is distinct from：空和没有都算 null，数组（纪念日的 remind_offsets）按值比（11-05 三方对照 rls/38 补）
    const val = (v: unknown) => (v === undefined ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    const changed = (k: string) => val(row[k]) !== val(old[k]);
    if (table === 'events' && (changed('date') || changed('remind_days') || (old['time'] == null) !== (row['time'] == null))) {
      for (const k of ['notified_for', 'snooze_at'] as const) {
        if (!changed(k)) row[k] = null;
      }
      // 离线合并进来的旧“知道了”（等于 old.remind_at）照样清
      if (old.remind_at != null && row.notified_for === old.remind_at) row.notified_for = null;
      row.pushed_for = null;
    }
    // touch()：待办的 due 是空的，连带清 due_time、remind_before_min（0001，0.29 续第 136 条）
    if (table === 'todos' && val(row['due']) === null) {
      row['due_time'] = null;
      row['remind_before_min'] = null;
    }
    const remindCols = MEM_TOUCH_COLS;
    if (remindCols.some(changed)) {
      row.pushed_for = null;
      row.defer_until = null;
    }
    this.tables[table].set(id, row);
    // enqueue_remind：待办改了截止日期、截止时刻、提前量是 fresh（第 0 步回落用，R-411 Q2）
    const fresh = table === 'todos' && ['due', 'due_time', 'remind_before_min'].some(changed);
    if ([...remindCols, 'snooze_at'].some(changed)) this.enqueue(table, id, { fresh });
    // enqueue_remind 的“知道了”一支（REMIND-shown-persist S1）：全天日程的 notified_for 改成了不等于 remind_at 的值，入队
    if (table === 'events' && row['time'] == null && row.deleted_at == null && row.remind_days != null && row.notified_for != null && changed('notified_for')
      && row.notified_for !== row.remind_at) this.enqueue(table, id);
    return row;
  }
  device(user: string, sub: { endpoint: string; p256dh: string; auth: string }): DeviceRow {
    const d = { id: uuid('d'), user_id: user, push_endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, push_fail_count: 0, deleted_at: null };
    this.devs.push(d);
    return d;
  }
  private check(name: string) {
    this.calls.push(name);
    if (this.timeoutOn.has(name)) throw new Error(DB_TIMEOUT);
    if (this.dataOn.has(name)) throw new Error(DB_DATA);
    if (this.failOn.has(name)) throw new Error('db');
  }

  /** 照 private.push_heartbeat_write（迁移 20261105140000）：这一轮截到 0～100000；旧行同一个首尔日、旧值是 0～999999999 的整数就累加，否则从这一轮重新算 */
  async writeHeartbeat(d: Omit<HeartbeatDetail, 'queue_poison'>, poison: number): Promise<number> {
    this.check('writeHeartbeat');
    // 非整数在真实调用里 PostgREST 转 int 就报错（store 抛 db → 503）；调用方只传整数，这里照真实的抛错（审查 L2）
    if (!Number.isInteger(poison)) throw new Error('db');
    const add = Math.max(0, Math.min(poison, 100_000));
    const now = this.clock();
    const prev = this.lastBeat;
    const old = prev && typeof prev.detail === 'object' && prev.detail !== null && !Array.isArray(prev.detail)
      ? (prev.detail as Record<string, unknown>)['queue_poison'] : undefined;
    const at = prev ? Math.max(prev.at, now) : now;   // greatest(h.at, now())，审查 L1
    const ok = prev !== null && seoulDay(prev.at) === seoulDay(at) && typeof old === 'number' && Number.isInteger(old) && old >= 0 && old <= 999_999_999;
    const total = ok ? (old as number) + add : add;
    const detail: HeartbeatDetail = { ...d, queue_poison: total };
    this.beats.push(detail);
    this.lastBeat = { at, detail };
    return total;
  }
  /**
   * 照 remind_queue_pop（迁移 20261113100000）：只取没被租的或租约过期的、min_ver ≤ ver 的；retry 只取取过的（attempts ≥ 1）、一次 1 项，
   * 否则只取新项（attempts = 0）、≤ 500。人从队列项取（孤儿照常出队），只要可用账号的；每人按 (prio, 表, id) 编号、留前 perUser 条；
   * 排序：重试按 attempts、claimed_at（空的最先），新项按 (prio, 编号, 表, id)。取满 poison 次的删掉、以 claim 为空返回
   */
  async popQueue(limit: number, leaseS: number | null = 180, retry = false, perUser = POP_PER_USER, poison = POISON_AT, ver = 0): Promise<QueueItem[]> {
    this.check('popQueue');
    const now = this.clock();
    const leaseMs = Math.max(30, Math.min(leaseS ?? 180, 3600)) * 1000;
    const per = Math.max(1, perUser);
    const cmpS = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    type C = { k: string; q: QEntry; u: string; pr: number; rn: number };
    const all: C[] = [];
    for (const [k, q] of this.queue) {
      if (q.claim && (q.claimed_at ?? now) >= now - leaseMs) continue;   // 租着、没过期
      if (((q.attempts ?? 0) >= 1) !== retry) continue;                   // 两种出队互不取对方的项（11-05 安全复审 N1）
      if ((q.min_ver ?? 0) > ver) continue;
      const u = q.user_id ?? this.tables[q.table_name].get(q.id)?.user_id;
      if (!u || !this.usable.get(u)) continue;
      all.push({ k, q, u, pr: q.prio ?? 0, rn: 0 });
    }
    const rank = new Map<string, number>();
    for (const x of [...all].sort((a, b) => a.pr - b.pr || cmpS(a.q.table_name, b.q.table_name) || cmpS(a.q.id, b.q.id))) {
      x.rn = (rank.get(x.u) ?? 0) + 1;
      rank.set(x.u, x.rn);
    }
    const cat = (x: C) => (x.q.claimed_at ?? -Infinity);
    const cand = all.filter((x) => x.rn <= per)
      .sort((a, b) => (retry ? (a.q.attempts ?? 0) - (b.q.attempts ?? 0) || cat(a) - cat(b) : 0)
        || a.pr - b.pr || a.rn - b.rn || cmpS(a.q.table_name, b.q.table_name) || cmpS(a.q.id, b.q.id))
      .slice(0, Math.max(0, Math.min(limit, retry ? 1 : 500)));
    const out: QueueItem[] = [];
    const claim = `cccccccc-0000-4000-8000-${(++this.claimSeq).toString(16).padStart(12, '0')}`;
    for (const x of cand) {
      const att = x.q.attempts ?? 0;
      if (att >= Math.max(1, poison)) {
        this.queue.delete(x.k);
        out.push({ table_name: x.q.table_name, id: x.q.id, user_id: x.u, claim: null, fresh: false, prio: x.pr });
        continue;
      }
      this.queue.set(x.k, { ...x.q, claim, claimed_at: now, attempts: att + 1 });
      out.push({ table_name: x.q.table_name, id: x.q.id, user_id: x.u, claim, fresh: x.q.fresh ?? false, prio: x.pr });
    }
    return out;
  }
  /** 照 remind_queue_stats：可用账号的 prio 0 项数、批量项数、prio 0 里最老一项从 enqueued_at 起等了几秒 */
  async queueStats(): Promise<QueueStats> {
    this.check('queueStats');
    const now = this.clock();
    const qs = [...this.queue.values()].filter((q) => {
      const u = q.user_id ?? this.tables[q.table_name].get(q.id)?.user_id;
      return !!u && this.usable.get(u) === true;
    });
    const p0 = qs.filter((q) => (q.prio ?? 0) === 0);
    const oldest = p0.length ? Math.min(...p0.map((q) => q.enqueued_at ?? 0)) : now;
    return { queue_wait0: p0.length, queue_wait_batch: qs.length - p0.length, queue_oldest_s: Math.max(0, Math.floor((now - oldest) / 1000)) };
  }
  /** remind_queue_finish（迁移 20261113120000）：release 里还是这个租约的放回（清租约、attempts − 1）；hold 里的不放回也不删（租约、attempts 原样，
   *  等过期重取）；这个租约的、两份名单里都没有的删掉（锁着没放回的 release 项也不删，留着租约走重试）；锁着的（locked）都跳过、租约留着 */
  async finishQueue(claim: string, release: readonly QueueRef[], hold: readonly QueueRef[] = []) {
    this.check('finishQueue');
    const keep = new Set([...release, ...hold].map((r) => `${r.table_name}:${r.id}`));
    for (const r of release) {
      const k = `${r.table_name}:${r.id}`;
      const q = this.queue.get(k);
      if (q && q.claim === claim && !this.locked.has(k)) this.queue.set(k, { ...q, claim: null, claimed_at: null, attempts: Math.max((q.attempts ?? 0) - 1, 0) });
    }
    for (const [k, q] of this.queue) if (q.claim === claim && !this.locked.has(k) && !keep.has(k)) this.queue.delete(k);
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
  async writeRemind(table: Table, id: string, user: string, patch: { remind_at: number | null; next_date?: string | null }, prev: number | null, prevNotified?: number) {
    this.check('writeRemind');
    const r = this.tables[table].get(id);
    if (!r || r.user_id !== user || r.remind_at !== prev) return false;   // 乐观条件
    if (prevNotified !== undefined && r.notified_for !== prevNotified) return false;   // S1 例外另比 notified_for（安全审查 A4）
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
