// “这一次提醒响过没有”的本机记录（REMIND-shown-persist；方案 docs/03-评审/B2/B2-方案-提醒响过持久化.md 第 3、4 节，复审 9.0）
// • 存哪：本机库 meta 仓的 remind_seen 键（core/cache.ts 的 MetaMap）：occurrenceKey → 第一次响的那一次 { tag, dueAt, local }。
//   库按账号分，退出、换账号时随整库清掉；不用 localStorage（不分账号、同步读写、没有事务）
// • 只留 7 天（和“错过的提醒”同一窗口），最多 500 条（按 dueAt 从旧往新删）；不存标题、正文
// • 写：同一个 readwrite 事务里先 get、再按 key 合并（已有的 key 保留原来的 tag、dueAt，local 只会从 false 变 true），然后 put——
//   两个标签页各写各的也不互相覆盖。写失败不重试（下一次再写）；库封存（换账号途中）时 tx 抛错，吞掉
// • 读：坏数据、读失败都当空的
// • 服务器那一半（pushed_for 推导出的“响过”，rangView）也在这里：只在提醒引擎（RemindHost 分包）里算，今天页首屏不带（修订 1 P2）
import { sameRemindDay } from '../../../../shared/logic/remind.ts';
import { reminderTag } from '../../../../shared/logic/remind-route.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import type { Cache, RemindSeenMeta } from '../../../core/cache.ts';
import { META } from '../../../core/cache-schema.ts';
import { MISSED_WINDOW_MS, occurrenceKey, type Reminder } from './reminder-model.ts';
import { hasTimingChange, type OutboxLikeItem } from './remind-write.ts';

export const SEEN_KEY = 'remind_seen';
export const SEEN_MAX = 500;

export interface SeenItem {
  readonly tag: string;
  readonly dueAt: number;
  /** 本机弹过系统通知（exe）；只在横幅里响过的是 false */
  readonly local: boolean;
}
export type SeenItems = Readonly<Record<string, SeenItem>>;

const isItem = (v: unknown): v is SeenItem => {
  if (typeof v !== 'object' || v === null) return false;
  const x = v as Record<string, unknown>;
  return typeof x['tag'] === 'string' && typeof x['dueAt'] === 'number' && Number.isFinite(x['dueAt']) && typeof x['local'] === 'boolean';
};

/** 库里读出来的值 → 记录；形状不对的整份当空、单条不对的丢掉 */
export function parseSeen(v: unknown): Record<string, SeenItem> {
  if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1) return {};
  const items = (v as { items?: unknown }).items;
  if (typeof items !== 'object' || items === null) return {};
  const out: Record<string, SeenItem> = {};
  for (const [k, x] of Object.entries(items)) if (isItem(x)) out[k] = { tag: x.tag, dueAt: x.dueAt, local: x.local };
  return out;
}

/** 合并：base 里已有的 key 保留原来那一次（同一个 key 只记第一次，和 recordRang 一致），local 只会从 false 变 true；新的 key 加进来 */
export function mergeSeen(base: SeenItems, add: SeenItems): Record<string, SeenItem> {
  const out: Record<string, SeenItem> = { ...base };
  for (const [k, x] of Object.entries(add)) {
    const old = out[k];
    out[k] = old === undefined ? x : x.local && !old.local ? { ...old, local: true } : old;
  }
  return out;
}

/** 剪掉 dueAt ≤ now − 7 天的；超过 max 条按 dueAt 从旧往新删 */
export function pruneSeen(items: SeenItems, now: number, max: number = SEEN_MAX): Record<string, SeenItem> {
  const live = Object.entries(items).filter(([, x]) => x.dueAt > now - MISSED_WINDOW_MS);
  live.sort(([, a], [, b]) => b.dueAt - a.dueAt);
  return Object.fromEntries(live.slice(0, max));
}

type SeenCache = Pick<Cache, 'tx'>;

/** 读本机记录；读失败、没有库都当空的 */
export async function readSeen(cache: SeenCache | null | undefined): Promise<Record<string, SeenItem>> {
  if (!cache) return {};
  try {
    const rec = await cache.tx([META], 'readonly', (t) => t.get<{ key: string; value: unknown }>(META, SEEN_KEY));
    return parseSeen(rec?.value);
  } catch {
    return {};
  }
}

/** 把新记下的合进库（同一个事务里先读后写）；返回写成没有。不抛错 */
export async function writeSeen(cache: SeenCache | null | undefined, add: SeenItems, now: number): Promise<boolean> {
  if (!cache || Object.keys(add).length === 0) return false;
  try {
    await cache.tx([META], 'readwrite', async (t) => {
      const rec = await t.get<{ key: string; value: unknown }>(META, SEEN_KEY);
      const value: RemindSeenMeta = { v: 1, items: pruneSeen(mergeSeen(parseSeen(rec?.value), add), now) };
      await t.put(META, { key: SEEN_KEY, value });
    });
    return true;
  } catch {
    return false;
  }
}

// ——— 服务器那一半：pushed_for 推导出的“这一次响过”（方案第 3 节） ———

/**
 * 这一行在 outbox 里有没有换了“哪一次”的改动：pending、inflight、failed 都算，发没发出去都算（方案第 3 节 ③ 第一段；
 * remind-write 的 timingPending 只看最后一项、只认没发出去的，口径不够）。只管日程
 */
export function occurrencePending(r: Pick<Reminder, 'kind' | 'id'>, items: readonly OutboxLikeItem[]): boolean {
  if (r.kind !== 'event') return false;
  const rec = `events:${r.id}`;
  return items.some((it) => it.rec === rec && hasTimingChange(it.data)); // 换“哪一次”的认法和 timingPending 同一个（date、remind_days、time 空与非空）
}

/**
 * 服务器推过这一次（pushed_for 和这一次的 remind_at 按 tz 落在同一天，和 push-dispatch 第 0 步同一个 sameRemindDay）：
 * 返回当时那一次；只对全天日程（没按稍后，occurrenceKey ≠ tag）做（L4），outbox 里有换“哪一次”的改动时不采信（③）
 */
export function pushedSeen(r: Reminder, items: readonly OutboxLikeItem[], tz: Tz): SeenItem | undefined {
  const pushed = r.row['pushed_for'];
  if (typeof pushed !== 'number' || r.remindAt === null || occurrenceKey(r) === r.tag) return undefined;
  if (!sameRemindDay(pushed, r.remindAt, tz) || occurrencePending(r, items)) return undefined;
  return { tag: reminderTag(r.kind, r.id, pushed), dueAt: pushed, local: false };
}

/** 合并视图：本机记录（含这次打开以后响过的）优先，没有的再看服务器推导；只放 list 里有的和本机记录里的 */
export function rangView(list: readonly Reminder[], seen: ReadonlyMap<string, SeenItem>, items: readonly OutboxLikeItem[], tz: Tz): Map<string, SeenItem> {
  const out = new Map(seen);
  for (const r of list) {
    const k = occurrenceKey(r);
    if (out.has(k)) continue;
    const p = pushedSeen(r, items, tz);
    if (p) out.set(k, p);
  }
  return out;
}
