// push-dispatch 的处理逻辑（架构 5.3、第 6 节、6.1、0.49 第 1～5 条；B2 任务单 BE-1 ②、第一天派工表第 4 行；B2 安全审查第五节）。
// 数据库、VAPID、fetch 都由 index.ts 注入，Vitest 直接测这一份。不 import npm 包、不碰 Deno 全局。
//
// 流程：
//   1. 只收 POST；先鉴权（x-cron-secret 定长比较，照 account-purge），再判“没配好”——没带对密钥的调用方看不出函数配没配；
//   2. 配置检查（任一项不过回 500 misconfigured，一条都不发，日志只记原因码）：
//      CRON_SECRET ≥ 32 字节；PUSH_SERVICE_OVERRIDE_URL 线上只要不为空就拒（misconfigured:override，D1-8）、本机也要合规；
//      VAPID 三个变量读入并自检（_shared/push/vapid.ts：d 和 x、y 是一对、和 VAPID_PUBLIC_KEY 逐字节一致，C-9；
//      VAPID_PUBLIC_KEY 没设或空串和不配对一样回 500，TC-B2-88）；数据库客户端在；
//   3. 本轮（BE-2）：第 0 步出队即删、重算 remind_at，第 1～8 步到点查询、免打扰、认领、发送、写回，都在 round.ts 的 runRound；
//      发送只经 _shared/push/send.ts 的 deliver，签名器 VapidSigner 由 index.ts 按 VAPID 缓存常驻复用（代码审查 S10）；
//   4. 写心跳 push-dispatch，detail 记 claimed、sent、failed、budget_hit（6.1、0.49 第 3、4 条；lemo-ops 规则 O-3），
//      加第 0 步的 queue_ok、queue_poison（11-04 安全审查必改 3，见 HeartbeatDetail）；budget_hit 为真的那一轮另记 left（没来得及认领的条数，
//      TC-B2-81、架构审 D3 第 2 点“detail 写 budget_hit: true 和剩余条数”，11-06 主持人定按用例表改），没到预算的轮不写 left。
// 上限（0.49 第 3 条、D3；BE-1 实测后定的初值，写进架构 5.3 的建议由架构师改）：
//   一轮最长 ROUND_BUDGET_MS 墙钟、发送并发 SEND_CONCURRENCY、每轮发送 SEND_LIMIT_PER_ROUND 次（本机实测每条约 0.9 ms CPU，
//   Edge 上按慢 2～3 倍算 200 条约 0.6 s CPU，远在 2 s 上限内；等预览 cpu_time_used 复核后再调）、每人每分钟 PER_USER_PER_MINUTE 条（第 6 节）、
//   第 0 步每次最多出队 QUEUE_POP_LIMIT、第 1 步每次最多取 DUE_LIMIT。
// 日志只记原因码（A23）：不记地址、标题、密钥、JWT、响应体。

import { cronGate, json } from '../_shared/http.ts';
import { buildPayload } from '../_shared/push/payload.ts';
import { deliver, type FetchLike } from '../_shared/push/send.ts';
import { VapidSigner, type VapidKeys, type VapidLoad } from '../_shared/push/vapid.ts';
import type { Override } from '../_shared/push/stub.ts';
import { runRound, type Limits, type RoundLogic, type RoundStore } from './round.ts';

export { filterUsable } from './round.ts';

