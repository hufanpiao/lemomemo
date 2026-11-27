// push-dispatch 一轮用的类型、常量和 kindOf；流程总说明在 round.ts 文件头。
import { ANNIV_KEY_OFFSETS, ANNIV_KEY_TIME } from '../_shared/anniv-keys.ts';
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
/**
 * store 的数据库请求超时（_shared/net.ts 的 timedFetch 到点中止）时抛的错误文字；别的数据库错误抛 'db'。
 * 各处收尾照旧，只是原因码记成 `<码>:timeout`（round-util.ts 的 failCode，方案 3.6）
 */
export const DB_TIMEOUT = 'db:timeout';
/**
 * 这一行本身写不进去（PostgREST 回的 SQLSTATE 是 22 类数据异常、23 类违反约束）时 store 抛的错误文字：重试也一样写不进去。
 * 第 0 步写回遇到它记 held：finish 的放回、删除两份名单都不列这一项，租约留着到期由别的轮重取，每取一次计一次有毒次数
 * （迁移 20261113160000 的 remind_queue_finish）；超时、连不上、5xx、认不出的照旧放回。原因码记 `<码>:data`
 */
export const DB_DATA = 'db:data';
/**
 * PostgREST 回 PGRST202（按这组参数名找不到函数）时 store 抛的错误文字：多半是新版函数部署到了还没 db push 的旧库
 * （例如 remind_queue_finish 少了 p_done）。收尾照旧，原因码记 `<码>:nofn`，查日志一眼能和别的数据库错误分开（上线手册“先 db push 后部署函数”）
 */
export const DB_NOFN = 'db:nofn';
/** logs.src（≤ 16 字） */
export const LOG_SRC = 'push-dispatch';
/** 本轮要读的设置键 */
// remind.default_time：全天日程当天提醒的时刻、全天日程的“开始”（架构 0.29 续第 47、57 条；没设、认不出按 09:00，shared/logic/remind.ts 的 allDayTimeOf）
export const SETTING_KEYS = ['remind.dnd', 'remind.show_title', ANNIV_KEY_OFFSETS, ANNIV_KEY_TIME, 'remind.default_time'] as const;

/**
 * remind_queue_pop 返回的一项（迁移 20261113100000）。claim 是这一批的租约号（同一批相同；重试模式一批只有 1 项）；为空表示有毒项
 * （取满 limits.queuePoison 次都没处理完，函数已删掉），只记 queue_poison。user_id 取自队列项（行可能已被硬删：孤儿照常出队、读不到行就删）。
 * fresh：待办新建或改了截止日期、截止时刻、提前量（第 0 步不传 prevRemindAt，提前量已过时回落到截止时刻，R-411 Q2）。
 * prio：0 用户自己改的，1 批量里 24 小时内到点或还没算的，2 其余批量（logs 只记 prio 0 的重算，方案 3.7）
 */
export interface QueueItem { table_name: Table; id: string; user_id: string; claim: string | null; fresh: boolean; prio: number }
export interface QueueRef { table_name: Table; id: string }

/** 三张表读出来的一行（只取用得到的列；没有的列不在） */
export interface ItemRow {
  id: string;
  user_id: string;
  /** touch() 维护的版本号：系统写入（table_meta.system_cols）不加，用户改了别的列才加；写回的乐观条件比它 */
  rev: number;
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
  // recalc：第 0 步 prio 0 那几项的重算结果（code = written / ack / r336 / failed / held，被丢掉的有毒项 code = poison，方案 3.7）；
  // claim_timeout：认领请求超时，库里可能已认领，这一条不发（R-411 Q4，code = claim_timeout）
  act: 'push_ok' | 'push_failed' | 'push_bad_endpoint' | 'tz_invalid' | 'recalc' | 'claim_timeout';
  src: string;
  coll: string | null;
  item_id: string | null;
  code: string;
  fields?: string[];
};

/** 一台设备本轮的结果，轮末写一次 */
export type DeviceOutcome = { ok: boolean; fails: number; drop: boolean };

