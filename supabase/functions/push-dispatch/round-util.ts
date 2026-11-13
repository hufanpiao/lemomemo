// push-dispatch 一轮的小工具、tz_invalid 记录和 filterUsable；流程总说明在 round.ts 文件头。
import { AHEAD_MS, BEHIND_MS, DB_DATA, DB_NOFN, DB_TIMEOUT, LOG_SRC, type Dnd, type ItemRow, type LogRow, type NotifyMsgLike, type NotifyTextLike, type RoundCtx, type RoundLogic, type Table, type UserSettings } from './round-types.ts';

// ---------------- 小工具 ----------------

/**
 * 出错时记的原因码：数据库请求超时（store 抛 DB_TIMEOUT）记 `<码>:timeout`，数据类错误（DB_DATA）记 `<码>:data`，
 * 函数找不到（DB_NOFN，PGRST202）记 `<码>:nofn`，其余记 `<码>`（方案 3.6：收尾不变，只是日志分得开）
 */
const FAIL_SUFFIX: ReadonlyMap<string, string> = new Map([[DB_TIMEOUT, 'timeout'], [DB_DATA, 'data'], [DB_NOFN, 'nofn']]);
export function failCode(code: string, e: unknown): string {
  const suffix = e instanceof Error ? FAIL_SUFFIX.get(e.message) : undefined;
  return suffix === undefined ? code : `${code}:${suffix}`;
}

/** due_at = greatest(remind_at, snooze_at, defer_until)（PG 的 greatest 不看 null；三个都空回 null） */
export function dueAtOf(r: Pick<ItemRow, 'remind_at' | 'snooze_at' | 'defer_until'>): number | null {
  let m: number | null = null;
  for (const v of [r.remind_at, r.snooze_at, r.defer_until]) if (typeof v === 'number' && (m === null || v > m)) m = v;
  return m;
}

/**
 * 这一轮按哪个时刻判到点（和 private.remind_due 一致，迁移 20261114191000）：日程、待办是 dueAtOf。
 * 纪念日推完 remind_at 就挪到下一次（round-send.ts 的 writeAnnivNext），推过以后按的“明天再提醒”（snooze_at > pushed_for）
 * 可能早于挪过的 remind_at，greatest 会把它吞掉（整块评审第 1 条）：这时 greatest(snooze_at, defer_until) 落在窗口 (lo, hi] 里就按它判
 */
export function dueOf(table: Table, r: ItemRow, lo: number, hi: number): number | null {
  if (table === 'anniversaries' && r.snooze_at !== null && r.snooze_at > (r.pushed_for ?? 0)) {
    const s = Math.max(r.snooze_at, r.defer_until ?? r.snooze_at);
    if (s > lo && s <= hi) return s;
  }
  return dueAtOf(r);
}

/** 第 1 步的精确条件（SQL 语义：remind_at 为空时 coalesce(notified_for, 0) <> remind_at 是 null，不算到点） */
export function isDue(table: Table, r: ItemRow, now: number): number | null {
  if (r.deleted_at !== null || r.undone === true || (table === 'todos' && r.done === true) || r.remind_at === null) return null;
  const due = dueOf(table, r, now - BEHIND_MS, now + AHEAD_MS);
  if (due === null || due > now + AHEAD_MS || due <= now - BEHIND_MS) return null;
  if ((r.pushed_for ?? 0) === due || (r.notified_for ?? 0) === r.remind_at) return null;
  return due;
}

/**
 * resolve 的条件：推过（pushed_for 不空），之后在别处处理了（和 private.remind_pushed 逐条一致）——
 * 按了“知道了”（notified_for = remind_at）；提醒时间改了、按了“稍后”、提醒关了（due_at 不等于 pushed_for，或三列都空）；
 * R-317：待办完成（done）、条目删除（deleted_at 不空）或撤销（undone）也收回旧通知。
 * 纪念日（整块评审第 1 条，迁移 20261114191000）：推完 remind_at 就挪到下一次，due_at ≠ pushed_for 不说明什么，改成——
 * 按了“知道了”（界面写这一次的时刻，notified_for ≥ pushed_for）、推过以后又按了稍后（snooze_at > pushed_for）、提醒关了（remind_at 为空）。
 * 已知不收回的：免打扰顺延过、或稍后那一次推过以后再按“知道了”（pushed_for 晚于这一次的时刻）；非苹果设备上那条通知留着，用户自己划掉
 */
export function isHandledAfterPush(table: Table, r: ItemRow): boolean {
  if (r.pushed_for === null) return false;
  if (r.deleted_at !== null || r.undone === true || (table === 'todos' && r.done === true)) return true;
  if (table === 'anniversaries') return r.remind_at === null || (r.notified_for ?? 0) >= r.pushed_for || (r.snooze_at ?? 0) > r.pushed_for;
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

export function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const a = m.get(k);
    if (a) a.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/**
 * 记 tz_invalid：每人一轮一条，并且每人每小时最多一条（代码审查建议 ⑥；查最近一小时有没有记过，查不了就这轮不记——宁可少记，
 * 不让坏时区的人每分钟写一条日志）。code 只写表名或 profiles 一类的原因，不写时区串和标题
 */
export async function logTzInvalid(c: RoundCtx, logs: LogRow[], notes: ReadonlyMap<string, string>, now: number): Promise<void> {
  if (notes.size === 0) return;
  let seen: Set<string>;
  try {
    seen = await c.store.tzLoggedSince([...notes.keys()], now - 3_600_000);
  } catch (e) {
    c.log(failCode('tz_log_check_failed', e));
    return;
  }
  for (const [u, code] of notes) {
    if (!seen.has(u)) logs.push({ user_id: u, t: now, device: null, kind: 'run', act: 'tz_invalid', src: LOG_SRC, coll: null, item_id: null, code });
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
