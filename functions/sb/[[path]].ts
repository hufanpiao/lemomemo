// `/sb/*` 转发到 Supabase（架构 14.2 第 1～10 点，15.4 S-B0、S-B0b、S-B0c）。
// 去掉 /sb 前缀 → 路径白名单 → 写入先查版本 → 重写请求头 → 转发 → 重写 CORS、加安全头。
// 日志里不打印 URL（签名链接带 ?token=，14.2 第 8 点），也不打印请求头和请求体（A23）。

import { applyCors, isAllowedOrigin, preflightHeaders } from '../_lib/cors.ts';
import { applySbSecurityHeaders } from '../_lib/security-headers.ts';
import { gateFor, logCode } from '../_lib/gate.ts';
import { rawPathAndQuery } from '../_lib/raw-url.ts';
import { upgradeRequiredResponse, type VersionGate } from './version-gate.ts';

export interface SbEnv {
  /** 上游，例如 https://<ref>.supabase.co（预览环境指向预览项目，14.2 第 6 点） */
  SUPABASE_UPSTREAM: string;
  /** anon key（或 publishable key），version-gate 读 app_config 用 */
  SUPABASE_ANON_KEY: string;
  /** 和服务器函数共用的密钥；函数只在它正确时才信 x-client-ip、x-lemo-geo */
  PROXY_SECRET: string;
}

/** 存储唯一放行的前缀（0.32） */
export const STORAGE_ALLOWED_PREFIX = '/storage/v1/object/sign/vault-preview/';

/**
 * 允许转发的上游路径前缀（去掉 /sb 之后）。
 * 0.32（R-213，14.2 第 1 点）：存储只放行 vault-preview 的签名链接（给微软取隐私记 PPT 的临时明文），而且只许 GET；
 * 其余存储路径（上传、列目录、签名、其他桶）一律本地 404。照片和附件走 /files/v1/*。
 */
export const ALLOWED_PREFIXES: readonly string[] = ['/rest/v1/', '/auth/v1/', STORAGE_ALLOWED_PREFIX, '/functions/v1/', '/realtime/v1/'];

/** 白名单里也不放行的：管理接口；files_authorize 只给 /files 函数用（0.32，14.2 第 1 点） */
const DENIED_PREFIXES: readonly string[] = ['/auth/v1/admin', '/rest/v1/rpc/files_authorize'];
const DENIED_EXACT: readonly string[] = ['/rest/v1/'];

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);

/** 客户端传来的这些头一律先删（不能信，也不该带给上游） */
export const STRIPPED_REQUEST_HEADERS: readonly string[] = [
  'host',
  'cookie',
  'x-client-ip',
  'x-proxy-secret',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-lemo-geo',
  'x-region',
  'forwarded',
  'true-client-ip',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cdn-loop',
];

/** 函数固定在首尔运行（14.2 第 5 点） */
export const FUNCTION_REGION = 'ap-northeast-2';

/**
 * 路径允许的字符：**不含 `%`**（架构 0.33 第 10 条、14.2 第 1 点：路径里一律不许出现百分号编码，查询串不受影响）。
 * 理由：经 /sb 的合法路径（REST 表名和 rpc 名、Auth、函数名、Realtime、vault-preview 的随机文件名）都不含要编码的字符；
 * 拒绝名单按原始字符串比，`files%5Fauthorize`、`%61dmin` 这类上游解码后才露出原形的写法，全部拒掉比“先解码再比”少一处口径不一致。
 */
const PATH_CHARS_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/;
// 路径里出现这些也拒：点段、反斜杠（上一条已拦，留着防以后放宽字符表）、双斜杠
const SUSPICIOUS_PATH_RE = /\\|\/\/|(^|\/)\.\.?(\/|$)/;

/** 去掉 /sb 之后的路径是否落在白名单内、拒绝名单外（拒绝名单按小写比） */
function pathAllowed(p: string): boolean {
  if (!ALLOWED_PREFIXES.some((pre) => p.startsWith(pre))) return false;
  const lower = p.toLowerCase();
  return !DENIED_EXACT.includes(lower) && !DENIED_PREFIXES.some((pre) => lower.startsWith(pre));
}

/**
 * 从原始 URL 里取出 /sb 之后的路径；不合规返回 null。
 * 用原始字符串判断，不用 new URL().pathname（它会把 `..` 先规整掉，判断就晚了）。
 * 顺序：先查字符（有 `%` 就拒，在比白名单、拒绝名单之前）→ 点段、反斜杠、双斜杠 → 白名单、拒绝名单。
 * 转发给上游的是原始路径。
 */
