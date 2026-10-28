// 照片和附件经同源的 /files/v1/*（架构 0.32；14.2 第 3、11 点；5.13 第 2、4 点；任务单 FA-2）
// - 只认 images、files 两个桶（vault-* 只经服务器函数）；没有删除、没有覆盖
// - 上传 PUT /files/v1/o/<桶>/<路径>：带 JWT 和 X-App-Version；409 exists 当成功（重试时对象已在）
// - 批量签名 POST /files/v1/sign：一次最多 100 项，超了自动分批；不过的项单独标出，不整批失败
// - 取字节 GET 签名链接：不带 JWT；先核对链接的来源和路径前缀（不只比字符串前缀，14.2 第 3 点）
// - 错误码映射成 data 层用的几类（FileErrorKind），界面文案由 data / ui 按类别取
// 业务代码只经功能的 data 层用本文件（1.3b；ESLint 分层规则拦 ui、hooks、kit、app）；对象存储本身（shared/objstore.ts、aws4fetch）
// App 一律引不到（check_arch 的 R2）
import { z } from 'zod';
import { buildInfo } from './env.ts';
import { withAppVersion } from './http.ts';

export const FILE_BUCKETS = ['images', 'files'] as const;
export type FileBucket = (typeof FILE_BUCKETS)[number];
export type SignPurpose = 'view' | 'download' | 'ms';

/** 一次签名请求最多几项（14.2 第 11 点；files_authorize 的 get 也是 100） */
export const SIGN_BATCH_MAX = 100;

/** 超时：上传按 10 MB 附件在慢网上留足；签名和取字节短一些 */
export const TIMEOUT_MS = { upload: 120_000, sign: 15_000, get: 60_000 } as const;

/**
 * data 层看的几类：
 * - retry：网络断、超时、429 rate_limited、503 try_later、其他 5xx——稍后重试（离线队列照常退避）
 * - too_big：413 too_large——“超过上限或空间满了”（5.13 第 2 点的三种原因之一）
 * - bad_type：415 bad_type——类型不对（含 webp 文件头不对）
 * - upgrade：426 upgrade_required——走升级提示（0.27 第 1 点），不重试
 * - auth：401 unauthorized——登录过期，刷新会话后再试一次，还不行回登录页
 * - account：账号停用或这台设备的会话已被吊销（account_disabled、session_revoked）——交给会话处理
 * - resign：取字节时 403 expired / bad_signature——重新签一次再取（换过 FILES_URL_SECRET 也会这样）
 * - denied：bad_path、forbidden（not_owner、not_pending、no_row…）、not_found、链接不对等——不重试
 */
export type FileErrorKind = 'retry' | 'too_big' | 'bad_type' | 'upgrade' | 'auth' | 'account' | 'resign' | 'denied';

export interface FileError {
  ok: false;
  kind: FileErrorKind;
  /** 服务器的错误码（14.2 第 11 点）；本地判断的：network、timeout、no_session、bad_path、bad_url、bad_response、bad_purpose */
  code: string;
  /** forbidden 带的 reason，或签名里单项不过的 reason */
  reason?: string;
  /** HTTP 状态；没发出去或没收到响应时是 0 */
  status: number;
}

export type UploadResult = { ok: true; etag: string | null; existed: boolean } | FileError;
export type SignResult = { ok: true; url: string; expiresAt: number } | FileError;
export type BlobResult = { ok: true; blob: Blob; contentType: string } | FileError;

export interface SignItem {
  bucket: FileBucket;
  path: string;
  purpose: SignPurpose;
  /** 下载时的文件名（调用方先 sanitizeFileName），在签名范围内 */
  d?: string;
}

export interface FilesDeps {
  /** /files/v1/ 的绝对地址，例如 https://lemomemo.com/files/v1/ */
  base: string;
  /** 当前会话的 access token；没登录回 null */
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  version?: string;
}

// ───────── 路径和链接的核对 ─────────

// 路径段：小写十六进制 uuid、anniv、带扩展名的文件名（images：<uid>/<note>/<id>(.t).webp、<uid>/anniv/<anniv>/<avatar>.webp；
// files：<uid>/<note>/<id>.<ext>、<id>.t.webp）。精确的正则在服务器（清单 pathPattern），这里只挡明显不对的
const SEGMENT = /^[0-9a-z][0-9a-z_-]*(\.[0-9a-z]+)*$/;

export function isFileBucket(b: string): b is FileBucket {
  return (FILE_BUCKETS as readonly string[]).includes(b);
}

/** 2～4 段、每段只有小写字母数字和 . _ -、不以点开头，没有 ..、%、\、空段 */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  const segs = path.split('/');
  return segs.length >= 2 && segs.length <= 4 && segs.every((s) => SEGMENT.test(s));
}

