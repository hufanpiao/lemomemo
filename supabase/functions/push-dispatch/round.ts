// push-dispatch 一轮的处理（架构 5.3 第 0～8 步、“push-dispatch 的超时、预算和不重复”、6.1；B2 任务单 BE-2；架构审 D3、D6、D7；
// B2 安全审查“留给 BE-2 的条件”、六之四补的 Topic 条件；代码审查 BE-1 S10、R1）。
// 数据库、共享 logic、发送都由调用方注入（core.ts 的 handle、index.ts 接线），Vitest 直接测这一份。不 import npm 包、不碰 Deno 全局。
//
// 第 0 步（原 tz-recalc，D6）：private.remind_queue_pop 出队即删（≤ QUEUE_POP_LIMIT；孤儿在函数里删，账号不可用的不出队，见迁移
//   20261103130000）→ 按行重算 remind_at：待办用 profiles.current_tz，有时间的日程用它自己的 tz；**一律传这一行现在的 remind_at 作
//   prevRemindAt**（代码审查 BE-1 R1：漏传就退回“回落”，按过“稍后”后重算会吞掉这次提醒）；纪念日交 anniv 钩子（B5 填实现）。
//   时区不认识的那一行跳过、记 logs tz_invalid（code 只写表名，不写时区串和标题；每人每小时最多一条），不影响同批（D7）。
//   写回带乐观条件（remind_at 还是读到的值）；写回失败、没更新到、时间预算到了没处理的插回队列；profiles 里没有这个人的丢弃（记原因码）。
//   出队即删：插回之前进程崩溃，这一项就丢了，要等这一行下次被改才再入队（风险和兜底写在架构 5.3 第 0 步、接手清单）。
// 第 1 步：due_at = greatest(remind_at, snooze_at, defer_until)，now − 60 分钟 < due_at ≤ now + 60 秒，deleted_at 为空、undone 为假、
//   待办 done 为假，coalesce(pushed_for, 0) ≠ due_at、coalesce(notified_for, 0) ≠ remind_at（remind_at 为空的按 SQL 语义不算到点）；
//   以上在 SQL 里精确判（private.remind_due，迁移 20261103140000），只回可用账号的，每人最多 PER_USER_PER_MINUTE 条（按 due_at 先后），
//   全轮最多 DUE_LIMIT 条；回来再用 isDue、filterUsable 判一遍。
// 第 2 步：免打扰按 current_tz（设置 remind.dnd）：落在里面的写 defer_until = 免打扰结束，这一轮跳过。current_tz 不认识时，有时刻的
//   日程改用它自己的 tz 照常推，待办、纪念日、全天日程这一轮跳过（R-316），都记 tz_invalid。
// 第 3 步：先认领再发——条件更新 pushed_for = due_at（pushed_for is distinct from due_at），更新到 1 行才发；认领、发送、写回各是独立的
//   语句，不在事务里等外部调用，不加全局锁。**最多一次**：认领后发出前出错，这一条不再推（pushed_for 已经等于 due_at），App 的“错过的提醒”兜底。
// 第 4 步：文案 notify-text → t(key, params, ui_locale)；写不写标题看 push_show_title ?? remind.show_title ?? true；source = chat 加“来自 Claude ·”。
// 第 5 步：发给这个人所有设备（devices 里 deleted_at 为空、有订阅的），只经 _shared/push/send.ts 的 deliver：
//   ok → last_push_ok_at、push_fail_count 归 0；gone（404、410）→ 删订阅（三列置空）；bad_endpoint、bad_keys → 三列置空、记 push_bad_endpoint；
//   vapid_rejected（401、403）和其余失败 → 只加 push_fail_count、不删订阅。一台设备这一轮被删了订阅，后面的条目不再发给它。
//   **不发 Topic 头**（安全审查六之四补：Topic 是明文，不能用条目 id 或 tag；每次提醒的 tag 都不同，用不上合并，所以干脆不带）。
// 第 5 步之二：Edge 的 resolve——上一次推过（pushed_for 在 60 分钟窗口内）、之后在别处处理了（notified_for = remind_at；按了“稍后”、
//   改了时间或关了提醒，due_at 已不等于 pushed_for；R-317：待办完成、条目删除或撤销）的（private.remind_pushed 精确判），条件更新 pushed_for = null（只有一轮拿得到），再给这个人**端点主机不属于 *.push.apple.com** 的设备发
//   resolve（按 checkEndpoint 的 apple 判断，不看 devices.platform，0.49 第 1 条）。排在提醒之后、同样受预算和条数上限约束。
// 第 6 步：纪念日推过以后由 anniv 钩子算下一次（B5 填实现；钩子回 null 就不写）。
// 第 7 步：logs（push_ok、push_failed、push_bad_endpoint、tz_invalid），只写原因码、表名、条目和设备 id，**不写标题、地址、响应内容**。
// 第 8 步：心跳 detail 记 claimed、sent、failed、budget_hit（按条目计：一条认领了、至少一台设备 ok 算 sent，一台都没成算 failed；
//   claimed − sent − failed 就是认领后没发出去的，lemo-ops 照 6.1 判断）。
// 时间预算：一轮最长 limits.budgetMs 墙钟，到点不再认领新条目（第 0 步也不再处理新行），已认领的发完；发送并发 limits.concurrency；
//   每轮发送（deliver 调用）最多 limits.sendLimit 次；预算或条数到了 budget_hit 为真，left 是没来得及认领的到点条目数（上界，见第 2 步）。

