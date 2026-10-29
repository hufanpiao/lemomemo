// db-probe 入口（预览专用、一次性；B0 实测清单 P6 里要在函数侧实测的几项）。
//
// 为什么放在 _preview/ 下：同 r2-probe——下划线开头的目录不当函数，正式发布（tools/release/publish.ps1 的 functions deploy）不会带上它；
// 只有 deploy-preview.yml 的构建任务在产物里生成 supabase/functions/db-probe/index.ts（只有一句 import 本文件）并给它 verify_jwt = false。
// build/check_backend.py：F6 保证没有顶层同名目录、别处不引 _preview/；F2 只许它（PREVIEW_AI_FUNCS）经 _shared/db.ts 用 fn_ai、读 FN_AI_DB_URL。
//
// 连接串只在这里读、只在这里解析：交给 postgres.js 和 _shared/db.ts，报告里只放 UrlFacts 那几个布尔值，不进响应、不打印。
// 说明、调用方法、要在控制台看的点和下线步骤：docs/09-路线图/B0-P6数据库探测函数.md
import postgres from 'npm:postgres@3.4.5';
import { withAiScan, withAiUser } from '../../_shared/db.ts';
import { SUPABASE_ROOT_CA_PEM } from './ca.ts';
import { handle, type Limiter } from './handler.ts';
import { caFingerprint, connUrl, type ProbeDeps, type Query, type Session, type Tls, urlFacts } from './probe.ts';

/**
 * 自开连接的参数：和 _shared/db.ts 的 connect() 一字不差（{ ssl: 'require', prepare: false, max: 1, connect_timeout: 10, idle_timeout: 5 }），
 * 只换 ssl。tests/edge/db-probe.test.ts 核对两边的文本一致，db.ts 改了这里要跟着改。
 */
const BASE = { prepare: false, max: 1, connect_timeout: 10, idle_timeout: 5 } as const;

const asQuery = (tx: postgres.TransactionSql): Query => (strings, ...values) =>
  tx(strings, ...(values as postgres.ParameterOrFragment<never>[])) as unknown as Promise<readonly Record<string, unknown>[]>;

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
const fp = await caFingerprint(SUPABASE_ROOT_CA_PEM);
const limiter: Limiter = { last: null };
const instance = { id: randomHex(6), bootAt: Date.now() };

function makeProbe(): ProbeDeps {
  const raw = Deno.env.get('FN_AI_DB_URL');
  if (!raw) throw new Error('misconfigured');
  const { facts, host } = urlFacts(raw);
  const open = (tls: Tls): Session => {
    const ssl = tls === 'require'
      ? ('require' as const)
      : tls === 'disable'
      ? false
      : { ca: SUPABASE_ROOT_CA_PEM.trim(), rejectUnauthorized: true, ...(host ? { servername: host } : {}) };
    // disable 那条用假密码的连接串（connUrl）；三条自开连接都不收 NOTICE（onnotice 默认会打印到日志）
    const sql = postgres(connUrl(raw, tls, randomHex), { ssl, ...BASE, onnotice: () => {} });
    return {
      tx: <T>(fn: (q: Query) => Promise<T>) => sql.begin((tx) => fn(asQuery(tx))) as Promise<T>,
      end: () => sql.end({ timeout: 5 }),
    };
  };
  return {
    url: facts,
    lemoProbePresent: Deno.env.get('LEMO_PROBE') !== undefined,
    withUser: (uid, fn) => withAiUser(uid, (tx) => fn(asQuery(tx))),
    withScan: (fn) => withAiScan((tx) => fn(asQuery(tx))),
    open,
    caFingerprint: fp,
    clock: () => performance.now(),
  };
}

Deno.serve((req) =>
  handle(req, {
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    region: Deno.env.get('SB_REGION'),
    makeProbe,
    // 跨实例的并发锁：在 withAiScan 的事务里拿事务级 advisory 锁，整次运行都在这个事务里，提交即放；键和 'embed:' 那组分开
    guard: (fn) =>
      withAiScan(async (tx) => {
        const [r] = await tx`select pg_try_advisory_xact_lock(hashtext('lemo:db-probe')) as got`;
        if (r?.got !== true) return { got: false } as const;
        return { got: true, value: await fn() } as const;
      }),
    limiter,
    now: () => Date.now(),
    instance,
  })
);