export function upstreamPath(rawUrl: string): string | null {
  const parts = rawPathAndQuery(rawUrl);
  if (!parts) return null;
  const rawPath = parts.path;
  if (!rawPath.startsWith('/sb/') || !PATH_CHARS_RE.test(rawPath) || SUSPICIOUS_PATH_RE.test(rawPath)) return null;
  const p = rawPath.slice('/sb'.length);
  return pathAllowed(p) ? p : null;
}

/** x-lemo-geo 的格式：`<国家两位码>|<城市，encodeURIComponent>`，缺的写 `-`（服务器函数按这个解析） */
export function geoHeader(cf: { country?: unknown; city?: unknown } | undefined): string {
  const country = typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : '-';
  const city = typeof cf?.city === 'string' && cf.city ? encodeURIComponent(cf.city.slice(0, 64)) : '-';
  return `${country}|${city}`;
}

export interface SbDeps {
  fetch: (req: Request) => Promise<Response>;
  gate: VersionGate;
  /** 只记错误码 */
  log: (code: string) => void;
}

function localJson(status: number, code: string, origin: string | null): Response {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  applySbSecurityHeaders(h);
  applyCors(h, origin);
  return new Response(JSON.stringify({ code }), { status, headers: h });
}

export async function handleSb(
  request: Request,
  env: SbEnv,
  deps: SbDeps,
  cf?: { country?: unknown; city?: unknown },
): Promise<Response> {
  const origin = request.headers.get('Origin');
  const method = request.method.toUpperCase();

  if (!ALLOWED_METHODS.has(method)) return localJson(405, 'method_not_allowed', origin);

  // 预检直接回 204，不转发；Origin 不在白名单里就不带任何 CORS 头
  if (method === 'OPTIONS') {
    const h = preflightHeaders(isAllowedOrigin(origin) ? origin : null);
    applySbSecurityHeaders(h);
    return new Response(null, { status: 204, headers: h });
  }

  const path = upstreamPath(request.url);
  if (!path) return localJson(404, 'not_found', origin);

  if (!env.SUPABASE_UPSTREAM || !env.PROXY_SECRET) {
    deps.log('sb_misconfigured');
    return localJson(500, 'proxy_misconfigured', origin);
  }

  const base = new URL(env.SUPABASE_UPSTREAM);
  const target = new URL(path + new URL(request.url).search, base);
  // 拼完再核一次：不会请求别的主机（TC-B0-39）
  if (target.origin !== base.origin) return localJson(404, 'not_found', origin);

  // 存储只许 GET（vault-preview 的签名链接）；不转发
  if (path.startsWith('/storage/v1/') && method !== 'GET') return localJson(404, 'not_found', origin);

  const isWebSocket = (request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket';
  if (isWebSocket && !path.startsWith('/realtime/v1/')) return localJson(404, 'not_found', origin);

  if (!isWebSocket) {
    const verdict = await deps.gate.check(method, path, request.headers);
    if (verdict.action === 'block') return upgradeRequiredResponse(verdict.min, (h) => applyCors(h, origin));
  }

  // 请求头：先删后写（用 set，不用 append）
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('x-client-ip', clientIp);
  headers.set('x-proxy-secret', env.PROXY_SECRET);
  headers.set('x-lemo-geo', geoHeader(cf));
  if (path.startsWith('/functions/v1/')) headers.set('x-region', FUNCTION_REGION);

  // 方法、请求体原样；Host 由 fetch 按上游地址写
  const upstreamReq = new Request(new Request(target.toString(), request), { headers, redirect: 'manual' });

  let resp: Response;
  try {
    resp = await deps.fetch(upstreamReq);
  } catch {
    deps.log('sb_upstream_unreachable');
    return localJson(502, 'upstream_unreachable', origin);
  }

  // WebSocket 由 Workers 透传（14.2 第 1 点），101 响应原样返回
  if (isWebSocket) return resp;

  const out = new Headers(resp.headers);
  out.delete('set-cookie'); // 上游（含 Cloudflare 的 __cf_bm）的 cookie 不落到我们的域名上
  applyCors(out, origin);
  applySbSecurityHeaders(out);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
}

// ---------- Pages Functions 入口 ----------

export const onRequest: PagesFunction<SbEnv> = (ctx) =>
  handleSb(ctx.request, ctx.env, { fetch: (r) => fetch(r), gate: gateFor(ctx.env), log: logCode }, ctx.request.cf);
