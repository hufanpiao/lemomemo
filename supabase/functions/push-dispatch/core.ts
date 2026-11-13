// push-dispatch 的处理逻辑（架构 5.3、第 6 节、6.1）：只收 POST，先鉴权（x-cron-secret 定长比较）再判配置（替身地址、store、VAPID 自检，不过回 500 misconfigured）；
// 一轮在 round.ts 的 runRound（第 0 步租约式出队重算、第 1～8 步到点推送），之后读一次队列积压、写心跳。数据库、VAPID、fetch 由 index.ts 注入，Vitest 直接测这一份。
// 上限是 BE-1 实测后定的初值（0.49 第 3 条、D3）；出队每人上限、有毒次数、规则版本由这里显式传给 remind_queue_pop（迁移 20261113100000）。
// 心跳字段见 HeartbeatDetail（usage-report 白名单、lemo-ops 规则 O-3 和 push-queue.ts 跟着认）。日志只记原因码（A23）：不记地址、标题、密钥、JWT、响应体。
import { cronGate, json } from '../_shared/http.ts';
import { buildPayload } from '../_shared/push/payload.ts';
import { deliver, type FetchLike } from '../_shared/push/send.ts';
import { VapidSigner, type VapidKeys, type VapidLoad } from '../_shared/push/vapid.ts';
import type { Override } from '../_shared/push/stub.ts';
import { runRound, type Limits, type RoundLogic, type RoundStore } from './round.ts';
import { failCode } from './round-util.ts';

export { filterUsable } from './round.ts';

export const HEARTBEAT = 'push-dispatch';
export const ROUND_BUDGET_MS = 20_000;
export const SEND_CONCURRENCY = 10;
export const SEND_LIMIT_PER_ROUND = 200;
export const PER_USER_PER_MINUTE = 20;
export const QUEUE_POP_LIMIT = 500;
// 第 0 步的租约（REMIND-queue-crash-loss 方案丙，R-348 负责人定 180 秒）：一轮最长 20 秒墙钟、pg_net 超时 25 秒，
// 崩了的那批最多 3～4 分钟后被别的轮重取
export const QUEUE_LEASE_S = 180;
/** 新项按批出队每人最多几项（R-348 起 50；R-411 起由这里传给出队函数） */
export const QUEUE_PER_USER = 50;
/** 取过几次还没处理完就当有毒项丢掉（R-348 起 5 次；R-411 起由这里传给出队函数） */
export const QUEUE_POISON = 5;
// 第 0 步一轮最多做几次单项重试（11-04 审查返工 H1，主持人定 20）：重试一次只交出 1 项，每次都要出队、读行、写回、收尾，
// 太多会挤掉第 1～8 步的推送预算；一次崩溃留下的 500 项重试项约 25 分钟消化完。重试以后每轮都再做一次新项按批出队
// （11-05 安全复审 N1），重试项再多也不耽误别人新改的项
export const QUEUE_RETRY_POPS = 20;
// 单项重试只在这一轮开始后的 5 秒内做（11-05 N1）：重试慢的时候也给新项按批出队和第 1～8 步留出时间（一轮预算 20 秒）
export const QUEUE_RETRY_MS = 5000;
export const DUE_LIMIT = 500;

/**
 * 心跳 detail（usage-report 按 DETAIL_FIELDS_BY_NAME['push-dispatch'] 白名单转发，只是个数和布尔）：
 * claimed、sent、failed、budget_hit（6.1）；left 只在 budget_hit 为真时写（TC-B2-81）。
 * queue_ok——这一轮第 0 步出队、读行、收尾都没出错是 1，否则 0（lemo-ops 连续 3 次都是 0 才提示）；
 * queue_poison——首尔当天累计丢掉的有毒项个数（private.push_heartbeat_write 在行锁下原子累加，REMIND-poison-atomic）；
 * recalc_written、recalc_r336、recalc_failed——第 0 步这一轮写回（含 S1 例外）、被 R-336 压住、算不出的项数（方案 3.7）；
 * queue_wait0、queue_wait_batch、queue_oldest_s——轮末的积压（private.remind_queue_stats：可用账号的 prio 0 项数、批量项数、prio 0 最老一项等了几秒；
 *   lemo-ops 在 queue_oldest_s > 900 时提示）。读积压失败记 queue_stats_failed，这三项不写。
 */
export type QueueStats = { queue_wait0: number; queue_wait_batch: number; queue_oldest_s: number };
export type HeartbeatDetail = {
  claimed: number; sent: number; failed: number; budget_hit: boolean; queue_ok: number; queue_poison: number; left?: number;
  recalc_written: number; recalc_r336: number; recalc_failed: number;
} & Partial<QueueStats>;

export const LIMITS: Limits = {
  budgetMs: ROUND_BUDGET_MS, concurrency: SEND_CONCURRENCY, sendLimit: SEND_LIMIT_PER_ROUND, perUser: PER_USER_PER_MINUTE,
  queuePop: QUEUE_POP_LIMIT, queuePerUser: QUEUE_PER_USER, queuePoison: QUEUE_POISON, queueLeaseS: QUEUE_LEASE_S, queueRetryPops: QUEUE_RETRY_POPS, queueRetryMs: QUEUE_RETRY_MS, due: DUE_LIMIT,
};