import { checkEndpoint } from '../_shared/push/endpoint.ts';
import type { PayloadInput, PayloadKind } from '../_shared/push/payload.ts';
import type { DeliverResult, Device, PushOptions } from '../_shared/push/send.ts';

export type Table = 'events' | 'todos' | 'anniversaries';
export const TABLES: readonly Table[] = ['events', 'todos', 'anniversaries'];
/** 表名 → 负载里的 kind（写成 switch：check_backend F7 不许用变量做方括号键） */
export function kindOf(table: Table): PayloadKind {
  switch (table) {
    case 'events': return 'event';
    case 'todos': return 'todo';
    default: return 'anniv';
  }
}

export const MIN_MS = 60_000;
/** 通知按钮“推迟”的分钟数（R-307：一律 10 分钟）：和 shared/logic/notify-text.ts 的 SNOOZE_MIN 一致（tests/edge/push-dispatch-round.test.ts 核对两边相等） */
export const SNOOZE_MIN = 10;
/** 到点窗口：due_at ≤ now + 60 秒、> now − 60 分钟（5.3 第 1 步） */
export const AHEAD_MS = 60_000;
export const BEHIND_MS = 60 * MIN_MS;
/** logs.src（≤ 16 字） */
export const LOG_SRC = 'push-dispatch';
/** 本轮要读的设置键 */
export const SETTING_KEYS = ['remind.dnd', 'remind.show_title', 'anniv.default_offsets', 'anniv.default_time'] as const;

export interface QueueItem { table_name: Table; id: string; user_id: string }
export interface QueueRef { table_name: Table; id: string }

/** 三张表读出来的一行（只取用得到的列；没有的列不在） */
export interface ItemRow {
  id: string;
  user_id: string;
  deleted_at: number | null;
  undone?: boolean;
  source?: string;
  push_show_title?: boolean | null;
  remind_at: number | null;
  notified_for: number | null;
  snooze_at: number | null;
  pushed_for: number | null;
  defer_until: number | null;
  // events
  title?: string;
  date?: string;
  time?: string | null;
  tz?: string | null;
  remind_min?: number | null;
  remind_days?: number | null;
  // todos
  done?: boolean;
  due?: string | null;
  due_time?: string | null;
  remind_before_min?: number | null;
  remind_time?: string | null;
  // anniversaries
  name?: string;
  next_date?: string | null;
  [k: string]: unknown;
}

export interface Profile { current_tz: string; ui_locale: string }
export type UserSettings = Readonly<Record<string, unknown>>;

export interface DeviceRow extends Device {
  id: string;
  user_id: string;
  push_fail_count: number;
}

export type LogRow = {
  user_id: string;
  t: number;
  device: string | null;
  kind: 'run';
  act: 'push_ok' | 'push_failed' | 'push_bad_endpoint' | 'tz_invalid';
  src: string;
  coll: string | null;
  item_id: string | null;
  code: string;
  fields?: string[];
};

/** 一台设备本轮的结果，轮末写一次 */
export type DeviceOutcome = { ok: boolean; fails: number; drop: boolean };

