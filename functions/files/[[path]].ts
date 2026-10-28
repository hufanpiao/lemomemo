// `/files/v1/*`：照片和附件的上传、批量签链接、按签名链接取对象（架构 0.32、14.2 第 11 点、3.3 G“R2 起”；任务单 FB-3）。
// 不是转发，是自己的接口；后面是 R2，经 shared/objstore.ts 的 S3 接口（令牌 R2_FILES_*，只授 images、files 两个桶），不用 R2 绑定（0.32 第 4 条）。
//   PUT  /files/v1/o/<桶>/<路径>   要 JWT 和 X-App-Version；规则表 → files_authorize('put') → 大小、类型、webp 文件头 → 条件写
//   POST /files/v1/sign            要 JWT；最多 100 项；files_authorize('get') 过了的逐项签 HMAC 链接
//   GET  /files/v1/o/<桶>/<路径>?e=&d=&s=   不要 JWT；验签名和到期 → 从 R2 流式返回
// 没有删除、没有覆盖。日志只记错误码和耗时，不记 URL、查询串、路径、请求头（14.2 第 8 点）。
// 错误体一律 {code, reason?}（和 /sb 本地错误一样；src/platform/files.ts 按它解析）。

import { createObjStore, ObjStoreError, type ObjStore } from '../../shared/objstore.ts';
import { applyCors, isAllowedOrigin, preflightHeaders } from '../_lib/cors.ts';
import { filesAuthorize } from '../_lib/files-authorize.ts';
import { authzConfig, bearerOf, err, json, MAX_NAME_INPUT, PATH_RE, secretOk, SUSPICIOUS_RE, type FilesDeps, type FilesEnv } from '../_lib/files-http.ts';
import { isClientBucket, matchPath, TTL } from '../_lib/files-rules.ts';
import { handleSign } from '../_lib/files-sign-route.ts';
import { contentDisposition, verify } from '../_lib/files-sign.ts';
import { prepareUpload } from '../_lib/files-upload.ts';
import { gateFor } from '../_lib/gate.ts';
import { applyFilesSecurityHeaders } from '../_lib/security-headers.ts';
import { upgradeRequiredResponse } from '../sb/version-gate.ts';

export type { FilesDeps, FilesEnv } from '../_lib/files-http.ts';

type Route = { kind: 'object'; bucket: string; path: string; query: string } | { kind: 'sign' } | null;

/** 从原始 URL 取路由；不合规返回 null（回 404） */
export function parseRoute(rawUrl: string): Route {
  const schemeEnd = rawUrl.indexOf('//');
  const pathStart = schemeEnd < 0 ? -1 : rawUrl.indexOf('/', schemeEnd + 2);
  if (pathStart < 0) return null;
  const rest = rawUrl.slice(pathStart);
  const hash = rest.indexOf('#');
  const noHash = hash < 0 ? rest : rest.slice(0, hash);
  const q = noHash.indexOf('?');
  const rawPath = q < 0 ? noHash : noHash.slice(0, q);
  const query = q < 0 ? '' : noHash.slice(q + 1);
  if (rawPath === '/files/v1/sign') return { kind: 'sign' };
  const pre = '/files/v1/o/';
  if (!rawPath.startsWith(pre)) return null;
  const tail = rawPath.slice(pre.length);
  const slash = tail.indexOf('/');
  if (slash <= 0) return null;
  const bucket = tail.slice(0, slash);
  const path = tail.slice(slash + 1);
  if (!/^[a-z0-9-]{1,63}$/.test(bucket) || !PATH_RE.test(path) || SUSPICIOUS_RE.test(path) || path.length > 512) return null;
  return { kind: 'object', bucket, path, query };
}

// ---------- PUT ----------

