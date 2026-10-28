// r2-probe 的探测步骤（预览专用、一次性；B0 实测清单 P12，R2 任务单第五节第 1、5、8 项）。
// 说明和下线步骤：docs/09-路线图/B0-R2探测函数.md。
//
// 锁（拿锁、release）在 lock.ts。这个文件不 import 任何东西：存储经下面的 ProbeStore 传进来（index.ts 传真的 _shared/gen/objstore.ts，
// 单测传 tests/fakes/objstore-memory.ts），时钟、随机数也由调用方给，所以 Vitest 和 deno check 都能直接用它。
//
// 只碰 `_probe/` 前缀：
//   • 每次运行的对象在 `_probe/<32 位随机十六进制>/a.txt`、`b.txt`，写完就删；只按这个随机前缀列，只删自己写的这两个键；
//   • 频率保护的锁按时段分键：`_probe/lock-<floor(now / COOLDOWN_MS)>`（逻辑桶 images，即 preview-images），条件写，
//     每个时段只有一个赢家（run 和 release 共用），不删当前和上一时段的锁；更早的锁在下次运行或 release 时清掉；
//   • release 另外按 `_probe/` 前缀数四个预览桶里剩下的对象，只删符合本函数命名的键（锁、`<32 位十六进制>/a.txt|b.txt`）；
//   • 正式桶（不带前缀的 images、files、vault-images、vault-files）只发 HEAD，键是随机的、不存在的，绝不写、不列、不删。
// 结果里只有每一步的通过 / 失败、HTTP 状态、错误码、耗时和个数；不放 endpoint、令牌、对象内容和键名。
//
// 总预算（审查低 2）：从拿锁到最后一次清理整次运行一起算，默认 25 秒；主步骤（拿锁、旧锁清理、四个桶、正式桶 HEAD）
// 只能用到“总预算 − 清理预留”，清理用剩下的。每个操作（含读响应体）都和剩余时间赛跑，超时报 deadline，不再等。

/** 和 shared/objstore.ts 的 ObjStore 同形的最小子集（结构类型，真客户端和内存替身都能直接传进来） */
export interface ProbeStore {
  put(bucket: string, key: string, body: Uint8Array, opts: { contentType: string; ifNoneMatch?: boolean }): Promise<unknown>;
  get(bucket: string, key: string): Promise<{ body: unknown } | null>;
  head(bucket: string, key: string): Promise<unknown>;
  list(bucket: string, prefix: string, opts?: { maxKeys?: number }): Promise<{ objects: readonly { key: string }[]; nextToken: string | null }>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<number>;
}

/** 一个存储客户端，加上它最后一次收到的 HTTP 状态（index.ts 包一层 fetch 记下来；替身没有就是 null） */
export interface ProbeClient {
  store: ProbeStore;
  status: { last: number | null };
}

export interface ProbeDeps {
  /** R2_BUCKET_PREFIX = 'preview-' 的客户端：四个预览桶 */
  preview: ProbeClient;
  /** 不带前缀的客户端：只用来证明 R2_FN 碰不到正式桶（只发 HEAD） */
  unprefixed: ProbeClient;
  /** 墙上时间（毫秒），锁的时段用 */
  now: () => number;
  /** 单调时钟（毫秒），步骤耗时和总预算用 */
  clock: () => number;
  /** n 字节的随机数，十六进制小写 */
  randomHex: (bytes: number) => string;
  /** 这次请求的总预算，见 makeBudget */
  budget: Budget;
}

/** 四个逻辑桶（清单 store = 'r2'；预览环境由客户端加 preview- 前缀） */
export const BUCKETS = ['images', 'files', 'vault-images', 'vault-files'] as const;
/** 测试对象一律在这个前缀下 */
export const PROBE_ROOT = '_probe/';
export const LOCK_BUCKET = 'images';
export const LOCK_PREFIX = `${PROBE_ROOT}lock-`;
/** 时段长度：每个时段最多跑一次 */
export const COOLDOWN_MS = 300_000;
/** 整次运行的总预算（含拿锁、HEAD、清理） */
export const TOTAL_BUDGET_MS = 25_000;
/** 总预算里留给清理的比例（25 秒里留 8 秒） */
export const CLEANUP_RESERVE_RATIO = 0.32;
/** 锁对象和测试对象最多读这么多字节 */
export const OBJ_MAX_BYTES = 1024;

