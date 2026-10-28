// r2-probe 的频率保护锁和 release 清理（预览专用、一次性）。步骤本身在 probe.ts，说明见 docs/09-路线图/B0-R2探测函数.md。
// 锁按时段分键：`_probe/lock-<floor(now / COOLDOWN_MS)>`，条件写，每个时段一个赢家。run 和 release 共用这一个名额
// （第二轮审查中 A：release 也占一个时段，不能无限次调）。不删当前和上一时段的锁（第二轮审查低 1，见 probe.ts 的 isStaleLock）。
// 只 import ./probe.ts，Vitest 和 deno check 都能直接用。
import {
  BUCKETS,
  COOLDOWN_MS,
  enc,
  errInfo,
  isStaleLock,
  LOCK_BUCKET,
  lockKey,
  OBJ_MAX_BYTES,
  PROBE_ROOT,
  type ProbeDeps,
  readSmall,
  slotOf,
  TOTAL_BUDGET_MS,
  withBudget,
} from './probe.ts';

/**
 * 时段开头这段时间里不做 release：上一时段的 run 最多还要跑 TOTAL_BUDGET_MS（25 秒），
 * 这时清 `_probe/` 可能删掉它正在用的测试对象。留 5 秒余量。
 */
export const RELEASE_GUARD_MS = TOTAL_BUDGET_MS + 5_000;

/** 测试对象的键（release 只删这些和 isStaleLock 认的旧锁） */
const TEST_KEY_RE = /^_probe\/[0-9a-f]{32}\/(a|b)\.txt$/;

export type LockOutcome = { kind: 'acquired' } | { kind: 'busy'; retryAfterS: number } | { kind: 'error'; code: string; status: number | null };

const secondsUntil = (t: number, now: number) => Math.max(1, Math.ceil((t - now) / 1000));
const nextSlotAt = (now: number) => (slotOf(now) + 1) * COOLDOWN_MS;

/**
 * 拿当前时段的锁：先读（这个时段已经有人跑过时只花 1 次 B 类读），没有就条件写；两个人同时写只有一个成功。
 * 不删当前和上一时段的锁，所以不会有“删了别人刚写的新锁”的竞态。
 */
export async function acquireLock(deps: ProbeDeps): Promise<LockOutcome> {
  const c = deps.preview;
  const now = deps.now();
  const key = lockKey(now);
  const busy = { kind: 'busy', retryAfterS: secondsUntil(nextSlotAt(now), now) } as const;
  try {
    const existing = await withBudget(deps.budget, 'main', async () => {
      const o = await c.store.get(LOCK_BUCKET, key);
      if (o) await readSmall(o.body, OBJ_MAX_BYTES);
      return o !== null;
    });
    if (existing) return busy;
    await withBudget(deps.budget, 'main', () =>
      c.store.put(LOCK_BUCKET, key, enc.encode(JSON.stringify({ at: now })), { contentType: 'application/json', ifNoneMatch: true }),
    );
    return { kind: 'acquired' };
  } catch (e) {
    const { code, status } = errInfo(e);
    if (code === 'exists') return busy;
    return { kind: 'error', code, status: status ?? c.status.last };
  }
}

export type ReleaseOutcome =
  | { kind: 'released'; removed: number; leftovers: Record<(typeof BUCKETS)[number], number> }
  | { kind: 'busy'; retryAfterS: number }
  | { kind: 'error'; code: string; status: number | null };

/**
 * 下线前清理：
 *   ① 时段开头 RELEASE_GUARD_MS 内回 busy（上一时段的 run 可能还在跑）；
 *   ② 和 run 一样拿当前时段的锁，拿不到回 busy——release 也占掉这个时段的名额，冷却期内连调只花 1 次读；
 *   ③ 拿到了才在四个预览桶里按 `_probe/` 列一页，只删测试对象和更早时段的旧锁（当前、上一时段的锁留着），
 *      再列一次，报每个桶 `_probe/` 下除锁以外还剩几个（当前、上一时段最多 2 个锁对象，删函数后由负责人在 R2 后台删）。
 */
export async function releaseLock(deps: ProbeDeps): Promise<ReleaseOutcome> {
  const now = deps.now();
  const slotStart = slotOf(now) * COOLDOWN_MS;
  if (now - slotStart < RELEASE_GUARD_MS) return { kind: 'busy', retryAfterS: secondsUntil(slotStart + RELEASE_GUARD_MS, now) };
  const lock = await acquireLock(deps);
  if (lock.kind !== 'acquired') return lock;
  const c = deps.preview;
  const s = c.store;
  try {
    let removed = 0;
    const leftovers = {} as Record<(typeof BUCKETS)[number], number>;
    for (const b of BUCKETS) {
      const page = await withBudget(deps.budget, 'cleanup', () => s.list(b, PROBE_ROOT, { maxKeys: 1000 }));
      const own = page.objects.map((o) => o.key).filter((k) => TEST_KEY_RE.test(k) || isStaleLock(k, now));
      if (own.length) {
        await withBudget(deps.budget, 'cleanup', () => s.deleteMany(b, own));
        removed += own.length;
      }
      const again = await withBudget(deps.budget, 'cleanup', () => s.list(b, PROBE_ROOT, { maxKeys: 10 }));
      leftovers[b] = again.objects.filter((o) => !(b === LOCK_BUCKET && /^_probe\/lock-\d{1,15}$/.test(o.key))).length;
    }
    return { kind: 'released', removed, leftovers };
  } catch (e) {
    const { code, status } = errInfo(e);
    return { kind: 'error', code, status: status ?? c.status.last };
  }
}