async function handlePut(request: Request, env: FilesEnv, deps: FilesDeps, bucket: string, path: string, origin: string | null): Promise<[Response, string]> {
  if (!env.SUPABASE_UPSTREAM) return [err(500, 'files_misconfigured', origin), 'put_misconfigured'];
  const verdict = await deps.gate.check('PUT', `/files/v1/o/${bucket}/${path}`, request.headers);
  if (verdict.action === 'block') return [upgradeRequiredResponse(verdict.min, (h) => { applyFilesSecurityHeaders(h); applyCors(h, origin); }), 'put_upgrade_required'];
  const bearer = bearerOf(request);
  if (!bearer) return [err(401, 'unauthorized', origin), 'put_unauthorized'];
  if (!isClientBucket(bucket)) return [err(403, 'forbidden', origin, 'bad_bucket'), 'put_bad_bucket'];
  const m = matchPath(bucket, path);
  if (!m) return [err(400, 'bad_path', origin), 'put_bad_path'];

  // 便宜的检查放在调数据库之前（规则表本来就公开，先查不泄露什么）
  const ct = (request.headers.get('Content-Type') ?? '').trim().toLowerCase();
  if (ct !== m.variant.contentType.toLowerCase()) return [err(415, 'bad_type', origin), 'put_bad_type'];
  const clRaw = request.headers.get('Content-Length');
  if (clRaw === null) return [err(411, 'length_required', origin), 'put_length_required'];
  if (!/^\d{1,12}$/.test(clRaw)) return [err(400, 'bad_request', origin), 'put_bad_length'];
  const declared = Number(clRaw);
  if (declared > m.variant.maxBytes) return [err(413, 'too_large', origin), 'put_too_large'];
  if (declared === 0 || !request.body) return [err(400, 'bad_request', origin), 'put_empty'];
  if (m.variant.webp && declared < 12) return [err(415, 'bad_type', origin), 'put_bad_type'];

  const authz = await filesAuthorize(
    authzConfig(env, deps),
    bearer,
    'put',
    [{ bucket, path }],
  );
  if (authz.kind === 'error') return [err(authz.status, authz.code, origin, authz.reason), authz.log];
  const item = authz.items[0];
  if (!item?.ok) {
    // 后端 BE-2 的映射：bad_bucket、bad_path → 400 bad_path；其余 403 forbidden 带 reason
    const why = item?.reason ?? 'denied';
    if (why === 'bad_bucket' || why === 'bad_path') return [err(400, 'bad_path', origin), 'put_rpc_bad_path'];
    return [err(403, 'forbidden', origin, why), 'put_denied'];
  }
  // 写 R2 前再断言：路径第一段等于 files_authorize 返回的 uid
  if (m.owner !== authz.uid) return [err(403, 'forbidden', origin, 'not_owner'), 'put_uid_mismatch'];

  const prep = await prepareUpload(request.body, declared, { webp: m.variant.webp, fixedLength: deps.fixedLength });
  if (!prep.ok) return [err(prep.status, prep.code, origin), `put_${prep.code}`];
  try {
    const r = await deps.store.put(bucket, path, prep.body, { contentType: m.variant.contentType, ifNoneMatch: true });
    const extra: Record<string, string> = r.etag ? { ETag: r.etag } : {};
    return [json(200, { etag: r.etag }, origin, extra), 'put_ok'];
  } catch (e) {
    if (prep.state.overflow) return [err(413, 'too_large', origin), 'put_too_large'];
    if (prep.state.short) return [err(400, 'bad_request', origin), 'put_short'];
    if (e instanceof ObjStoreError && e.code === 'exists') return [err(409, 'exists', origin), 'put_exists'];
    return [err(503, 'try_later', origin), e instanceof ObjStoreError ? `put_${e.message}` : 'put_store_error'];
  }
}

// ---------- GET ----------

function parseQuery(query: string): { e: string; d: string; s: string } | null {
  if (!query) return null;
  const seen = new Map<string, string>();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    if (k !== 'e' && k !== 'd' && k !== 's') return null;
    if (seen.has(k)) return null;
    try {
      seen.set(k, decodeURIComponent((eq < 0 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' ')));
    } catch {
      return null;
    }
  }
  const e = seen.get('e');
  const s = seen.get('s');
  if (e === undefined || s === undefined) return null;
  return { e, d: seen.get('d') ?? '', s };
}

async function handleGet(env: FilesEnv, deps: FilesDeps, bucket: string, path: string, query: string, origin: string | null): Promise<[Response, string]> {
  if (!secretOk(env)) return [err(500, 'files_misconfigured', origin), 'get_misconfigured'];
  const q = parseQuery(query);
  if (!q || !/^\d{1,12}$/.test(q.e) || q.d.length > MAX_NAME_INPUT * 4) return [err(403, 'bad_signature', origin), 'get_bad_signature'];
  const e = Number(q.e);
  if (!(await verify(env.FILES_URL_SECRET, bucket, path, e, q.d, q.s))) return [err(403, 'bad_signature', origin), 'get_bad_signature'];
  const nowS = Math.floor(deps.now() / 1000);
  if (nowS > e) return [err(403, 'expired', origin), 'get_expired'];
  // 签名对但有效期超过硬上限：不是我们签出来的（或者密钥泄露），一律拒
  if (e - nowS > TTL.max) return [err(403, 'bad_signature', origin), 'get_ttl_over_max'];
  const m = isClientBucket(bucket) ? matchPath(bucket, path) : null;
  if (!m) return [err(404, 'not_found', origin), 'get_bad_path'];

  let obj;
  try {
    obj = await deps.store.get(bucket, path);
  } catch (x) {
    return [err(503, 'try_later', origin), x instanceof ObjStoreError ? `get_${x.message}` : 'get_store_error'];
  }
  if (!obj) return [err(404, 'not_found', origin), 'get_not_found'];
  const h = new Headers({ 'Content-Type': obj.contentType ?? 'application/octet-stream' });
  if (obj.contentLength !== null) h.set('Content-Length', String(obj.contentLength));
  if (obj.etag) h.set('ETag', obj.etag);
  if (q.d) h.set('Content-Disposition', contentDisposition(q.d));
  applyFilesSecurityHeaders(h);
  applyCors(h, origin);
  return [new Response(obj.body as ReadableStream<Uint8Array>, { status: 200, headers: h }), 'get_ok'];
}