export const slotOf = (now: number) => Math.floor(now / COOLDOWN_MS);
export const lockKey = (now: number) => `${LOCK_PREFIX}${slotOf(now)}`;
const LOCK_KEY_RE = /^_probe\/lock-(\d{1,15})$/;
/**
 * 可以删的旧锁：时段号 < 当前时段 − 1（第二轮审查低 1）。上一时段的锁要留着：别的实例上 now 还落在上一时段末尾的
 * 晚到请求，看到它才会回 busy，不会在同一时段里再跑一次。
 */
export function isStaleLock(key: string, now: number): boolean {
  const m = LOCK_KEY_RE.exec(key);
  return m !== null && Number(m[1]) < slotOf(now) - 1;
}

export type StepName = 'put' | 'put_if_absent_again' | 'get' | 'put_second' | 'list' | 'delete_many' | 'list_after';

export interface StepResult {
  step: StepName | 'cleanup' | 'head';
  ok: boolean;
  /** 这一步最后一次 HTTP 响应的状态；没发请求或网络错误是 null */
  status: number | null;
  /** 出错或不符合预期时的错误码（objstore 的错误码，或本文件的：overwrote、mismatch、missing、list_mismatch、not_empty、skipped、deadline、allowed、internal） */
  code: string | null;
  ms: number;
  /** list、list_after、cleanup：本次随机前缀下的对象个数 */
  count?: number;
}

export interface BucketResult {
  bucket: (typeof BUCKETS)[number];
  ok: boolean;
  steps: StepResult[];
}

export interface IsolationResult {
  /** 正式桶的逻辑名（不带前缀） */
  bucket: (typeof BUCKETS)[number];
  /** 被拒（denied / 403）才算通过；能 HEAD 到（回 404 = 有权限、对象不存在）算失败。只是旁证，主证据是令牌范围截图 */
  ok: boolean;
  status: number | null;
  code: string | null;
  ms: number;
}

export interface ProbeReport {
  ok: boolean;
  buckets: BucketResult[];
  isolation: IsolationResult[];
  /** 旧时段的锁清掉了几个（-1 = 清理失败，不影响结果） */
  old_locks_removed: number;
}

// ---------------- 总预算 ----------------

export type Phase = 'main' | 'cleanup';

export interface Budget {
  /** 这个阶段还剩多少毫秒（main 要扣掉清理预留） */
  remaining(phase: Phase): number;
  /** 正在做的那个操作的中止信号：withBudget 报 deadline 时中止它；index.ts 的 fetch 把它并进请求（第二轮审查低 2） */
  signal(): AbortSignal | undefined;
  /** 只给 withBudget 用：换成下一个操作的中止器 */
  begin(ac: AbortController | undefined): void;
}

export function makeBudget(clock: () => number, totalMs: number = TOTAL_BUDGET_MS): Budget {
  const start = clock();
  const reserve = Math.round(totalMs * CLEANUP_RESERVE_RATIO);
  let current: AbortController | undefined;
  return {
    remaining: (phase) => start + totalMs - (phase === 'main' ? reserve : 0) - clock(),
    signal: () => current?.signal,
    begin: (ac) => {
      current = ac;
    },
  };
}

/** 形状和 ObjStoreError 一样（errInfo 认得），code = deadline */
function deadlineError(): Error {
  const e = new Error('objstore_deadline') as Error & { code: string; status: null };
  e.name = 'ObjStoreError';
  e.code = 'deadline';
  e.status = null;
  return e;
}

/**
 * 在剩余时间内跑完 f，否则报 deadline；已经用完就不发请求。
 * 超时的同时中止底下的请求（budget.signal()，index.ts 并进 fetch），连同还没读完的响应体，不让它在后台接着跑。
 */
export async function withBudget<T>(budget: Budget, phase: Phase, f: () => Promise<T>): Promise<T> {
  const left = budget.remaining(phase);
  if (left <= 0) throw deadlineError();
  const ac = new AbortController();
  budget.begin(ac);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(deadlineError());
    }, left);
  });
  try {
    return await Promise.race([f(), timeout]);
  } finally {
    clearTimeout(timer);
    budget.begin(undefined);
  }
}