export interface RoundStore {
  /** private.remind_queue_pop(limit) */
  popQueue(limit: number): Promise<QueueItem[]>;
  /** 插回队列（on conflict do nothing） */
  requeue(items: readonly QueueRef[]): Promise<void>;
  /** 第 0 步按 id 读行（只读这个人的：user_id 一并核对） */
  rows(table: Table, ids: readonly string[]): Promise<ItemRow[]>;
  profiles(userIds: readonly string[]): Promise<Map<string, Profile>>;
  /** 只读 SETTING_KEYS、没软删的 */
  settings(userIds: readonly string[]): Promise<Map<string, UserSettings>>;
  /**
   * 系统写入（不加 rev）：remind_at，纪念日另有 next_date。乐观条件（代码审查建议 ④）：只在 remind_at 还是 prevRemindAt 时写
   * （null 用 is null）；回是否更新到 1 行。没更新到 = 读完以后行被改了（用户又改了一次，触发器已重新入队），调用方插回队列
   */
  writeRemind(table: Table, id: string, userId: string, patch: { remind_at: number | null; next_date?: string | null }, prevRemindAt: number | null): Promise<boolean>;
  /**
   * 第 1 步：private.remind_due(lo, hi, perUser, limit)——三张表合起来在 SQL 里按 isDue 的条件精确判断（安全审查必改 1、代码审查 M2：
   * 粗筛按 remind_at 取前 500 会被“remind_at 很早、snooze_at 很远”的行或推过的行占满），只回可用账号的，每人最多 perUser 条，
   * 按 (due_at, table, id) 排序、总数 ≤ limit；再按 id 读整行。这里再用 isDue 判一遍（两边写法对拍）
   */
  dueRows(lo: number, hi: number, perUser: number, limit: number): Promise<{ table: Table; row: ItemRow }[]>;
  /** resolve 候选：private.remind_pushed(lo, hi, perUser, limit)，条件同 isHandledAfterPush，每人最多 perUser 条、总数 ≤ limit */
  pushedRows(lo: number, hi: number, perUser: number, limit: number): Promise<{ table: Table; row: ItemRow }[]>;
  setDeferUntil(table: Table, id: string, userId: string, until: number): Promise<void>;
  /** update … set pushed_for = dueAt where id、user_id 对上 and pushed_for is distinct from dueAt；回是否更新到 1 行 */
  claim(table: Table, id: string, userId: string, dueAt: number): Promise<boolean>;
  /** update … set pushed_for = null where id、user_id 对上 and pushed_for = pushedFor；回是否更新到 1 行 */
  releasePushed(table: Table, id: string, userId: string, pushedFor: number): Promise<boolean>;
  /** 这些人没软删、有订阅的设备 */
  devices(userIds: readonly string[]): Promise<DeviceRow[]>;
  /** 轮末每台设备写一次（只在 push_endpoint 还是发送时那一串时才写，免得冲掉刚认领的新订阅） */
  deviceOutcome(dev: DeviceRow, r: DeviceOutcome, nowIso: string): Promise<void>;
  insertLogs(rows: readonly LogRow[]): Promise<void>;
  /** 这些人里 since 之后已经记过 tz_invalid 的（代码审查建议 ⑥：每人每小时最多记一次） */
  tzLoggedSince(userIds: readonly string[], since: number): Promise<Set<string>>;
}

/** 共享 logic（shared/logic/remind.ts、notify-text.ts、core/tz.ts、i18n）由 index.ts 注入；结构类型照抄签名 */
export interface NotifyMsgLike { key: string | null; params: Readonly<Record<string, string | number>> }
export interface NotifyTextLike { title: NotifyMsgLike; fromClaude: boolean; body: NotifyMsgLike | null }
export interface NotifyInputLike {
  kind: PayloadKind; title: string; source: string; showTitle: boolean; timeMs: number; dueTime: string | null; tz: string;
}
export type Dnd = { start: string; end: string } | null;
export interface AnnivCtx { tz: string; now: number; settings: UserSettings }
export interface AnnivNext { remind_at: number | null; next_date: string | null }

export interface RoundLogic {
  remindAtOf(kind: 'todo' | 'event', row: ItemRow, tz: string, now: number, prevRemindAt: number | null): number | null;
  isValidTz(tz: string): boolean;
  dndDeferUntil(ms: number, tz: string, dnd: Dnd): number | null;
  /** 日程开始时刻（固定时刻，按日程自己的 tz）；全天日程回 null */
  eventStartAt(row: ItemRow): number | null;
  notify(i: NotifyInputLike): NotifyTextLike;
  t(key: string, params: Readonly<Record<string, string | number>>, locale: string): string;
  /**
   * 纪念日下一次提醒（架构 5.4；架构审第四节第 4 点：按 logic/anniv 的函数签名留好接口，B5 只填实现、不改流程）。
   * 第 0 步按 ctx.now = 现在调；第 6 步推过以后按 ctx.now = 这次 due_at + 1 调，取再下一次。回 null = 还没实现 / 不改
   */
  annivNext(row: ItemRow, ctx: AnnivCtx): AnnivNext | null;
}

export interface Limits {
  budgetMs: number;
  concurrency: number;
  sendLimit: number;
  perUser: number;
  queuePop: number;
  due: number;
}

export interface RoundCtx {
  store: RoundStore;
  logic: RoundLogic;
  limits: Limits;
  now: () => number;
  /** 一轮开始的时刻（handle 验完鉴权和配置之后） */
  t0: number;
  isUsable: (userId: string) => Promise<boolean>;
  /** 组装负载（_shared/push/payload.ts 的 buildPayload）；不合格抛错 */
  buildPayload: (p: PayloadInput) => Uint8Array<ArrayBuffer>;
  /** 给一台设备发一条（_shared/push/send.ts 的 deliver，签名器、fetch、替身已绑好） */
  deliver: (dev: Device, payload: Uint8Array<ArrayBuffer>, opt: PushOptions) => Promise<DeliverResult>;
  log: (code: string) => void;
}

