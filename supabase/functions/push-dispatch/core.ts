// push-dispatch 的处理逻辑（架构 5.3、第 6 节、6.1、0.49 第 1～5 条；B2 任务单 BE-1 ②、第一天派工表第 4 行；B2 安全审查第五节）。
// 数据库、VAPID、fetch 都由 index.ts 注入，Vitest 直接测这一份。不 import npm 包、不碰 Deno 全局。
//
// **现在是骨架**（B2 第 1 步“推送链路做通”要的部分）：
//   1. 只收 POST；先鉴权（x-cron-secret 定长比较，照 account-purge），再判“没配好”——没带对密钥的调用方看不出函数配没配；
//   2. 配置检查（任一项不过回 500 misconfigured，一条都不发，日志只记原因码）：
//      CRON_SECRET ≥ 32 字节；PUSH_SERVICE_OVERRIDE_URL 线上只要不为空就拒（misconfigured:override，D1-8）、本机也要合规；
//      VAPID 三个变量读入并自检（_shared/push/vapid.ts：d 和 x、y 是一对、和 VAPID_PUBLIC_KEY 逐字节一致，C-9；
//      VAPID_PUBLIC_KEY 没设或空串和不配对一样回 500，TC-B2-88）；数据库客户端在；
//   3. 本轮：BE-2 才接第 0 步（出队即删、重算 remind_at）和第 1～8 步（到点查询、免打扰、认领、发送、写回）。骨架这里只有
//      “挑出可用账号”（filterUsable，经 _shared/auth.ts 的 isUsable，唯一判断是 private.account_usable）和发送一台设备的整条链路
//      （_shared/push/send.ts 的 deliver，本机替身上的发送用例在 tests/functions/push-dispatch.test.ts）；
//   4. 写心跳 push-dispatch，detail 记 claimed、sent、failed、budget_hit（6.1、0.49 第 3、4 条；lemo-ops 规则 O-3）。
// 上限（0.49 第 3 条、D3；BE-1 实测后定的初值，写进架构 5.3 的建议由架构师改）：
//   一轮最长 ROUND_BUDGET_MS 墙钟、发送并发 SEND_CONCURRENCY、每轮发送 SEND_LIMIT_PER_ROUND 次（本机实测每条约 0.9 ms CPU，
//   Edge 上按慢 2～3 倍算 200 条约 0.6 s CPU，远在 2 s 上限内；等预览 cpu_time_used 复核后再调）、每人每分钟 PER_USER_PER_MINUTE 条（第 6 节）、
//   第 0 步每次最多出队 QUEUE_POP_LIMIT、第 1 步每次最多取 DUE_LIMIT。
// 日志只记原因码（A23）：不记地址、标题、密钥、JWT、响应体。

import { safeEqual } from '../_shared/proxy-headers.ts';
import type { VapidLoad } from '../_shared/push/vapid.ts';
import type { Override } from '../_shared/push/stub.ts';

export const HEARTBEAT = 'push-dispatch';
export const MIN_SECRET_BYTES = 32;
export const ROUND_BUDGET_MS = 20_000;
export const SEND_CONCURRENCY = 10;
export const SEND_LIMIT_PER_ROUND = 200;
export const PER_USER_PER_MINUTE = 20;
export const QUEUE_POP_LIMIT = 500;
export const DUE_LIMIT = 500;

export type HeartbeatDetail = { claimed: number; sent: number; failed: number; budget_hit: boolean };

export interface DispatchStore {
  writeHeartbeat(detail: HeartbeatDetail): Promise<void>;
}

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
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * 只留可用账号（0.29 续第 138 条④、0.42 第 1 条：停用和冷静期的都不发、不出队）。查询出错的那个人这一轮跳过（不当成可用），
 * 不影响别人；按传入顺序返回、去重
 */
export async function filterUsable(userIds: readonly string[], isUsable: (u: string) => Promise<boolean>, log?: (c: string) => void): Promise<string[]> {
  const out: string[] = [];
  for (const u of new Set(userIds)) {
    try {
      if (await isUsable(u)) out.push(u);
    } catch {
      log?.('usable_check_failed');
    }
  }
  return out;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const secret = deps.cronSecret ?? '';
  const got = req.headers.get('x-cron-secret') ?? '';
  if (secret === '' || got === '' || !safeEqual(got, secret)) return json(401, { error: 'unauthorized' });

  const misconfigured = (code: string) => {
    deps.log?.(code);
    return json(500, { error: 'misconfigured' });
  };
  if (new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) return misconfigured('misconfigured:cron_secret');
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
  // BE-2：第 0 步、第 1～8 步接在这里（用 filterUsable、_shared/push/send.ts 的 deliver、上面的上限常量）
  const detail: HeartbeatDetail = { claimed: 0, sent: 0, failed: 0, budget_hit: deps.now() - t0 >= ROUND_BUDGET_MS };

  try {
    await deps.store.writeHeartbeat(detail);
  } catch {
    deps.log?.('heartbeat_failed');
    return json(503, { error: 'try_later' });
  }
  return json(200, { ok: true, ...detail });
}