function baseUrl(base: string): URL {
  const u = new URL(base);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

/**
 * 核对签名链接：来源（scheme、主机、端口）等于本站；路径正好是 <base>o/<桶>/<路径>，桶和路径过 isSafePath；
 * 原文和解析结果逐字一致（挡 ..、百分号编码、反斜杠这类被 URL 解析器“规范化”掉的写法）；查询串只有 e、d、s，e 是数字。
 * expect 给了就要求桶和路径正好是这一项。通过时返回到期时刻（毫秒），否则 null
 */
export function checkSignedUrl(raw: string, base: string, expect?: { bucket: FileBucket; path: string }): number | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const b = baseUrl(base);
  if (u.origin !== b.origin || u.username !== '' || u.password !== '' || u.hash !== '') return null;
  const prefix = `${b.pathname}o/`;
  if (!u.pathname.startsWith(prefix)) return null;
  const rest = u.pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (slash <= 0 || !isFileBucket(bucket) || !isSafePath(path)) return null;
  if (expect && (expect.bucket !== bucket || expect.path !== path)) return null;
  const q = raw.indexOf('?');
  if (q < 0 || raw.slice(0, q) !== `${u.origin}${u.pathname}`) return null;
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => k !== 'e' && k !== 'd' && k !== 's') || new Set(keys).size !== keys.length) return null;
  const e = u.searchParams.get('e') ?? '';
  if (!/^\d{1,12}$/.test(e) || !u.searchParams.get('s')) return null;
  return Number(e) * 1000;
}

// ───────── 错误码 → 类别 ─────────

const ErrorBody = z.object({ code: z.string().min(1).max(64), reason: z.string().max(64).optional() });

const ACCOUNT_REASONS = new Set(['account_disabled', 'session_revoked']);

/** HTTP 状态 + 服务器错误码 → 类别（14.2 第 11 点的错误码表） */
export function classify(status: number, code: string, reason?: string): FileErrorKind {
  if (status === 0) return 'retry';
  if (code === 'rate_limited' || reason === 'rate_limited' || status === 429) return 'retry';
  if (code === 'try_later' || status === 408 || status >= 500) return 'retry';
  if (code === 'upgrade_required' || status === 426) return 'upgrade';
  if (code === 'too_large' || status === 413) return 'too_big';
  if (code === 'bad_type' || status === 415) return 'bad_type';
  if ((reason !== undefined && ACCOUNT_REASONS.has(reason)) || ACCOUNT_REASONS.has(code)) return 'account';
  if (code === 'unauthorized' || status === 401) return 'auth';
  if (code === 'expired' || code === 'bad_signature') return 'resign';
  return 'denied';
}

function fail(status: number, code: string, reason?: string): FileError {
  const e: FileError = { ok: false, kind: classify(status, code, reason), code, status };
  if (reason !== undefined) e.reason = reason;
  return e;
}

const local = (code: string): FileError => ({ ok: false, kind: code === 'no_session' ? 'auth' : 'denied', code, status: 0 });

const STATUS_CODE: Record<number, string> = {
  400: 'bad_path',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'exists',
  413: 'too_large',
  415: 'bad_type',
  426: 'upgrade_required',
  429: 'rate_limited',
  503: 'try_later',
};

async function failFromResponse(res: Response): Promise<FileError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 不是 JSON（例如 Cloudflare 的默认错误页）：按状态码算
  }
  const parsed = ErrorBody.safeParse(body);
  if (parsed.success) return fail(res.status, parsed.data.code, parsed.data.reason);
  return fail(res.status, STATUS_CODE[res.status] ?? `http_${res.status}`);
}

// ───────── 客户端 ─────────

const UploadOk = z.object({ etag: z.string().max(200).optional() });
const SignBody = z.object({
  items: z.array(
    z.union([
      z.object({ i: z.number().int().nonnegative(), ok: z.literal(true), url: z.string().max(4096) }),
      z.object({ i: z.number().int().nonnegative(), ok: z.literal(false), reason: z.string().min(1).max(64) }),
    ]),
  ),
});

export interface FilesClient {
  upload(bucket: FileBucket, path: string, blob: Blob, contentType: string): Promise<UploadResult>;
  sign(items: readonly SignItem[]): Promise<SignResult[]>;
  fetchBlob(url: string): Promise<BlobResult>;
}