export interface RoundStore {
  /** private.remind_queue_pop：打租约出队（迁移 20261113100000）。retry = true 只取取过的项、一次 1 项；false 只取新项（attempts = 0）、按批。
   *  perUser 每人上限、poison 有毒次数、ver 规则版本（只交出 min_ver ≤ ver 的项）都显式传，不靠 SQL 的默认值 */
  popQueue(limit: number, leaseS: number, retry: boolean, perUser: number, poison: number, ver: number): Promise<QueueItem[]>;
  /** private.remind_queue_finish(claim, release, done)（迁移 20261113160000）：release 里的放回（清租约、attempts 减 1）；done 里的删掉；
   *  两份都没列的（写回遇到数据类错误的项）留着租约和 attempts、等过期重取，计入有毒次数 */
  finishQueue(claim: string, release: readonly QueueRef[], done: readonly QueueRef[]): Promise<void>;
  /** 第 0 步按 id 读行（只按 id 读；行的主人和队列项对不对，在 round-step0.ts 里比 user_id） */
  rows(table: Table, ids: readonly string[]): Promise<ItemRow[]>;
  profiles(userIds: readonly string[]): Promise<Map<string, Profile>>;
  /** 只读 SETTING_KEYS、没软删、没撤销的（11-04 起撤销了的按没设处理） */
  settings(userIds: readonly string[]): Promise<Map<string, UserSettings>>;
  /**
   * 系统写入（不加 rev）：remind_at，纪念日另有 next_date。乐观条件：rev 还等于 prev.rev、remind_at 还等于 prev.remind_at（null 用 is null）
   * 才写；回是否更新到 1 行。remind_at 是系统列，用户改日期、改提前量、按“知道了”（notified_for）都不动它，只会加 rev——
   * 所以“读完以后用户又改了”靠 rev 判（R-411 整块评审必改 1）；remind_at 条件挡的是别的系统写入抢先写过。
   * 没更新到 = 读完以后行被改了（用户改的话触发器已重新入队），调用方放回队列、这一轮不推
   */
  writeRemind(table: Table, id: string, userId: string, patch: RemindPatch, prev: { remind_at: number | null; rev: number }): Promise<boolean>;
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
  /** 全天日程才传（R-333）：date 是日程日期，at 是这一次提醒的时刻（due_at），notify-text 按 tz 比是“今天”还是“明天” */
  allDay?: { date: string; at: number } | null;
}
export type Dnd = { start: string; end: string } | null;
export interface AnnivCtx { tz: string; now: number; settings: UserSettings }
/** past：已过去的倒数日（shared annivState 的 past，按 current_tz） */
export interface AnnivNext { remind_at: number | null; next_date: string | null; past: boolean }
/** 第 0 步、第 6 步写回的列：纪念日另有 next_date；archived_at 只会写成 null（已归档的倒数日改到以后，整块评审第 17 条） */
export interface RemindPatch { remind_at: number | null; next_date?: string | null; archived_at?: null }

