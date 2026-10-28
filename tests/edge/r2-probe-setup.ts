// r2-probe 单测的公共部分（替身客户端、setup、请求和报告的类型）；测试在 r2-probe.test.ts、r2-probe-lock.test.ts。
// 打 tests/fakes/objstore-memory.ts 的内存替身：预览四个桶（preview- 前缀）能读写，正式桶默认按“令牌没权限”抛 denied。
import { type HandlerDeps } from '../../supabase/functions/_preview/r2-probe/handler.ts';
import { type Budget, BUCKETS, COOLDOWN_MS, LOCK_BUCKET, LOCK_PREFIX, type ProbeClient, type ProbeStore } from '../../supabase/functions/_preview/r2-probe/probe.ts';
import { type Call, MemoryObjStore } from '../fakes/objstore-memory.ts';
import { ObjStoreError } from '../../shared/objstore.ts';

export const PREVIEW = BUCKETS.map((b) => `preview-${b}`);
export const SECRET_LIKE = ['https://acct.r2.cloudflarestorage.com', 'AKIA-probe-test', 'secret-probe-test'];
/** 过期前的某个时段起点（对齐时段，方便算 Retry-After） */
export const T0 = Math.floor(Date.parse('2026-11-01T00:00:00Z') / COOLDOWN_MS) * COOLDOWN_MS;

export type Opts = {
  prefix?: string | undefined;
  /** 正式桶也在替身里（= 令牌碰得到正式桶，隔离检查应该失败） */
  prodReachable?: boolean;
  /** 替身不认 If-None-Match（模拟 R2 不支持条件写） */
  ignoreIfNoneMatch?: boolean;
  /** 建客户端时抛错（缺令牌） */
  misconfigured?: boolean;
  /** 每次 clock() 往前走的毫秒数（模拟慢网络、用完预算） */
  tick?: number;
  /** 往这个真桶名写一律被拒（令牌没有写权限） */
  denyPut?: string;
  /** get 回一个永远读不完的响应体（测读响应体也在预算里） */
  hangGet?: boolean;
  /** 总预算（毫秒），默认用函数里的 */
  budgetMs?: number;
  /** 墙上时间的起点 */
  wall?: number;
};

/** 按前缀把逻辑桶名换成真名，交给同一个内存替身；正式桶没在替身里时按 R2 的令牌范围抛 denied（403） */
export function client(mem: MemoryObjStore, prefix: string, o: Opts, made: string[], deleted: string[], budget: Budget, aborted: string[]): ProbeClient {
  made.push(prefix);
  const status: { last: number | null } = { last: null };
  const real = (b: string) => {
    const name = prefix + b;
    if (!name.startsWith('preview-') && !o.prodReachable) {
      status.last = 403;
      throw new ObjStoreError('denied', 403);
    }
    return name;
  };
  const ok = <T>(v: T): T => {
    status.last = 200;
    return v;
  };
  const store: ProbeStore = {
    put: async (b, k, body, opts) => {
      const n = real(b);
      if (n === o.denyPut) {
        status.last = 403;
        throw new ObjStoreError('denied', 403);
      }
      return ok(await mem.put(n, k, body, o.ignoreIfNoneMatch ? { contentType: opts.contentType } : opts));
    },
    get: async (b, k) => {
      const n = real(b);
      if (o.hangGet) {
        // 像 index.ts 那样把总预算的中止信号并进“请求”：中止了就记一笔（证明超了预算会中止底下的请求）
        budget.signal()?.addEventListener('abort', () => aborted.push(k));
        return { body: new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }) };
      }
      return ok(await mem.get(n, k));
    },
    head: async (b, k) => {
      const r = await mem.head(real(b), k);
      status.last = r ? 200 : 404;
      return r;
    },
    list: async (b, p, opts) => ok(await mem.list(real(b), p, opts)),
    deleteMany: async (b, keys) => {
      const n = real(b);
      deleted.push(...keys);
      return ok(await mem.deleteMany(n, keys));
    },
  };
  return { store, status };
}

export function setup(o: Opts = {}) {
  const names = o.prodReachable ? [...PREVIEW, ...BUCKETS] : PREVIEW;
  const mem = new MemoryObjStore(names);
  const made: string[] = [];
  const deleted: string[] = [];
  const aborted: string[] = [];
  let wall = o.wall ?? T0;
  let mono = 0;
  let seq = 0;
  const env: Record<string, string> = {
    R2_ENDPOINT: SECRET_LIKE[0] as string,
    R2_FN_ACCESS_KEY_ID: SECRET_LIKE[1] as string,
    R2_FN_SECRET_ACCESS_KEY: SECRET_LIKE[2] as string,
    SB_REGION: 'ap-northeast-2',
  };
  if (o.prefix !== undefined) env.R2_BUCKET_PREFIX = o.prefix;
  else if (!('prefix' in o)) env.R2_BUCKET_PREFIX = 'preview-';
  const deps: HandlerDeps = {
    env: (n) => env[n],
    makeClient: (p, budget) => {
      if (o.misconfigured) throw new Error('missing R2_FN_SECRET_ACCESS_KEY at https://acct.r2.cloudflarestorage.com');
      return client(mem, p, o, made, deleted, budget, aborted);
    },
    now: () => wall,
    clock: () => (mono += o.tick ?? 1),
    randomHex: (n) => (++seq).toString(16).padStart(n * 2, '0'),
  };
  if (o.budgetMs !== undefined) deps.budgetMs = o.budgetMs;
  return { mem, made, deleted, aborted, deps, advance: (ms: number) => (wall += ms), at: (ms: number) => (wall = ms) };
}

export const post = (body: unknown = { action: 'run' }, init: RequestInit = {}) =>
  new Request('https://x.supabase.co/functions/v1/r2-probe', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init });

export type Report = {
  ok: boolean;
  region: string | null;
  buckets: { bucket: string; ok: boolean; steps: { step: string; ok: boolean; status: number | null; code: string | null; count?: number }[] }[];
  isolation: { bucket: string; ok: boolean; status: number | null; code: string | null }[];
  old_locks_removed: number;
};

export type Env = ReturnType<typeof setup>;
/** 每个请求碰的键或前缀（deleteMany 的键替身不记，另看 setup 的 deleted） */
export const touched = (calls: Call[]) => calls.filter((c) => c.op !== 'deleteMany').map((c) => c.key ?? c.prefix ?? '');
export const lockCount = (s: Env) => s.mem.count(`preview-${LOCK_BUCKET}`, LOCK_PREFIX);
/** 四个预览桶 _probe/ 下除锁以外还剩几个 */
export const leftover = (s: Env) => PREVIEW.map((b) => s.mem.count(b, '_probe/') - (b === `preview-${LOCK_BUCKET}` ? lockCount(s) : 0));