export interface RoundResult { claimed: number; sent: number; failed: number; budget_hit: boolean; left: number }

// ---------------- 小工具 ----------------

/** due_at = greatest(remind_at, snooze_at, defer_until)（PG 的 greatest 不看 null；三个都空回 null） */
export function dueAtOf(r: Pick<ItemRow, 'remind_at' | 'snooze_at' | 'defer_until'>): number | null {
  let m: number | null = null;
  for (const v of [r.remind_at, r.snooze_at, r.defer_until]) if (typeof v === 'number' && (m === null || v > m)) m = v;
  return m;
}

/** 第 1 步的精确条件（SQL 语义：remind_at 为空时 coalesce(notified_for, 0) <> remind_at 是 null，不算到点） */
export function isDue(table: Table, r: ItemRow, now: number): number | null {
  if (r.deleted_at !== null || r.undone === true || (table === 'todos' && r.done === true) || r.remind_at === null) return null;
  const due = dueAtOf(r);
  if (due === null || due > now + AHEAD_MS || due <= now - BEHIND_MS) return null;
  if ((r.pushed_for ?? 0) === due || (r.notified_for ?? 0) === r.remind_at) return null;
  return due;
}

/**
 * resolve 的条件：推过（pushed_for 不空），之后在别处处理了（和 private.remind_pushed 逐条一致）——
 * 按了“知道了”（notified_for = remind_at）；提醒时间改了、按了“稍后”、提醒关了（due_at 不等于 pushed_for，或三列都空）；
 * R-317：待办完成（done）、条目删除（deleted_at 不空）或撤销（undone）也收回旧通知
 */
export function isHandledAfterPush(table: Table, r: ItemRow): boolean {
  if (r.pushed_for === null) return false;
  if (r.deleted_at !== null || r.undone === true || (table === 'todos' && r.done === true)) return true;
  if (r.remind_at !== null && r.notified_for === r.remind_at) return true;
  const due = dueAtOf(r);
  return due === null || due !== r.pushed_for;
}

/** 设置 remind.dnd：{start: 'HH:MM', end: 'HH:MM'}（可带 enabled: false 表示关）；认不出的按没开 */
export function parseDnd(v: unknown): Dnd {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o['enabled'] === false) return null;
  const hm = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const s = o['start'], e = o['end'];
  return typeof s === 'string' && typeof e === 'string' && hm.test(s) && hm.test(e) && s !== e ? { start: s, end: e } : null;
}

/** 写不写标题：条目 push_show_title ?? 设置 remind.show_title ?? true */
export function showTitleOf(row: ItemRow, s: UserSettings | undefined): boolean {
  if (typeof row.push_show_title === 'boolean') return row.push_show_title;
  const v = s?.['remind.show_title'];
  return typeof v === 'boolean' ? v : true;
}

export function renderText(n: NotifyTextLike, t: RoundLogic['t'], locale: string): { title: string; body: string | null } {
  const one = (m: NotifyMsgLike): string => (m.key === null ? String(m.params['text'] ?? '') : t(m.key, m.params, locale));
  const raw = one(n.title);
  return { title: n.fromClaude ? t('remind.push.fromClaude', { text: raw }, locale) : raw, body: n.body ? one(n.body) : null };
}

/** 最多 n 个并发跑完 items（顺序领取；fn 自己吞错） */
export async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const it = items.values();   // 几个 worker 共用一个迭代器，各取下一项
  const worker = async () => {
    for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const a = m.get(k);
    if (a) a.push(x);
    else m.set(k, [x]);
  }
  return m;
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

// ---------------- 一轮 ----------------

export async function runRound(c: RoundCtx): Promise<RoundResult> {
  const logs: LogRow[] = [];
  const res: RoundResult = { claimed: 0, sent: 0, failed: 0, budget_hit: false, left: 0 };
  const overBudget = () => c.now() - c.t0 >= c.limits.budgetMs;

  await step0(c, logs, overBudget);
  await steps1to8(c, logs, res, overBudget);

  if (logs.length) {
    for (let i = 0; i < logs.length; i += 200) await insertLogsSplit(c, logs.slice(i, i + 200));
  }
  return res;
}

/** 批插失败时拆成 20 条一批重试（代码审查建议 ⑥：一行不合格不连累同批 199 行）；20 条的小批再失败才记 logs_failed */
async function insertLogsSplit(c: RoundCtx, batch: readonly LogRow[]): Promise<void> {
  try {
    await c.store.insertLogs(batch);
    return;
  } catch {
    if (batch.length <= 20) {
      c.log('logs_failed');
      return;
    }
  }
  for (let i = 0; i < batch.length; i += 20) {
    try {
      await c.store.insertLogs(batch.slice(i, i + 20));
    } catch {
      c.log('logs_failed');
    }
  }
}