export const enc = new TextEncoder();

/** ObjStoreError 只按形状认（这个文件不 import objstore）：name、code、status */
export function errInfo(e: unknown): { code: string; status: number | null } {
  if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'ObjStoreError') {
    const { code, status } = e as { code?: unknown; status?: unknown };
    return { code: typeof code === 'string' ? code : 'internal', status: typeof status === 'number' ? status : null };
  }
  return { code: 'internal', status: null };
}

/** 读流式响应体，最多 max 字节；超了返回 null（不整个读进内存）。计时由调用方的 withBudget 管 */
export async function readSmall(body: unknown, max: number): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return new Uint8Array(0);
  const reader = (body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } }).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 跑一步：清掉上次记下的状态 → 在预算内执行 → 按 judge 判断结果。
 * judge 返回的 code 为 null 表示通过；expectError 给“应该报错才对”的步骤（条件写、正式桶 HEAD）用。
 */
async function step<T>(
  deps: ProbeDeps,
  client: ProbeClient,
  phase: Phase,
  name: StepResult['step'],
  run: () => Promise<T>,
  judge: (v: T) => { code: string | null; count?: number },
  expectError?: (code: string) => boolean,
): Promise<StepResult> {
  client.status.last = null;
  const t0 = deps.clock();
  try {
    const v = await withBudget(deps.budget, phase, run);
    const j = judge(v);
    const r: StepResult = { step: name, ok: j.code === null, status: client.status.last, code: j.code, ms: Math.round(deps.clock() - t0) };
    if (j.count !== undefined) r.count = j.count;
    return r;
  } catch (e) {
    const { code, status } = errInfo(e);
    const ok = code !== 'deadline' && expectError ? expectError(code) : false;
    return { step: name, ok, status: status ?? client.status.last, code, ms: Math.round(deps.clock() - t0) };
  }
}

function skipped(name: StepName): StepResult {
  return { step: name, ok: false, status: null, code: 'skipped', ms: 0 };
}

/** 一个桶：写、条件写、读、再写一个、列、批量删、再列；最后没清干净就按两个已知的键清理一次 */
async function probeBucket(deps: ProbeDeps, bucket: (typeof BUCKETS)[number], runPrefix: string): Promise<BucketResult> {
  const c = deps.preview;
  const s = c.store;
  const keyA = `${runPrefix}a.txt`;
  const keyB = `${runPrefix}b.txt`;
  const bodyA = enc.encode(`lemo r2-probe a ${runPrefix}`);
  const bodyB = enc.encode(`lemo r2-probe b ${runPrefix}`);
  const steps: StepResult[] = [];
  const ownKeys = (objs: readonly { key: string }[]) => objs.every((o) => o.key === keyA || o.key === keyB);
  const st = <T>(name: StepName, run: () => Promise<T>, judge: (v: T) => { code: string | null; count?: number }, expectError?: (code: string) => boolean) =>
    step(deps, c, 'main', name, run, judge, expectError);

  const plan: { name: StepName; go: () => Promise<StepResult> }[] = [
    { name: 'put', go: () => st('put', () => s.put(bucket, keyA, bodyA, { contentType: 'text/plain', ifNoneMatch: true }), () => ({ code: null })) },
    {
      // 对象已在：R2 应回 412，客户端抛 exists。没报错 = 条件写不生效（被覆盖了）
      name: 'put_if_absent_again',
      go: () =>
        st(
          'put_if_absent_again',
          () => s.put(bucket, keyA, bodyA, { contentType: 'text/plain', ifNoneMatch: true }),
          () => ({ code: 'overwrote' }),
          (code) => code === 'exists',
        ),
    },
    {
      name: 'get',
      go: () =>
        st(
          'get',
          async () => {
            const o = await s.get(bucket, keyA);
            return o ? await readSmall(o.body, OBJ_MAX_BYTES) : ('missing' as const);
          },
          (got) => ({ code: got === 'missing' ? 'missing' : got && sameBytes(got, bodyA) ? null : 'mismatch' }),
        ),
    },
    { name: 'put_second', go: () => st('put_second', () => s.put(bucket, keyB, bodyB, { contentType: 'text/plain', ifNoneMatch: true }), () => ({ code: null })) },
    {
      name: 'list',
      go: () =>
        st(
          'list',
          () => s.list(bucket, runPrefix, { maxKeys: 10 }),
          (p) => {
            const keys = new Set(p.objects.map((o) => o.key));
            const exact = p.objects.length === 2 && keys.has(keyA) && keys.has(keyB) && !p.nextToken;
            return { code: exact ? null : 'list_mismatch', count: p.objects.length };
          },
        ),
    },
    { name: 'delete_many', go: () => st('delete_many', () => s.deleteMany(bucket, [keyA, keyB]), (n) => ({ code: n === 2 ? null : 'mismatch' })) },
    {
      name: 'list_after',
      go: () =>
        st(
          'list_after',
          () => s.list(bucket, runPrefix, { maxKeys: 10 }),
          (p) => ({ code: p.objects.length === 0 ? null : ownKeys(p.objects) ? 'not_empty' : 'list_mismatch', count: p.objects.length }),
        ),
    },
  ];

  let putFailed = false;
  for (const p of plan) {
    if (putFailed && p.name !== 'list_after') {
      steps.push(skipped(p.name));
      continue;
    }
    const r = await p.go();
    steps.push(r);
    if (p.name === 'put' && !r.ok) putFailed = true;
  }

  // 清理：最后一次列出来是 0 就不用做；否则只删自己的两个键（删不存在的键也算成功），再列一次。用清理预留的时间
  const after = steps.find((x) => x.step === 'list_after');
  if (!(after?.ok && after.count === 0)) {
    steps.push(
      await step(
        deps,
        c,
        'cleanup',
        'cleanup',
        async () => {
          await s.deleteMany(bucket, [keyA, keyB]);
          return s.list(bucket, runPrefix, { maxKeys: 10 });
        },
        (p) => ({ code: p.objects.length === 0 ? null : 'not_empty', count: p.objects.length }),
      ),
    );
  }

  const main = steps.filter((x) => x.step !== 'cleanup');
  const cleanup = steps.find((x) => x.step === 'cleanup');
  return { bucket, ok: main.every((x) => x.ok) && (cleanup ? cleanup.ok : true), steps };
}