export const HEARTBEAT = 'push-dispatch';
export const ROUND_BUDGET_MS = 20_000;
export const SEND_CONCURRENCY = 10;
export const SEND_LIMIT_PER_ROUND = 200;
export const PER_USER_PER_MINUTE = 20;
export const QUEUE_POP_LIMIT = 500;
// 第 0 步的租约（REMIND-queue-crash-loss 方案丙，R-348 负责人定 180 秒）：一轮最长 20 秒墙钟、pg_net 超时 25 秒，
// 崩了的那批最多 3～4 分钟后被别的轮重取；有毒项上限 5 次写在迁移 20261104130000 的 SQL 里
export const QUEUE_LEASE_S = 180;
// 第 0 步一轮最多做几次单项重试（11-04 审查返工 H1，主持人定 20）：重试一次只交出 1 项，每次都要出队、读行、写回、收尾，
// 太多会挤掉第 1～8 步的推送预算；一次崩溃留下的 500 项重试项约 25 分钟消化完。重试以后每轮都再做一次新项按批出队
// （11-05 安全复审 N1），重试项再多也不耽误别人新改的项
export const QUEUE_RETRY_POPS = 20;
// 单项重试只在这一轮开始后的 5 秒内做（11-05 N1）：重试慢的时候也给新项按批出队和第 1～8 步留出时间（一轮预算 20 秒）
export const QUEUE_RETRY_MS = 5000;
export const DUE_LIMIT = 500;

/**
 * 心跳 detail（usage-report 按 DETAIL_FIELDS_BY_NAME['push-dispatch'] 白名单转发，只是个数和布尔）：
 * queue_ok——这一轮第 0 步出队、读行、收尾都没出错是 1，否则 0（lemo-ops 连续 3 次抽查都是 0 才提示：回滚以后第 0 步一直跳过、
 *   或出队持续失败，编辑过的提醒一直不重算）；
 * queue_poison——首尔当天累计丢掉的有毒项个数（同一个首尔日就累加，换日从这一轮重新算；lemo-ops 15 分钟才抽一次，只记这一轮会漏掉）。
 *   > 0 当天提示（11-04 安全审查必改 3，主持人定）。
 *   累加在 SQL 里原子完成（11-05 接手清单 REMIND-poison-atomic，代码审查复审 N3；迁移 20261105140000 的 private.push_heartbeat_write）：
 *   一句 insert … on conflict do update 在行锁下读旧值、加这一轮、写回，两轮重叠时后到的等先到的提交再累加，不再少算。
 *   原来是函数里先读上一次心跳、加上这一轮、再 upsert，两轮重叠时后写的会盖掉先写的。
 */
export type HeartbeatDetail = { claimed: number; sent: number; failed: number; budget_hit: boolean; queue_ok: number; queue_poison: number; left?: number };

export const LIMITS: Limits = {
  budgetMs: ROUND_BUDGET_MS, concurrency: SEND_CONCURRENCY, sendLimit: SEND_LIMIT_PER_ROUND, perUser: PER_USER_PER_MINUTE,
  queuePop: QUEUE_POP_LIMIT, queueLeaseS: QUEUE_LEASE_S, queueRetryPops: QUEUE_RETRY_POPS, queueRetryMs: QUEUE_RETRY_MS, due: DUE_LIMIT,
};

export interface DispatchStore extends RoundStore {
  /**
   * 写 push-dispatch 心跳：detail 是除 queue_poison 以外的字段，poison 是这一轮丢掉的有毒项个数；
   * 返回写进心跳的首尔当天累计（private.push_heartbeat_write 原子累加，REMIND-poison-atomic）
   */
  writeHeartbeat(detail: Omit<HeartbeatDetail, 'queue_poison'>, poison: number): Promise<number>;
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
    r = { claimed: 0, sent: 0, failed: 0, budget_hit: deps.now() - t0 >= ROUND_BUDGET_MS, left: 0, queue_ok: 0, queue_poison: 0 };
  }
  // left 只在 budget_hit 为真时进心跳（TC-B2-81）：平时的心跳字段不变，lemo-ops、usage-report 照旧认得
  const base = { claimed: r.claimed, sent: r.sent, failed: r.failed, budget_hit: r.budget_hit, queue_ok: r.queue_ok, ...(r.budget_hit ? { left: r.left } : {}) };
  let detail: HeartbeatDetail;
  try {
    detail = { ...base, queue_poison: await store.writeHeartbeat(base, r.queue_poison) };
  } catch {
    deps.log?.('heartbeat_failed');
    return json(503, { error: 'try_later' });
  }
  return json(200, { ok: true, ...detail, left: r.left });
}