// ---------- 入口 ----------

export async function handleFiles(request: Request, env: FilesEnv, deps: FilesDeps): Promise<Response> {
  const t0 = deps.now();
  const origin = request.headers.get('Origin');
  const method = request.method.toUpperCase();
  let res: Response;
  let code: string;
  if (method === 'OPTIONS') {
    const h = preflightHeaders(isAllowedOrigin(origin) ? origin : null);
    applyFilesSecurityHeaders(h);
    return new Response(null, { status: 204, headers: h });
  }
  const route = parseRoute(request.url);
  if (!route) {
    [res, code] = [err(404, 'not_found', origin), 'files_not_found'];
  } else if (route.kind === 'sign') {
    [res, code] = method === 'POST' ? await handleSign(request, env, deps, origin) : [err(405, 'method_not_allowed', origin), 'sign_method'];
  } else if (method === 'PUT') {
    [res, code] = await handlePut(request, env, deps, route.bucket, route.path, origin);
  } else if (method === 'GET') {
    [res, code] = await handleGet(env, deps, route.bucket, route.path, route.query, origin);
  } else {
    // 没有 DELETE，没有 HEAD、POST（只认 GET 取对象、PUT 上传）
    [res, code] = [err(405, 'method_not_allowed', origin), 'object_method'];
  }
  if (res.status === 405) res.headers.set('Allow', route?.kind === 'sign' ? 'POST, OPTIONS' : 'GET, PUT, OPTIONS');
  deps.log(code, deps.now() - t0);
  return res;
}

// ---------- Pages Functions 入口 ----------

let storeCache: { key: string; store: ObjStore } | null = null;

function storeFor(env: FilesEnv): ObjStore {
  const key = [env.R2_ENDPOINT, env.R2_BUCKET_PREFIX ?? '', env.R2_REGION ?? '', env.R2_FILES_ACCESS_KEY_ID, env.R2_FILES_SECRET_ACCESS_KEY].join('\n');
  if (storeCache?.key === key) return storeCache.store;
  const store = createObjStore({
    endpoint: env.R2_ENDPOINT,
    accessKeyId: env.R2_FILES_ACCESS_KEY_ID,
    secretAccessKey: env.R2_FILES_SECRET_ACCESS_KEY,
    bucketPrefix: env.R2_BUCKET_PREFIX ?? '',
    ...(env.R2_REGION ? { region: env.R2_REGION } : {}),
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
  });
  storeCache = { key, store };
  return store;
}

function logFiles(code: string, ms: number): void {
  console.log(JSON.stringify({ evt: code, ms }));
}

export const onRequest: PagesFunction<FilesEnv> = async (ctx) => {
  const env = ctx.env;
  if (!env.R2_ENDPOINT || !env.R2_FILES_ACCESS_KEY_ID || !env.R2_FILES_SECRET_ACCESS_KEY) {
    logFiles('files_misconfigured', 0);
    const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    applyFilesSecurityHeaders(h);
    applyCors(h, ctx.request.headers.get('Origin'));
    return new Response(JSON.stringify({ code: 'files_misconfigured' }), { status: 500, headers: h });
  }
  let store: ObjStore;
  try {
    store = storeFor(env);
  } catch {
    logFiles('files_misconfigured', 0);
    return new Response(JSON.stringify({ code: 'files_misconfigured' }), { status: 500 });
  }
  return handleFiles(ctx.request, env, {
    fetch: (r) => fetch(r),
    store,
    gate: gateFor(env),
    now: () => Date.now(),
    log: logFiles,
    fixedLength: (n) => new FixedLengthStream(n),
  });
};