export function createFilesClient(deps: FilesDeps): FilesClient {
  const base = baseUrl(deps.base);
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const objectUrl = (bucket: FileBucket, path: string) => new URL(`o/${bucket}/${path}`, base).toString();

  /** 发请求；网络错和超时折成 FileError */
  async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response | FileError> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: ctl.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    } catch {
      return { ok: false, kind: 'retry', code: ctl.signal.aborted ? 'timeout' : 'network', status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async function authHeaders(extra: Record<string, string>): Promise<Headers | FileError> {
    const token = await deps.getAccessToken().catch(() => null);
    if (!token) return local('no_session');
    return withAppVersion({ ...extra, Authorization: `Bearer ${token}` }, deps.version);
  }

  async function upload(bucket: FileBucket, path: string, blob: Blob, contentType: string): Promise<UploadResult> {
    if (!isFileBucket(bucket) || !isSafePath(path)) return local('bad_path');
    const headers = await authHeaders({ 'Content-Type': contentType });
    if (!(headers instanceof Headers)) return headers;
    const res = await send(objectUrl(bucket, path), { method: 'PUT', headers, body: blob }, TIMEOUT_MS.upload);
    if (!(res instanceof Response)) return res;
    const headerEtag = res.headers.get('ETag');
    if (res.status === 409) {
      const err = await failFromResponse(res);
      // 只有 exists 当成功：重试时对象已经在了（条件写保证不会被覆盖，内容由 file-check 核对）
      return err.code === 'exists' ? { ok: true, etag: headerEtag, existed: true } : err;
    }
    if (!res.ok) return failFromResponse(res);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // 成功但没有 JSON：用响应头的 ETag
    }
    const parsed = UploadOk.safeParse(body);
    return { ok: true, etag: (parsed.success ? parsed.data.etag : undefined) ?? headerEtag, existed: false };
  }

  /** 一批（≤ 100 项）；返回和这一批同序的结果 */
  async function signBatch(batch: readonly SignItem[]): Promise<SignResult[]> {
    const all = (e: FileError) => batch.map(() => e);
    const headers = await authHeaders({ 'Content-Type': 'application/json' });
    if (!(headers instanceof Headers)) return all(headers);
    const items = batch.map((x) => (x.d === undefined ? { bucket: x.bucket, path: x.path, purpose: x.purpose } : { ...x }));
    const res = await send(new URL('sign', base).toString(), { method: 'POST', headers, body: JSON.stringify({ items }) }, TIMEOUT_MS.sign);
    if (!(res instanceof Response)) return all(res);
    if (!res.ok) return all(await failFromResponse(res));
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // 落到下面的 bad_response
    }
    const parsed = SignBody.safeParse(body);
    if (!parsed.success) return all(local('bad_response'));
    const out: SignResult[] = all(local('bad_response'));
    for (const r of parsed.data.items) {
      const want = batch[r.i];
      if (!want) continue;
      if (!r.ok) {
        out[r.i] = fail(200, r.reason, r.reason);
        continue;
      }
      const expiresAt = checkSignedUrl(r.url, base.toString(), { bucket: want.bucket, path: want.path });
      out[r.i] = expiresAt === null ? local('bad_url') : { ok: true, url: r.url, expiresAt };
    }
    return out;
  }

  async function sign(items: readonly SignItem[]): Promise<SignResult[]> {
    const out: SignResult[] = new Array<SignResult>(items.length);
    const valid: number[] = [];
    items.forEach((x, i) => {
      if (!isFileBucket(x.bucket) || !isSafePath(x.path)) out[i] = local('bad_path');
      // ms（交给微软查看器）只给附件桶里的 .pptx（5.13 第 3 点）
      else if (x.purpose === 'ms' && !(x.bucket === 'files' && x.path.endsWith('.pptx'))) out[i] = local('bad_purpose');
      else valid.push(i);
    });
    // 分批按顺序发（不并发，少撞 files_get 每分钟 120 次的限流）
    for (let k = 0; k < valid.length; k += SIGN_BATCH_MAX) {
      const idx = valid.slice(k, k + SIGN_BATCH_MAX);
      const got = await signBatch(idx.map((i) => items[i] as SignItem));
      idx.forEach((i, j) => {
        out[i] = got[j] ?? local('bad_response');
      });
    }
    return out;
  }

  async function fetchBlob(url: string): Promise<BlobResult> {
    if (checkSignedUrl(url, base.toString()) === null) return local('bad_url');
    const res = await send(url, { method: 'GET' }, TIMEOUT_MS.get);
    if (!(res instanceof Response)) return res;
    if (!res.ok) return failFromResponse(res);
    try {
      const blob = await res.blob();
      return { ok: true, blob, contentType: res.headers.get('Content-Type') ?? blob.type };
    } catch {
      return { ok: false, kind: 'retry', code: 'network', status: 0 };
    }
  }

  return { upload, sign, fetchBlob };
}

// ───────── 默认实例 ─────────

/** /files/v1/ 的地址：和数据接口同一个来源（正式 https://lemomemo.com/sb → https://lemomemo.com/files/v1/；exe 里也是这个，跨域走 CORS） */
export function filesBaseFrom(supabaseUrl: string, fallbackOrigin: string): string {
  return new URL('/files/v1/', supabaseUrl || fallbackOrigin).toString();
}

async function sessionToken(): Promise<string | null> {
  const { getSupabase } = await import('./supabase/client.ts');
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

let defaultClient: FilesClient | null = null;
function client(): FilesClient {
  defaultClient ??= createFilesClient({ base: filesBaseFrom(buildInfo.supabaseUrl, location.origin), getAccessToken: sessionToken });
  return defaultClient;
}

export const upload: FilesClient['upload'] = (bucket, path, blob, contentType) => client().upload(bucket, path, blob, contentType);
export const sign: FilesClient['sign'] = (items) => client().sign(items);
export const fetchBlob: FilesClient['fetchBlob'] = (url) => client().fetchBlob(url);