/**
 * 记 tz_invalid：每人一轮一条，并且每人每小时最多一条（代码审查建议 ⑥；查最近一小时有没有记过，查不了就这轮不记——宁可少记，
 * 不让坏时区的人每分钟写一条日志）。code 只写表名或 profiles 一类的原因，不写时区串和标题
 */
async function logTzInvalid(c: RoundCtx, logs: LogRow[], notes: ReadonlyMap<string, string>, now: number): Promise<void> {
  if (notes.size === 0) return;
  let seen: Set<string>;
  try {
    seen = await c.store.tzLoggedSince([...notes.keys()], now - 3_600_000);
  } catch {
    c.log('tz_log_check_failed');
    return;
  }
  for (const [u, code] of notes) {
    if (!seen.has(u)) logs.push({ user_id: u, t: now, device: null, kind: 'run', act: 'tz_invalid', src: LOG_SRC, coll: null, item_id: null, code });
  }
}

// ---------------- 第 0 步：出队即删、重算 remind_at ----------------

async function step0(c: RoundCtx, logs: LogRow[], overBudget: () => boolean): Promise<void> {
  if (overBudget()) return;
  let items: QueueItem[];
  try {
    items = await c.store.popQueue(c.limits.queuePop);
  } catch {
    c.log('queue_pop_failed');
    return;
  }
  if (items.length === 0) return;
  const requeue = async (xs: readonly QueueRef[]) => {
    if (!xs.length) return;
    try {
      await c.store.requeue(xs.map((x) => ({ table_name: x.table_name, id: x.id })));
    } catch {
      c.log('requeue_failed');
    }
  };

  const users = uniq(items.map((x) => x.user_id));
  let profiles: Map<string, Profile>;
  let settings: Map<string, UserSettings>;
  const rows = new Map<string, ItemRow>();
  try {
    [profiles, settings] = await Promise.all([c.store.profiles(users), c.store.settings(users)]);
    for (const [table, xs] of groupBy(items, (x) => x.table_name)) {
      for (let i = 0; i < xs.length; i += 100) {
        for (const r of await c.store.rows(table, xs.slice(i, i + 100).map((x) => x.id))) rows.set(`${table}:${r.id}`, r);
      }
    }
  } catch {
    c.log('recalc_read_failed');
    await requeue(items);
    return;
  }

  const back: QueueRef[] = [];
  const tzNotes = new Map<string, string>();
  const now = c.now();
  await pool(items, c.limits.concurrency, async (q) => {
    if (overBudget()) {
      back.push(q);
      return;
    }
    const row = rows.get(`${q.table_name}:${q.id}`);
    if (!row || row.user_id !== q.user_id) return;   // 读的时候已经没了（孤儿下一轮由出队函数删；这里不必插回）
    const prof = profiles.get(q.user_id);
    if (!prof) {
      // 安全审查建议 ③：profiles 里没有这个人（注销清理到一半等）。出队函数已判过 account_usable，这里不插回（插回只会每分钟再来一次），
      // 丢弃、记原因码；以后这个人的行再被改，触发器会重新入队
      c.log('recalc_no_profile');
      return;
    }
    const tzInvalid = () => {
      if (!tzNotes.has(q.user_id)) tzNotes.set(q.user_id, q.table_name);
    };
    let patch: { remind_at: number | null; next_date?: string | null } | null;
    try {
      if (q.table_name === 'events') {
        if (row.time !== null && row.time !== undefined && (typeof row.tz !== 'string' || !c.logic.isValidTz(row.tz))) {
          tzInvalid();
          return;
        }
        // 日程是固定时刻，不用 current_tz；prevRemindAt 照样传（R1：每个调用点都传这一行现在的 remind_at）
        patch = { remind_at: c.logic.remindAtOf('event', row, prof.current_tz, now, row.remind_at) };
      } else if (!c.logic.isValidTz(prof.current_tz)) {
        tzInvalid();
        return;
      } else if (q.table_name === 'todos') {
        patch = { remind_at: c.logic.remindAtOf('todo', row, prof.current_tz, now, row.remind_at) };
      } else {
        const nx = c.logic.annivNext(row, { tz: prof.current_tz, now, settings: settings.get(q.user_id) ?? {} });
        patch = nx ? { remind_at: nx.remind_at, next_date: nx.next_date } : null;
      }
    } catch {
      c.log(`recalc_failed:${q.table_name}`);   // 行里的值不合格（例如时刻串坏了）：跳过这一行，不插回（插回只会每分钟再错一次）
      return;
    }
    if (patch === null) return;
    const same = patch.remind_at === row.remind_at && (patch.next_date === undefined || patch.next_date === (row.next_date ?? null));
    if (same) return;
    try {
      // 乐观条件（代码审查建议 ④）：读完以后行又被改了就不写，插回队列下一轮按新值重算
      if (!(await c.store.writeRemind(q.table_name, q.id, q.user_id, patch, row.remind_at))) back.push(q);
    } catch {
      back.push(q);
    }
  });
  await requeue(back);
  await logTzInvalid(c, logs, tzNotes, now);
}

