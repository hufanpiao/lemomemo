// `/sb/*` 和 `/files/*`（0.32）的 CORS（架构 5.10）：只给 exe 的来源，网页版同源不需要。
// 这不是身份校验（5.10 第三轮安全 X6）：所有 Tauri 应用在 Windows 上都是这个来源。

/** exe 的来源，精确比对，不用通配符。开了 useHttpsScheme 就要改成 https，两者只能选一个（B6 核实） */
export const EXE_ORIGIN = 'http://tauri.localhost';

/** /sb/* 的预检（转发 PostgREST、Auth 等，要 PATCH、DELETE） */
export const ALLOW_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';

/** /files/* 的预检：只给实际支持的方法（GET 取对象、PUT 上传、POST sign；没有删除）。安全审查低 4 ② */
export const FILES_ALLOW_METHODS = 'GET, PUT, POST, OPTIONS';

/** 允许的请求头（5.10 的表）。以 B0 锁定版本的 supabase-js 在 B6 抓包为准，抓到新的就补进这里和架构 */
export const ALLOW_HEADERS: readonly string[] = [
  // 通用
  'authorization',
  'apikey',
  'content-type',
  'x-client-info',
  // auth-js
  'x-supabase-api-version',
  // PostgREST
  'prefer',
  'range',
  'accept-profile',
  'content-profile',
  // storage-js 上传
  'x-upsert',
  'cache-control',
  // 我们自己的
  'x-app-version',
  'x-now',
  'x-tz',
  'x-locale',
  'x-vault-token',
];

/** 暴露的响应头：时钟偏差读 Date，计数和分页读 Content-Range（5.10）；/files 上传回的 ETag（0.32，14.2 第 11 点） */
export const EXPOSE_HEADERS: readonly string[] = ['Date', 'Content-Range', 'Content-Length', 'X-Supabase-Api-Version', 'ETag'];

export function isAllowedOrigin(origin: string | null): boolean {
  return origin === EXE_ORIGIN;
}

/**
 * 先删掉上游自己带的 Access-Control-*（避免出现 `*`），再按白名单重写。
 * Origin 不在白名单里就不返回任何 CORS 头。
 */
export function applyCors(h: Headers, origin: string | null): void {
  for (const name of [...h.keys()]) {
    if (name.toLowerCase().startsWith('access-control-')) h.delete(name);
  }
  appendVary(h, 'Origin');
  if (!isAllowedOrigin(origin)) return;
  h.set('Access-Control-Allow-Origin', EXE_ORIGIN);
  h.set('Access-Control-Expose-Headers', EXPOSE_HEADERS.join(', '));
  // 不带 Allow-Credentials：登录令牌走 Authorization 头，不用 cookie
}

/** 预检由我们直接回 204，不转发给 Supabase；methods 默认 /sb 的那一套 */
export function preflightHeaders(origin: string | null, methods: string = ALLOW_METHODS): Headers {
  const h = new Headers();
  appendVary(h, 'Origin');
  if (!isAllowedOrigin(origin)) return h;
  h.set('Access-Control-Allow-Origin', EXE_ORIGIN);
  h.set('Access-Control-Allow-Methods', methods);
  h.set('Access-Control-Allow-Headers', ALLOW_HEADERS.join(', '));
  h.set('Access-Control-Max-Age', '600');
  return h;
}

function appendVary(h: Headers, value: string): void {
  const cur = h.get('Vary');
  if (!cur) {
    h.set('Vary', value);
    return;
  }
  const parts = cur.split(',').map((s) => s.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase()) && !parts.includes('*')) h.set('Vary', `${cur}, ${value}`);
}