export interface DispatchStore extends RoundStore {
  /**
   * 写 push-dispatch 心跳：detail 是除 queue_poison 以外的字段，poison 是这一轮丢掉的有毒项个数；
   * 返回写进心跳的首尔当天累计（private.push_heartbeat_write 原子累加，REMIND-poison-atomic）
   */
  writeHeartbeat(detail: Omit<HeartbeatDetail, 'queue_poison'>, poison: number): Promise<number>;
  /** private.remind_queue_stats：轮末的积压（只算可用账号的项） */
  queueStats(): Promise<QueueStats>;
}

const DAY_MS = 86_400_000;
const SEOUL_MS = 9 * 3_600_000;
/** 首尔日序号（首尔不用夏令时，固定 +9 小时）；测试替身照 private.push_heartbeat_write 的“同一个首尔日”用 */
export const seoulDay = (ms: number): number => Math.floor((ms + SEOUL_MS) / DAY_MS);

export type Deps = {
  cronSecret: string | undefined;
  /** resolveOverride(PUSH_SERVICE_OVERRIDE_URL, SUPABASE_URL, LEMO_LOCAL_PUSH_STUB) 的结果（_shared/push/stub.ts，D1-8） */
  override: Override;
  /** 只在鉴权通过后才调（自检要做签名，不让没带密钥的请求白白耗 CPU） */
  vapid: () => Promise<VapidLoad>;
  store: DispatchStore | null;
  /** private.account_usable（_shared/auth.ts 的 isUsable）；查询出错抛异常 */
  isUsable: (userId: string) => Promise<boolean>;
  now: () => number;
  log?: (code: string) => void;
  /** 共享 logic（index.ts 从 _shared/gen 接进来；测试直接从 shared/ 接） */
  logic: RoundLogic;
  /** 默认 globalThis.fetch */
  fetch?: FetchLike;
  /** 同一份 VAPID 钥匙复用同一个签名器（index.ts 跟着 vapidOnce 的缓存走，S10）；不给就每轮新建 */
  signerFor?: (keys: VapidKeys) => VapidSigner;
  /** 只给测试缩短预算、调小上限；线上用 LIMITS */
  limits?: Partial<Limits>;
};


export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
  if (denied) return denied;

  const misconfigured = (code: string) => {
    deps.log?.(code);
    return json(500, { error: 'misconfigured' });
  };
  if (!deps.override.ok) return misconfigured('misconfigured:override');
  if (!deps.store) return misconfigured('misconfigured:store');
  let vapid: VapidLoad;
  try {
    vapid = await deps.vapid();
  } catch {
    vapid = { ok: false, reason: 'vapid_bad_key' };
  }
  if (!vapid.ok) return misconfigured(`misconfigured:${vapid.reason}`);

  const t0 = deps.now();
  const store = deps.store;
  const log = deps.log ?? (() => {});
  const signer = deps.signerFor ? deps.signerFor(vapid.keys) : new VapidSigner(vapid.keys, deps.now);
  const ctx = { fetch: deps.fetch ?? ((u: string, i: RequestInit) => fetch(u, i)), signer, override: deps.override.url };
  let r;
  try {
    r = await runRound({
      store, logic: deps.logic, limits: { ...LIMITS, ...deps.limits }, now: deps.now, t0, isUsable: deps.isUsable,
      buildPayload, deliver: (dev, payload, opt) => deliver(dev, payload, opt, ctx), log,
    });
  } catch {
    // runRound 自己按步吞错；走到这里是意外，照样写心跳（数字按 0），lemo-ops 看得到这一轮跑过
    log('round_failed');
    r = { claimed: 0, sent: 0, failed: 0, budget_hit: deps.now() - t0 >= ROUND_BUDGET_MS, left: 0, queue_ok: 0, queue_poison: 0, recalc_written: 0, recalc_r336: 0, recalc_failed: 0 };
  }
  let stats: Partial<QueueStats> = {};   // 读失败就不写这三项
  try {
    stats = await store.queueStats();
  } catch (e) {
    log(failCode('queue_stats_failed', e));
  }
  // left 只在 budget_hit 为真时进心跳（TC-B2-81）：平时的心跳字段不变，lemo-ops、usage-report 照旧认得
  const base: Omit<HeartbeatDetail, 'queue_poison'> = {
    claimed: r.claimed, sent: r.sent, failed: r.failed, budget_hit: r.budget_hit, queue_ok: r.queue_ok, ...(r.budget_hit ? { left: r.left } : {}),
    recalc_written: r.recalc_written, recalc_r336: r.recalc_r336, recalc_failed: r.recalc_failed, ...stats,
  };
  let detail: HeartbeatDetail;
  try {
    detail = { ...base, queue_poison: await store.writeHeartbeat(base, r.queue_poison) };
  } catch (e) {
    log(failCode('heartbeat_failed', e));
    return json(503, { error: 'try_later' });
  }
  return json(200, { ok: true, ...detail, left: r.left });
}
