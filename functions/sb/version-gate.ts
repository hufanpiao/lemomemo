// 写入先查版本（架构 0.27 第 1 点、14.2 第 10 点）。
// 这是兼容保护，不是安全措施：直连 supabase.co 就能绕过，权限照旧由 RLS 和列级授权管，不准拿它当权限用。
// 免查名单只有这一份；14.2 第 9 点的退路 Worker 和第 6 节函数里的第二道检查都引用它。

import { applySbSecurityHeaders } from '../_lib/security-headers.ts';

export const VERSION_HEADER = 'x-app-version';

// ---------- 免查名单（精确路径和方法；旧版也必须能做的事） ----------

export interface ExemptRule {
  /** 大写方法名；'*' 表示任何方法 */
  method: string;
  /** 去掉 /sb 前缀后的路径 */
  path: string;
  match: 'exact' | 'prefix';
  why: string;
}

/** REST、存储、Auth 的免查规则。B0 只放已有的三项，其余各批随函数和 RPC 在同一个 PR 里加（15.4 S-B0c） */
export const EXEMPT_RULES: readonly ExemptRule[] = [
  { method: '*', path: '/auth/v1/', match: 'prefix', why: '登录、刷新令牌、退出登录、退出其他设备' },
  { method: 'POST', path: '/storage/v1/object/sign/', match: 'prefix', why: '签名链接，只是读，旧版也要能看图和附件' },
  { method: 'POST', path: '/storage/v1/object/list/', match: 'prefix', why: '列文件，只是读' },
];

export interface ExemptFunction {
  /** supabase/functions/<name>；CI 核对目录存在（build/check_version_gate.mjs） */
  name: string;
  /** 大写方法名；'*' 表示任何方法 */
  methods: readonly string[];
  why: string;
}

/** 免查的 Edge Functions。B0 还没有函数，空着；名单外的函数一律查 */
export const EXEMPT_FUNCTIONS: readonly ExemptFunction[] = [];

// ---------- 判断哪些请求要查 ----------

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function methodHit(list: readonly string[], method: string): boolean {
  return list.includes('*') || list.includes(method);
}

/** 免查名单里的函数名（/functions/v1/<name> 或 /functions/v1/<name>/…） */
function functionName(path: string): string | null {
  const m = /^\/functions\/v1\/([^/]+)/.exec(path);
  return m ? (m[1] ?? null) : null;
}

/**
 * 会改数据的请求才查（0.27 第 1 点）：
 * - `/rest/v1/*` 的 POST、PATCH、PUT、DELETE（含 `/rest/v1/rpc/*`，免查的 RPC 按名单）；
 * - `/storage/v1/*` 的上传、删除等写操作（签名和列文件免查）；
 * - `/functions/v1/*` 的所有函数，免查的除外；
 * - `/auth/v1/*`、`/realtime/v1/*` 不查。
 * path 是去掉 /sb 前缀、不带查询串的路径；method 大写。
 */
export function needsVersionCheck(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'OPTIONS') return false;
  for (const r of EXEMPT_RULES) {
    const hit = r.match === 'exact' ? path === r.path : path.startsWith(r.path);
    if (hit && (r.method === '*' || r.method === m)) return false;
  }
  if (path.startsWith('/functions/v1/')) {
    const name = functionName(path);
    const ex = EXEMPT_FUNCTIONS.find((f) => f.name === name);
    return !(ex && methodHit(ex.methods, m));
  }
  if (path.startsWith('/rest/v1/') || path.startsWith('/storage/v1/')) return WRITE_METHODS.has(m);
  return false;
}

// ---------- 版本号 ----------

export type Triple = readonly [number, number, number];

const TRIPLE_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** 只看“主.次.修”三段，去掉 `-preview.N`、`+build` 这类后缀（8.5）。格式不对返回 null */
export function parseClientVersion(v: string | null | undefined): Triple | null {
  if (!v) return null;
  const core = v.trim().split(/[-+]/, 1)[0] ?? '';
  return parseStrict(core);
}

/** app_config.min_client_version 只认不带后缀的三段（和数据库约束 `^\d+\.\d+\.\d+$` 一致） */
export function parseStrict(v: string): Triple | null {
  const m = TRIPLE_RE.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareTriple(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------- 读配置（带缓存和超时） ----------

export interface GateOptions {
  /** 读 min_client_version 的原始值；失败就抛错。signal 超时会被中止 */
  loadMin: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  /** 只记错误码，不记 URL（14.2 第 8 点） */
  log?: (code: string) => void;
  timeoutMs?: number;
  okTtlMs?: number;
  failTtlMs?: number;
}

export type GateResult = { action: 'pass' } | { action: 'block'; min: string };

export interface VersionGate {
  check(method: string, path: string, headers: Headers): Promise<GateResult>;
  /** 测试用：当前缓存的最低版本（null 表示读失败、放行中） */
  peek(): { min: string | null; until: number } | null;
}

export function createVersionGate(opts: GateOptions): VersionGate {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 1500;
  const okTtl = opts.okTtlMs ?? 60_000;
  const failTtl = opts.failTtlMs ?? 10_000;

  let cache: { min: string | null; until: number } | null = null;
  let inflight: Promise<string | null> | null = null;

  async function loadOnce(): Promise<string | null> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('gate_config_timeout')); // 先定下超时，再中止请求
        ctl.abort();
      }, timeoutMs);
    });
    try {
      const raw = await Promise.race([opts.loadMin(ctl.signal), timeout]);
      if (typeof raw !== 'string' || !parseStrict(raw)) {
        log('gate_config_bad');
        cache = { min: null, until: now() + failTtl };
        return null;
      }
      cache = { min: raw, until: now() + okTtl };
      return raw;
    } catch (e) {
      log(e instanceof Error && e.message === 'gate_config_timeout' ? 'gate_config_timeout' : 'gate_config_error');
      cache = { min: null, until: now() + failTtl };
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function currentMin(): Promise<string | null> {
    if (cache && now() < cache.until) return cache.min;
    if (!inflight) inflight = loadOnce().finally(() => (inflight = null));
    return inflight;
  }

  return {
    async check(method, path, headers) {
      if (!needsVersionCheck(method, path)) return { action: 'pass' };
      const min = await currentMin();
      if (min === null) return { action: 'pass' }; // 读配置失败就放行，不因为配置出错把所有人挡在外面
      const minT = parseStrict(min);
      const client = parseClientVersion(headers.get(VERSION_HEADER));
      if (!minT) return { action: 'pass' };
      if (!client || compareTriple(client, minT) < 0) return { action: 'block', min };
      return { action: 'pass' };
    },
    peek: () => cache,
  };
}

/**
 * 本地生成的 426（不转发）。带 15.6 的安全头；CORS 由调用方经 decorate 加上
 * （转发层用 applyCors，退路 Worker 用同一个函数），不然 exe 读不到响应体。
 */
export function upgradeRequiredResponse(min: string, decorate?: (h: Headers) => void): Response {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  applySbSecurityHeaders(h);
  decorate?.(h);
  return new Response(JSON.stringify({ code: 'upgrade_required', min }), { status: 426, headers: h });
}