export interface RoundLogic {
  /** shared/logic/remind.ts 的 REMIND_RULES_VER：出队传给 p_ver（规则改了迁移里全量入队、min_ver 记新版本，旧版函数拿不到） */
  rulesVer: number;
  /** defaultTime：设置 remind.default_time 的值（只有全天日程当天提醒用，原样交给 shared；待办忽略） */
  // prevRemindAt：undefined 只给 fresh 的待办（回落到截止时刻）；其余一律传这一行现在的 remind_at（可以是 null）
  remindAtOf(kind: 'todo' | 'event', row: ItemRow, tz: string, now: number, prevRemindAt: number | null | undefined, defaultTime?: unknown): number | null;
  isValidTz(tz: string): boolean;
  dndDeferUntil(ms: number, tz: string, dnd: Dnd): number | null;
  /**
   * 日程开始时刻（shared/logic/remind-actions.ts 的 startAtOf 口径）：有时刻的按日程自己的 tz（缺 tz 回 null）；
   * 全天日程（time 为空）是当天的 remind.default_time，按 tz（current_tz）算（0.29 续第 47、57 条）
   */
  eventStartAt(row: ItemRow, tz: string, defaultTime: unknown): number | null;
  /** at 是数字、且按 tz 和 remindAt 落在同一天（shared/logic/remind.ts 的 sameRemindDay，前端同一份）；第 0 步判断全天日程“这一天推过没有”用（R-336） */
  sameRemindDay(at: unknown, remindAt: number, tz: string): boolean;
  notify(i: NotifyInputLike): NotifyTextLike;
  t(key: string, params: Readonly<Record<string, string | number>>, locale: string): string;
  /**
   * 纪念日下一次提醒（架构 5.4；架构审第四节第 4 点：按 logic/anniv 的函数签名留好接口，B5 只填实现、不改流程）。
   * 第 0 步按 ctx.now = 现在调；第 6 步推过以后按 ctx.now = 这次 due_at + 1 调，取再下一次。回 null = 还没实现 / 不改
   */
  annivNext(row: ItemRow, ctx: AnnivCtx): AnnivNext | null;
  /**
   * “同一次提醒”的标识（REMIND-close-occkey：shared/logic/remind-route.ts 的 occurrenceKey，和前端横幅、本机通知同一份），放进推送负载。
   * due 是这一次的 due_at（tag 里那个）；按了“稍后”的那一次照 tag。
   * at = 'push'（推送时）：snooze_at = due、≠ remind_at 算稍后那一次（和前端 reminderOf 同一口径）；
   * at = 'resolve'（撤回时，due = pushed_for）：按当初推的那一次判断，pushed_for 既不等于 remind_at、也不等于 defer_until 就是稍后那一次，
   *   不看现在的 snooze_at（代码审查 occurrenceKey M1：推了稍后那一次以后再按稍后，snooze_at 已经变了；L1：R-336 保留了旧 remind_at 以后再按稍后）
   */
  occurrenceKey(kind: PayloadKind, row: ItemRow, due: number, at: 'push' | 'resolve'): string;
}

export interface Limits {
  budgetMs: number;
  concurrency: number;
  sendLimit: number;
  perUser: number;
  queuePop: number;
  /** 第 0 步新项按批出队每人最多几项（QUEUE_PER_USER） */
  queuePerUser: number;
  /** 取过几次还没处理完就当有毒项丢掉（QUEUE_POISON） */
  queuePoison: number;
  /** 第 0 步的租约秒数（QUEUE_LEASE_S） */
  queueLeaseS: number;
  /** 第 0 步一轮最多做几次单项重试（QUEUE_RETRY_POPS；重试一次只交出 1 项） */
  queueRetryPops: number;
  /** 单项重试只在这一轮开始后的这么多毫秒内做（QUEUE_RETRY_MS），留时间给新项按批出队和推送 */
  queueRetryMs: number;
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

/**
 * queue_ok：第 0 步这一轮出队、读行、收尾都没出错是 1，否则 0；queue_poison：这一轮丢掉的有毒项个数（core.ts 写心跳时按首尔当天累计）；
 * recalc_*：第 0 步这一轮写回（含 S1 例外的 ack）、被 R-336 压住、算不出的项数（方案 3.7）
 */
export interface RoundResult {
  claimed: number; sent: number; failed: number; budget_hit: boolean; left: number; queue_ok: number; queue_poison: number;
  recalc_written: number; recalc_r336: number; recalc_failed: number;
}

// 第 1～8 步之间传的东西（11-05 从 round-send.ts 挪来，REMIND-split-low L4）
/** tz：第 2 步定下的显示和免打扰时区（current_tz；R-316 时区坏了的日程用它自己的 tz） */
export type Cand = { table: Table; row: ItemRow; due: number; tz?: string };
export type Item = { table: Table; row: ItemRow };
/** 第 1 步之后一次读出的这几个人的资料 */
export type UserData = { profiles: Map<string, Profile>; settings: Map<string, UserSettings>; devs: Map<string, DeviceRow[]> };