// ---------------- 第 1～8 步 ----------------

/** tz：第 2 步定下的显示和免打扰时区（current_tz；R-316 时区坏了的日程用它自己的 tz） */
type Cand = { table: Table; row: ItemRow; due: number; tz?: string };

async function steps1to8(c: RoundCtx, logs: LogRow[], res: RoundResult, overBudget: () => boolean): Promise<void> {
  const now = c.now();
  const lo = now - BEHIND_MS;
  const hi = now + AHEAD_MS;

  // 第 1 步：到点的
  let cands: Cand[] = [];
  try {
    for (const { table, row } of await c.store.dueRows(lo, hi, c.limits.perUser, c.limits.due)) {
      const due = isDue(table, row, now);
      if (due !== null) cands.push({ table, row, due });
    }
  } catch {
    c.log('due_query_failed');
  }
  // resolve 的候选（排在提醒之后）
  let handled: { table: Table; row: ItemRow }[] = [];
  try {
    for (const x of await c.store.pushedRows(lo, now, c.limits.perUser, c.limits.due)) if (isHandledAfterPush(x.table, x.row)) handled.push(x);
  } catch {
    c.log('resolve_query_failed');
  }
  cands.sort((a, b) => a.due - b.due || a.table.localeCompare(b.table) || a.row.id.localeCompare(b.row.id));
  cands = cands.slice(0, c.limits.due);

  const usable = new Set(await filterUsable(uniq([...cands, ...handled].map((x) => x.row.user_id)), c.isUsable, c.log, c.limits.concurrency));
  cands = cands.filter((x) => usable.has(x.row.user_id));
  handled = handled.filter((x) => usable.has(x.row.user_id));
  // 每人每轮最多 perUser 条（按 due_at 先后；多出的留在窗口里，下一分钟再发）
  const perUser = new Map<string, number>();
  cands = cands.filter((x) => {
    const n = perUser.get(x.row.user_id) ?? 0;
    perUser.set(x.row.user_id, n + 1);
    return n < c.limits.perUser;
  });
  if (cands.length === 0 && handled.length === 0) return;

  const users = uniq([...cands, ...handled].map((x) => x.row.user_id));
  let profiles: Map<string, Profile>;
  let settings: Map<string, UserSettings>;
  let devs: Map<string, DeviceRow[]>;
  try {
    const [p, s, d] = await Promise.all([c.store.profiles(users), c.store.settings(users), c.store.devices(users)]);
    profiles = p;
    settings = s;
    devs = groupBy(d, (x) => x.user_id);
  } catch {
    c.log('dispatch_read_failed');
    return;
  }

  // 第 2 步：免打扰。
  //   R-316：current_tz 不认识时，有时刻的日程改用日程自己的 tz 算显示时刻和免打扰，照常推，记 tz_invalid（code 'profiles:event_tz'）；
  //   待办、纪念日、全天日程没有自己的时区，这一轮跳过、留在窗口里（记 tz_invalid，code 'profiles'）。tz_invalid 每人每小时最多一条。
  //   安全审查建议 ①：每个候选单独 try，isValidTz、dndDeferUntil 出错只影响这一条（记 dnd_failed，留在窗口里下一分钟再来）。
  //   代码审查建议 ②：循环里看时间预算，到了就停（没处理的算 left）。
  //   复审建议：这里加进 left 的是上界——剩下的候选里有的本来会因没有 profile、免打扰顺延、时区不认识或没有设备而不发，没逐条判断就全算上。
  const tzNotes = new Map<string, string>();
  const ready: Cand[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (overBudget()) {
      res.budget_hit = true;
      res.left += cands.length - i;
      break;
    }
    const x = cands[i] as Cand;
    const u = x.row.user_id;
    const prof = profiles.get(u);
    if (!prof) continue;
    let until: number | null;
    try {
      if (c.logic.isValidTz(prof.current_tz)) {
        x.tz = prof.current_tz;
      } else if (x.table === 'events' && x.row.time !== null && x.row.time !== undefined && typeof x.row.tz === 'string' && c.logic.isValidTz(x.row.tz)) {
        x.tz = x.row.tz;
        if (!tzNotes.has(u)) tzNotes.set(u, 'profiles:event_tz');
      } else {
        tzNotes.set(u, 'profiles');
        continue;
      }
      until = c.logic.dndDeferUntil(x.due, x.tz, parseDnd(settings.get(u)?.['remind.dnd']));
    } catch {
      c.log('dnd_failed');
      continue;
    }
    if (until !== null && until > x.due) {
      try {
        await c.store.setDeferUntil(x.table, x.row.id, u, until);
      } catch {
        c.log('defer_failed');
      }
      continue;
    }
    if (!(devs.get(u)?.length)) continue;   // 没有能收推送的设备：不认领（不算 claimed，也不算失败）
    ready.push(x);
  }
  await logTzInvalid(c, logs, tzNotes, now);

  // 发送的共享状态
  const stats = new Map<string, { dev: DeviceRow; out: DeviceOutcome }>();
  const statOf = (d: DeviceRow) => {
    let s = stats.get(d.id);
    if (!s) stats.set(d.id, (s = { dev: d, out: { ok: false, fails: 0, drop: false } }));
    return s;
  };
  const alive = (u: string, apple: 'any' | 'no-apple') => (devs.get(u) ?? []).filter((d) => {
    if (stats.get(d.id)?.out.drop) return false;
    if (apple === 'any') return true;
    const ep = checkEndpoint(d.push_endpoint);
    return !ep.ok || !ep.apple;   // 不合格的端点交 deliver 判 bad_endpoint、置空；苹果的一律不发 resolve
  });
  let sends = 0;
  let stopped = false;
  /**
   * 认领前占发送名额；时间或条数到了就停（budget_hit），回 false。
   * 名额只增不退（代码审查建议 ⑩）：发失败、设备中途被判 drop、组负载失败都不退——按“尝试过的设备数”封顶，宁可这一轮少发几条，
   * 也不让坏设备多的人把一轮拖长；唯一退还的是认领没拿到（别的轮已经推了），那时一条都没发
   */
  const reserve = (n: number): boolean => {
    if (stopped) return false;
    if (overBudget() || (sends > 0 && sends + n > c.limits.sendLimit)) {
      stopped = true;
      res.budget_hit = true;
      return false;
    }
    sends += n;
    return true;
  };
  const sendTo = async (x: { table: Table; row: ItemRow }, targets: readonly DeviceRow[], payload: Uint8Array<ArrayBuffer>, opt: PushOptions, resolve: boolean): Promise<boolean> => {
    let anyOk = false;
    // 代码审查建议 ②：同一条目的几台设备并发发，结果按设备顺序记
    const live = targets.filter((d) => !stats.get(d.id)?.out.drop);
    const rs = await Promise.all(live.map(async (d) => [d, await c.deliver(d, payload, opt)] as const));
    for (const [d, r] of rs) {
      const s = statOf(d);
      const base = { user_id: x.row.user_id, t: c.now(), device: d.id, kind: 'run' as const, src: LOG_SRC, coll: x.table, item_id: x.row.id, ...(resolve ? { fields: ['resolve'] } : {}) };
      if (r.outcome === 'ok') {
        anyOk = true;
        s.out.ok = true;
        logs.push({ ...base, act: 'push_ok', code: 'ok' });
      } else if (r.outcome === 'bad_endpoint' || r.outcome === 'bad_keys') {
        s.out.drop = true;
        logs.push({ ...base, act: 'push_bad_endpoint', code: r.outcome === 'bad_endpoint' ? r.reason : 'bad_keys' });
      } else if (r.outcome === 'gone') {
        s.out.drop = true;
        logs.push({ ...base, act: 'push_failed', code: 'gone' });
      } else {
        s.out.fails++;
        logs.push({ ...base, act: 'push_failed', code: r.outcome });
      }
    }
    return anyOk;
  };

  // 第 3～6 步：提醒
  await pool(ready, c.limits.concurrency, async (x) => {
    const u = x.row.user_id;
    const targets = alive(u, 'any');
    if (targets.length === 0) return;
    if (!reserve(targets.length)) {
      res.left++;
      return;
    }
    let mine: boolean;
    try {
      mine = await c.store.claim(x.table, x.row.id, u, x.due);
    } catch {
      mine = false;
      c.log('claim_failed');
    }
    if (!mine) {
      sends -= targets.length;
      return;
    }
    res.claimed++;
    const prof = profiles.get(u) as Profile;
    let payload: Uint8Array<ArrayBuffer>;
    try {
      const kind = kindOf(x.table);
      const timeMs = x.table === 'events' ? (c.logic.eventStartAt(x.row) ?? x.due) : x.due;
      const n = c.logic.notify({
        kind,
        title: String((x.table === 'anniversaries' ? x.row.name : x.row.title) ?? ''),
        source: String(x.row.source ?? ''),
        showTitle: showTitleOf(x.row, settings.get(u)),
        timeMs,
        dueTime: x.table === 'todos' ? (x.row.due_time ?? null) : null,
        tz: x.tz ?? prof.current_tz,
      });
      const text = renderText(n, c.logic.t, prof.ui_locale);
      // R-294、R-307、R-308：通知上两个按钮（action 名 snooze、done、ack，SW 由前端 A 接）
      const snooze = { label: c.logic.t('remind.push.action.snooze', {}, prof.ui_locale), minutes: SNOOZE_MIN };
      // R-308：待办“推迟 + 完成”，日程、纪念日“推迟 + 知道了”（和 shared/logic/notify-text.ts 的 actionsFor 一致，测试核对）
      const second = kind === 'todo'
        ? { done: { label: c.logic.t('remind.push.action.done', {}, prof.ui_locale) } }
        : { ack: { label: c.logic.t('remind.push.action.ack', {}, prof.ui_locale) } };
      payload = c.buildPayload({ type: 'remind', user_id: u, kind, id: x.row.id, due_at: x.due, title: text.title, body: text.body, snooze, ...second });
    } catch (e) {
      // 最多一次：已认领，这一条不再推（App 的“错过的提醒”兜底）；只记原因码
      const code = (e as { code?: unknown })?.code;
      res.failed++;
      logs.push({ user_id: u, t: c.now(), device: null, kind: 'run', act: 'push_failed', src: LOG_SRC, coll: x.table, item_id: x.row.id, code: code === 'bad_payload' || code === 'payload_too_large' ? code : 'build_failed' });
      return;
    }
    const ttl = Math.max(60, Math.floor((x.due + BEHIND_MS - c.now()) / 1000));
    let ok: boolean;
    try {
      ok = await sendTo(x, targets, payload, { ttl, urgency: 'high' }, false);
    } catch {
      c.log('send_crashed');   // 不该发生（deliver 自己吞错）；按“认领后没发出”算，不计 sent、failed
      return;
    }
    if (ok) res.sent++;
    else res.failed++;
    // 第 6 步：纪念日推过以后算下一次（B5 填实现）
    if (x.table === 'anniversaries') {
      try {
        const nx = c.logic.annivNext(x.row, { tz: prof.current_tz, now: x.due + 1, settings: settings.get(u) ?? {} });
        // 乐观条件：推完以后用户又改了这条纪念日（触发器已入队，第 0 步会按新值重算），就不覆盖
        if (nx && !(await c.store.writeRemind(x.table, x.row.id, u, { remind_at: nx.remind_at, next_date: nx.next_date }, x.row.remind_at))) c.log('anniv_next_stale');
      } catch {
        c.log('anniv_next_failed');
      }
    }
  });

  // 第 5 步之二：resolve（Edge 等；苹果端点一律不发）
  await pool(handled, c.limits.concurrency, async (x) => {
    const u = x.row.user_id;
    const pushedFor = x.row.pushed_for as number;
    const targets = alive(u, 'no-apple');
    if (!reserve(targets.length)) return;
    let mine: boolean;
    try {
      mine = await c.store.releasePushed(x.table, x.row.id, u, pushedFor);
    } catch {
      mine = false;
      c.log('release_failed');
    }
    if (!mine || targets.length === 0) {
      sends -= targets.length;
      return;
    }
    let payload: Uint8Array<ArrayBuffer>;
    try {
      payload = c.buildPayload({ type: 'resolve', user_id: u, kind: kindOf(x.table), id: x.row.id, due_at: pushedFor });
    } catch {
      return;
    }
    try {
      await sendTo(x, targets, payload, { ttl: 3600, urgency: 'normal' }, true);
    } catch {
      c.log('send_crashed');
    }
  });

  // 轮末：每台设备写一次
  const nowIso = new Date(c.now()).toISOString();
  for (const { dev, out } of stats.values()) {
    try {
      await c.store.deviceOutcome(dev, out, nowIso);
    } catch {
      c.log('device_write_failed');
    }
  }
}

/**
 * 只留可用账号（0.29 续第 138 条④、0.42 第 1 条：停用和冷静期的都不发、不出队）。查询出错的那个人这一轮跳过（不当成可用），
 * 不影响别人；按传入顺序返回、去重
 */
export async function filterUsable(userIds: readonly string[], isUsable: (u: string) => Promise<boolean>, log?: (c: string) => void, n = 8): Promise<string[]> {
  // 代码审查建议 ③：最多 n 个并发查（原来逐个 await，几百人时整轮卡在这里）
  const us = [...new Set(userIds)];
  const ok = new Set<string>();
  await pool(us, n, async (u) => {
    try {
      if (await isUsable(u)) ok.add(u);
    } catch {
      log?.('usable_check_failed');
    }
  });
  return us.filter((u) => ok.has(u));
}