/** 正式桶：只 HEAD 一个随机的、不存在的键。被拒（denied）才对 */
async function probeIsolation(deps: ProbeDeps, bucket: (typeof BUCKETS)[number], key: string): Promise<IsolationResult> {
  const r = await step(deps, deps.unprefixed, 'main', 'head', () => deps.unprefixed.store.head(bucket, key), () => ({ code: 'allowed' }), (code) => code === 'denied');
  return { bucket, ok: r.ok, status: r.status, code: r.code, ms: r.ms };
}

/** 旧时段的锁（时段号 < 当前 − 1，见 isStaleLock）：列 `_probe/lock-`，只删这些。返回删了几个 */
async function removeOldLocks(deps: ProbeDeps, phase: Phase): Promise<number> {
  const s = deps.preview.store;
  const now = deps.now();
  const page = await withBudget(deps.budget, phase, () => s.list(LOCK_BUCKET, LOCK_PREFIX, { maxKeys: 100 }));
  const old = page.objects.map((o) => o.key).filter((k) => isStaleLock(k, now));
  if (old.length) await withBudget(deps.budget, phase, () => s.deleteMany(LOCK_BUCKET, old));
  return old.length;
}

/** 跑一次完整的探测（调用方先拿到锁） */
export async function runProbe(deps: ProbeDeps): Promise<ProbeReport> {
  const id = deps.randomHex(16);
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('bad_random');
  const runPrefix = `${PROBE_ROOT}${id}/`;
  let oldLocks = -1;
  try {
    oldLocks = await removeOldLocks(deps, 'main');
  } catch {
    oldLocks = -1;
  }
  const buckets: BucketResult[] = [];
  for (const b of BUCKETS) buckets.push(await probeBucket(deps, b, runPrefix));
  const isolation: IsolationResult[] = [];
  for (const b of BUCKETS) isolation.push(await probeIsolation(deps, b, `${runPrefix}none.txt`));
  return { ok: buckets.every((b) => b.ok) && isolation.every((i) => i.ok), buckets, isolation, old_locks_removed: oldLocks };
}
