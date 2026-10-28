// r2-probe 的 HTTP 一层（预览专用、一次性；说明和下线步骤见 docs/09-路线图/B0-R2探测函数.md）。
// 按“任何人都能调用”设计：不靠 JWT（预览部署时 verify_jwt = false），靠下面几道：
//   ① R2_BUCKET_PREFIX 不是 'preview-' → 404，什么都不做（连令牌都不读、不建客户端）；
//   ② 只接受 POST、请求体 ≤ 256 字节、{"action":"run"} 或 {"action":"release"}；
//   ③ 写死的过期时间 EXPIRES_AT（B0 最晚签完的日子）：过了一律 410，不建客户端、不碰 R2；
//   ④ 按时段分键的锁（_probe/lock-<时段>，条件写），run 和 release 共用，每个时段（COOLDOWN_MS）最多一次；被挡回的请求只花 1 次 B 类读；
//   ⑤ 整次运行一个总预算（TOTAL_BUDGET_MS，含拿锁、HEAD、清理），超了中止底下的请求；
//   ⑥ 响应只有每一步的通过 / 失败、HTTP 状态、错误码、耗时和个数；不回显令牌、endpoint、对象内容和桶里的任何键名。
// 不打印任何东西（架构第 6 节“日志”：不打印请求头和请求体）。只 import ./probe.ts、./lock.ts，Vitest 能直接测。
import { acquireLock, releaseLock } from './lock.ts';
import { type Budget, makeBudget, type ProbeClient, type ProbeDeps, runProbe, TOTAL_BUDGET_MS } from './probe.ts';

export const PREVIEW_PREFIX = 'preview-';
/** 过了这个时间一律 410（B0 最晚签完的日子，审查中 3）；要延期得改代码、重新过审查 */
export const EXPIRES_AT = Date.parse('2026-11-10T15:00:00Z');
const MAX_BODY = 256;

export interface HandlerDeps {
  /** 读环境变量（index.ts 传 Deno.env.get）；这里只读 R2_BUCKET_PREFIX 和 SB_REGION */
  env: (name: string) => string | undefined;
  /**
   * 建一个存储客户端；令牌和 endpoint 由 index.ts 自己读，缺了就抛错（这里只回 misconfigured）。
   * budget.signal() 是正在做的操作的中止信号，客户端要把它并进每个请求（超了总预算就中止）
   */
  makeClient: (bucketPrefix: string, budget: Budget) => ProbeClient;
  now: () => number;
  clock: () => number;
  randomHex: (bytes: number) => string;
  /** 总预算（毫秒），默认 TOTAL_BUDGET_MS；只给单测调小 */
  budgetMs?: number;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

async function readAction(req: Request): Promise<'run' | 'release' | null> {
  const len = req.headers.get('content-length');
  if (len !== null && !(/^\d{1,4}$/.test(len) && Number(len) <= MAX_BODY)) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(buf)) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const keys = Object.keys(v);
    const action = (v as { action?: unknown }).action;
    if (keys.length !== 1 || (action !== 'run' && action !== 'release')) return null;
    return action;
  } catch {
    return null;
  }
}

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  // ① 正式环境（前缀是空串）和任何不是 preview- 的环境：像没有这个函数一样
  if (deps.env('R2_BUCKET_PREFIX') !== PREVIEW_PREFIX) {
    if (req.body) await req.body.cancel().catch(() => undefined);
    return json(404, { error: 'not_found' });
  }
  // ③ 过期：同样不建客户端、不碰 R2
  if (!(deps.now() < EXPIRES_AT)) {
    if (req.body) await req.body.cancel().catch(() => undefined);
    return json(410, { error: 'expired' });
  }
  // ②
  if (req.method !== 'POST') {
    if (req.body) await req.body.cancel().catch(() => undefined);
    return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  }
  const action = await readAction(req);
  if (!action) return json(400, { error: 'bad_request' });

  let probe: ProbeDeps;
  const budget = makeBudget(deps.clock, deps.budgetMs ?? TOTAL_BUDGET_MS);
  try {
    probe = {
      preview: deps.makeClient(PREVIEW_PREFIX, budget),
      unprefixed: deps.makeClient('', budget),
      now: deps.now,
      clock: deps.clock,
      randomHex: deps.randomHex,
      budget,
    };
  } catch {
    // 不说缺的是哪一个（也不回显 objstore 的错误）
    return json(500, { error: 'misconfigured' });
  }
  const region = deps.env('SB_REGION') ?? null;

  if (action === 'release') {
    const r = await releaseLock(probe);
    if (r.kind === 'busy') return json(429, { error: 'busy', retry_after_s: r.retryAfterS }, { 'retry-after': String(r.retryAfterS) });
    if (r.kind === 'error') return json(503, { error: 'lock_failed', code: r.code, status: r.status });
    return json(200, { released: true, removed: r.removed, leftovers: r.leftovers });
  }

  // ④
  const t0 = deps.clock();
  const lock = await acquireLock(probe);
  if (lock.kind === 'busy') return json(429, { error: 'busy', retry_after_s: lock.retryAfterS }, { 'retry-after': String(lock.retryAfterS) });
  if (lock.kind === 'error') return json(503, { error: 'lock_failed', code: lock.code, status: lock.status, region });

  try {
    const report = await runProbe(probe);
    // ⑥ 报告里本来就只有状态、错误码、耗时和个数
    return json(200, { region, total_ms: Math.round(deps.clock() - t0), ...report });
  } catch {
    return json(500, { error: 'internal', region });
  }
}
