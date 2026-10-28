// POST /files/v1/sign：批量签 HMAC 签名（架构 14.2 第 11 点；任务单 FB-3；B1 P-files-sig）。要 JWT；最多 100 项、请求体最多 64 KB；
// 先本地按规则表逐项核对，再一次 files_authorize('get')；某一项不过只影响这一项。
// 回的每一项：view、download → {url（不带查询串）, sig（放进请求头 X-Files-Sig 的值）, e}；ms → {url（签名在查询串里）, e}。
import { filesAuthorize, type AuthzItem } from './files-authorize.ts';
import { authzConfig, bearerOf, err, json, MAX_NAME_INPUT, PATH_RE, secretOk, SUSPICIOUS_RE, type FilesDeps, type FilesEnv } from './files-http.ts';
import { isClientBucket, matchPath, ttlFor, TTL, type FilesBucket, type MatchedPath, type Purpose } from './files-rules.ts';
import { msUrl, objectUrl, sanitizeFilename, sigHeaderValue, sign } from './files-sign.ts';
import { concat } from './files-upload.ts';

const MAX_SIGN_ITEMS = 100;
const MAX_SIGN_BODY = 64 * 1024;
const PURPOSES: readonly Purpose[] = ['view', 'download', 'ms'];

interface SignReq {
  bucket: FilesBucket;
  path: string;
  purpose: Purpose;
  d: string;
  m: MatchedPath;
  ttl: number;
}

async function readLimited(request: Request, max: number): Promise<string | null> {
  const cl = request.headers.get('Content-Length');
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > max)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(concat(chunks, n));
  } catch {
    return null;
  }
}

export async function handleSign(request: Request, env: FilesEnv, deps: FilesDeps, origin: string | null): Promise<[Response, string]> {
  if (!env.SUPABASE_UPSTREAM || !secretOk(env)) return [err(500, 'files_misconfigured', origin), 'sign_misconfigured'];
  const bearer = bearerOf(request);
  if (!bearer) return [err(401, 'unauthorized', origin), 'sign_unauthorized'];
  const text = await readLimited(request, MAX_SIGN_BODY);
  let body: unknown = null;
  try {
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const items = body && typeof body === 'object' ? (body as { items?: unknown }).items : null;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_SIGN_ITEMS) return [err(400, 'bad_request', origin), 'sign_bad_request'];

  const out: Record<string, unknown>[] = new Array(items.length);
  const valid: { i: number; r: SignReq }[] = [];
  items.forEach((raw: unknown, i) => {
    const it = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const { bucket, path, purpose, d } = it;
    if (typeof bucket !== 'string' || typeof path !== 'string' || typeof purpose !== 'string') {
      out[i] = { i, ok: false, reason: 'bad_request' };
      return;
    }
    if (!isClientBucket(bucket)) {
      out[i] = { i, ok: false, reason: 'bad_bucket' };
      return;
    }
    const m = PATH_RE.test(path) && !SUSPICIOUS_RE.test(path) ? matchPath(bucket, path) : null;
    if (!m) {
      out[i] = { i, ok: false, reason: 'bad_path' };
      return;
    }
    if (!(PURPOSES as readonly string[]).includes(purpose) || (d !== undefined && (typeof d !== 'string' || d.length > MAX_NAME_INPUT))) {
      out[i] = { i, ok: false, reason: 'bad_purpose' };
      return;
    }
    const ttl = ttlFor(m, purpose as Purpose);
    if (ttl === null) {
      out[i] = { i, ok: false, reason: 'bad_purpose' };
      return;
    }
    // 文件名只给 download（attachment）；没给就用路径最后一段
    const name = purpose === 'download' ? sanitizeFilename(typeof d === 'string' && d ? d : path.slice(path.lastIndexOf('/') + 1)) : '';
    valid.push({ i, r: { bucket, path, purpose: purpose as Purpose, d: name, m, ttl } });
  });

  if (valid.length > 0) {
    const authz = await filesAuthorize(
      authzConfig(env, deps),
      bearer,
      'get',
      valid.map(({ r }): AuthzItem => ({ bucket: r.bucket, path: r.path })),
    );
    if (authz.kind === 'error') return [err(authz.status, authz.code, origin, authz.reason), authz.log];
    const origin0 = new URL(request.url).origin;
    const nowS = Math.floor(deps.now() / 1000);
    for (const res of authz.items) {
      const v = valid[res.i];
      if (!v) continue;
      if (!res.ok) {
        out[v.i] = { i: v.i, ok: false, reason: res.reason ?? 'denied' };
        continue;
      }
      if (v.r.m.owner !== authz.uid) {
        out[v.i] = { i: v.i, ok: false, reason: 'not_owner' };
        continue;
      }
      const e = nowS + Math.min(v.r.ttl, TTL.max);
      const s = await sign(env.FILES_URL_SECRET, v.r.purpose, v.r.bucket, v.r.path, e, v.r.d);
      out[v.i] =
        v.r.purpose === 'ms'
          ? { i: v.i, ok: true, url: msUrl(origin0, v.r.bucket, v.r.path, e, s), e }
          : { i: v.i, ok: true, url: objectUrl(origin0, v.r.bucket, v.r.path), sig: sigHeaderValue(v.r.purpose, e, v.r.d, s), e };
    }
  }
  for (let i = 0; i < out.length; i++) out[i] ??= { i, ok: false, reason: 'denied' };
  return [json(200, { items: out }, origin), 'sign_ok'];
}
