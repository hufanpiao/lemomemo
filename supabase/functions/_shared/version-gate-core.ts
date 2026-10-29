// 函数侧版本门的逻辑（架构第 6 节“所有函数都检查 X-App-Version”、0.27 第 1 点、14.2 第 10 点；0.38 第 47 条）。
// 第二道检查：防止有人绕过 /sb 直连 <ref>.supabase.co/functions/v1/…。口径和转发层 functions/sb/version-gate.ts 一字不差：
//   • 版本号只看“主.次.修”，去掉 -preview.N、+build 后缀；没带头或格式不对算太旧；
//   • 太旧回 426，响应体 {"code":"upgrade_required","min":"<min_client_version>"}；
//   • min_client_version 读失败、超时（1.5 秒）、读到的不是三段数字：放行，失败结果缓存 10 秒；读成功缓存 60 秒
//     （架构 0.27 第 1 点：“不因为配置出错把所有人挡在外面”；第 6 节说函数里的检查“留作第二道”，同一口径）；
//   • OPTIONS 不查；免查名单（shared/version-gate-list.ts）里的函数和方法不查。
// 这一份不 import 名单（名单在 _shared/gen/，单测不跑 copy:shared）：名单由调用方传进来，入口见 _shared/version-gate.ts。
// 不 import npm 包、不碰 Deno 全局；日志只记错误码（A23）。tests/functions/fn-version-gate.test.ts 核对和转发层结论一致。

export const VERSION_HEADER = 'x-app-version';

export type Triple = readonly [number, number, number];

/** 免查名单的一项（结构和 shared/version-gate-list.ts 的 FunctionExemption 兼容） */
export interface Exemption {
  name: string;
  methods: readonly string[];
}

/** 读 app_config.min_client_version 的原始值；读不到返回 null，出错就抛。signal 超时会被中止 */
export type LoadMin = (signal: AbortSignal) => Promise<unknown>;

const TRIPLE_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** app_config.min_client_version 只认不带后缀的三段（和数据库约束 `^\d+\.\d+\.\d+$` 一致） */
export function parseStrict(v: string): Triple | null {
  const m = TRIPLE_RE.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 客户端版本：去掉 -preview.N、+build 后缀只比三段；格式不对返回 null */
export function parseClientVersion(v: string | null | undefined): Triple | null {
  if (!v) return null;
  const core = v.trim().split(/[-+]/, 1)[0] ?? '';
  return parseStrict(core);
}

export function compareTriple(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 只比版本，不读配置：min 是读到的 min_client_version（null、不是字符串、格式不对都放行）。
 * 要挡就返回 min 原文，放行返回 null。invite-signup 这类自己读配置的函数直接用它。
 */
export function blockedMin(min: unknown, clientHeader: string | null): string | null {
  if (typeof min !== 'string') return null;
  const minT = parseStrict(min);
  if (!minT) return null;
  const client = parseClientVersion(clientHeader);
  return !client || compareTriple(client, minT) < 0 ? min : null;
}

/** fn 的 method 请求要不要查：OPTIONS 不查；名单里列了这个方法（或 '*'）的不查；其余一律查 */
export function fnNeedsVersionCheck(exemptions: readonly Exemption[], fn: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === 'OPTIONS') return false;
  const ex = exemptions.find((f) => f.name === fn);
  return !(ex !== undefined && (ex.methods.includes('*') || ex.methods.includes(m)));
}

/** 本地生成的 426：和转发层同一个状态码、响应体、Content-Type、Cache-Control，另带 /sb 的三个安全头（经 /sb 时转发层会再覆盖一遍） */
export function upgradeRequiredResponse(min: string): Response {
  return new Response(JSON.stringify({ code: 'upgrade_required', min }), {
    status: 426,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'referrer-policy': 'no-referrer',
    },
  });
}

export interface FnGateOptions {
  exemptions: readonly Exemption[];
  now?: () => number;
  /** 只记错误码：gate_config_timeout、gate_config_error、gate_config_bad */
  log?: (code: string) => void;
  timeoutMs?: number;
  okTtlMs?: number;
  failTtlMs?: number;
}

export interface FnVersionGate {
  /** 要挡就返回 426 响应，放行返回 null。免查的请求不读配置 */
  check(fn: string, req: Request, loadMin: LoadMin): Promise<Response | null>;
  /**
   * 只取 min_client_version（同一份缓存、超时和失败处理）：读失败、超时、格式不对返回 null（= 放行）。
   * 给 invite-signup 这类在 core.ts 里自己比版本（blockedMin）的函数用（架构 0.38 第 52 条）
   */
  minClientVersion(loadMin: LoadMin): Promise<string | null>;
  /** 测试用：当前缓存（min 为 null 表示读失败、放行中） */
  peek(): { min: string | null; until: number } | null;
}

/** 带缓存的版本门（每个函数实例一份缓存；同一时刻只读一次配置） */
export function createFnVersionGate(opts: FnGateOptions): FnVersionGate {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 1500;
  const okTtl = opts.okTtlMs ?? 60_000;
  const failTtl = opts.failTtlMs ?? 10_000;

  let cache: { min: string | null; until: number } | null = null;
  let inflight: Promise<string | null> | null = null;

  async function loadOnce(loadMin: LoadMin): Promise<string | null> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('gate_config_timeout'));
        ctl.abort();
      }, timeoutMs);
    });
    try {
      const raw = await Promise.race([loadMin(ctl.signal), timeout]);
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

  async function currentMin(loadMin: LoadMin): Promise<string | null> {
    if (cache && now() < cache.until) return cache.min;
    if (!inflight) inflight = loadOnce(loadMin).finally(() => (inflight = null));
    return inflight;
  }

  return {
    async check(fn, req, loadMin) {
      if (!fnNeedsVersionCheck(opts.exemptions, fn, req.method)) return null;
      const min = await currentMin(loadMin);   // 读失败就放行（同转发层）
      const blocked = blockedMin(min, req.headers.get(VERSION_HEADER));
      return blocked === null ? null : upgradeRequiredResponse(blocked);
    },
    minClientVersion: (loadMin) => currentMin(loadMin),
    peek: () => cache,
  };
}
