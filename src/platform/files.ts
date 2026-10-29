// 照片和附件经同源的 /files/v1/*（架构 0.32；14.2 第 3、11 点；5.13 第 2、4 点；任务单 FA-2）
// - 只认 images、files 两个桶（vault-* 只经服务器函数）；没有删除、没有覆盖
// - 上传 PUT /files/v1/o/<桶>/<路径>：带 JWT 和 X-App-Version；409 exists 当成功（重试时对象已在）；
//   403 not_pending 单独报出（kind not_pending，架构 0.33 第 5 条），不并进 denied、不重传
// - 批量签名 POST /files/v1/sign：一次最多 100 项，超了自动分批；不过的项单独标出，不整批失败
// - 取字节 GET 对象地址：不带 JWT，签名放请求头 X-Files-Sig（URL 不带查询串；B1 P-files-sig：Cloudflare 实时日志会显示查询串）；
//   先核对地址的来源和路径前缀（不只比字符串前缀，14.2 第 3 点）。只有 ms（给微软查看器的 .pptx）的签名在查询串里
// - 错误码映射成 data 层用的几类（FileErrorKind），界面文案由 data / ui 按类别取
// 业务代码只经功能的 data 层用本文件（1.3b；ESLint 分层规则拦 ui、hooks、kit、app）；对象存储本身（shared/objstore.ts、aws4fetch）
// App 一律引不到（check_arch 的 R2）
import { z } from 'zod';
import { exitForDisabled, type DisabledExitOptions } from './account-status.ts';
import { buildInfo } from './env.ts';
import { withAppVersion } from './http.ts';
import type { ExitNotice } from './session.ts';

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
 * - account：账号停用或这台设备的会话已被吊销（account_disabled、session_revoked）——交给会话处理；退出原因用 accountExitOf 定
 *   （account_disabled 先探测分清停用和冷静期，R-256 ③，和 sync-wiring 同一份）
 * - resign：取字节时 403 expired / bad_signature——重新签一次再取（换过 FILES_URL_SECRET 也会这样）
 * - not_pending：上传时 403 forbidden / not_pending（架构 0.33 第 5 条，5.13 第 2 点）——这一行已经不在 pending
 *   （file-check 判过了，或行已删）。**不是上传失败**：不重传、不按出错提示；data 层读这一行的 check_status：
 *   ok → 当成功、不再调 file-check；rejected → 按“没能加上”显示；行已删 → 丢掉。只有 upload 会给出这一类
 * - denied：bad_path、forbidden（not_owner、no_row…）、not_found、链接不对等——不重试
 */
export type FileErrorKind = 'retry' | 'too_big' | 'bad_type' | 'upgrade' | 'auth' | 'account' | 'resign' | 'not_pending' | 'denied';

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
/**
 * view、download：url 不带查询串，sig 是请求头 X-Files-Sig 的值，用 fetchBlob({url, sig}) 取；
 * ms：url 带签名查询串（交给微软查看器），sig 是 null
 */
export type SignResult = { ok: true; url: string; sig: string | null; expiresAt: number } | FileError;
export type BlobResult = { ok: true; blob: Blob; contentType: string } | FileError;

/** fetchBlob 的参数：sign 回的 view、download 那一项（url + sig） */
export interface SignedLink {
  url: string;
  sig: string;
}

/** 放签名的请求头（服务器 functions/_lib/files-sign.ts 的 SIG_HEADER；CORS 已放行） */
export const SIG_HEADER = 'X-Files-Sig';

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

type Expect = { bucket: FileBucket; path: string };

/**
 * 核对地址的来源和路径（view、download 不带查询串，ms 只许 e、s）：来源（scheme、主机、端口）等于本站；
 * 路径正好是 <base>o/<桶>/<路径>，桶和路径过 isSafePath；原文和解析结果逐字一致（挡 ..、百分号编码、反斜杠这类被 URL 解析器“规范化”掉的写法）。
 * expect 给了就要求桶和路径正好是这一项。通过时返回解析结果，否则 null
 */
function checkObjectPart(raw: string, base: string, withQuery: boolean, expect?: Expect): URL | null {
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
  if (!withQuery) return q < 0 && raw === `${u.origin}${u.pathname}` ? u : null;
  if (q < 0 || raw.slice(0, q) !== `${u.origin}${u.pathname}`) return null;
  return u;
}

/** view、download 的对象地址：同上，且没有查询串 */
export function checkObjectUrl(raw: string, base: string, expect?: Expect): boolean {
  return checkObjectPart(raw, base, false, expect) !== null;
}

/** `k=v&…` 只许 keys 里的键、不重复，e 是数字、s 不空；通过时返回各键的值 */
function sigPairs(raw: string, keys: readonly string[]): URLSearchParams | null {
  const q = new URLSearchParams(raw);
  const got = [...q.keys()];
  if (got.some((k) => !keys.includes(k)) || new Set(got).size !== got.length) return null;
  return /^\d{1,12}$/.test(q.get('e') ?? '') && q.get('s') ? q : null;
}

/** ms 的签名链接：查询串只有 e、s，e 是数字；返回到期时刻（毫秒），否则 null */
export function checkMsUrl(raw: string, base: string, expect?: Expect): number | null {
  const u = checkObjectPart(raw, base, true, expect);
  const q = u ? sigPairs(u.search, ['e', 's']) : null;
  return q ? Number(q.get('e')) * 1000 : null;
}

/**
 * X-Files-Sig 的值：p=view|download&e=<数字>&d=<编码过的文件名>&s=<签名>，只有可打印 ASCII、键不重复。
 * want 给了就要求 p 正好是这个用途。返回到期时刻（毫秒），否则 null
 */
export function checkSig(sig: string, want?: 'view' | 'download'): number | null {
  if (sig.length > 2048 || !/^[!-~]+$/.test(sig)) return null;
  const q = sigPairs(sig, ['p', 'e', 'd', 's']);
  const p = q?.get('p');
  if (!q || (p !== 'view' && p !== 'download') || (want !== undefined && p !== want)) return null;
  return Number(q.get('e')) * 1000;
}

// ───────── 错误码 → 类别 ─────────

const ErrorBody = z.object({ code: z.string().min(1).max(64), reason: z.string().max(64).optional() });

const ACCOUNT_REASONS = new Set(['account_disabled', 'session_revoked']);

/**
 * kind 为 account 的错误 → 退出原因（R-256 ③、PROBE-sugg ②）：session_revoked → removed；
 * account_disabled（files 函数按 is_active() 判断，停用和冷静期都回它）→ platform/account-status.ts 的 exitForDisabled 探测再定
 * （冷静期 / 已停用 / removed / 探测不出 disabled_unsure / 'active' 账号正常、不离开）。
 * sid：发这次请求时本机会话的 session_id（调用方发请求前记下）。不是 account 类的错误返回 null
 */
export async function accountExitOf(e: FileError, sid: string | null, o: DisabledExitOptions = {}): Promise<ExitNotice | 'active' | null> {
  if (e.kind !== 'account') return null;
  const disabled = e.code === 'account_disabled' || e.reason === 'account_disabled';
  return disabled ? exitForDisabled(sid, o) : 'removed';
}

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
  // 只认 PUT 的 403 forbidden 带的 reason（签名单项不过时 code 就是 reason，不会走到这里）
  if (code === 'forbidden' && reason === 'not_pending') return 'not_pending';
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
  // 不是 JSON（例如 Cloudflare 的默认错误页）：按状态码算
  const parsed = ErrorBody.safeParse(await readJson(res));
  if (parsed.success) return fail(res.status, parsed.data.code, parsed.data.reason);
  return fail(res.status, STATUS_CODE[res.status] ?? `http_${res.status}`);
}

/** 读 JSON 响应体；不是 JSON 或读不下来都回 null（读体卡住由 exchange 的超时兜底） */
async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text()) as unknown;
  } catch {
    return null;
  }
}

/** 用自己持有的 reader 转一手响应体，超时时 exchange 能经这个 reader 取消（原响应体已上锁，直接 cancel 会被拒） */
function relay(res: Response, reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel: (why) => reader.cancel(why),
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// ───────── 客户端 ─────────

const UploadOk = z.object({ etag: z.string().max(200).optional() });
const SignBody = z.object({
  items: z.array(
    z.union([
      z.object({ i: z.number().int().nonnegative(), ok: z.literal(true), url: z.string().max(4096), sig: z.string().max(2048).optional() }),
      z.object({ i: z.number().int().nonnegative(), ok: z.literal(false), reason: z.string().min(1).max(64) }),
    ]),
  ),
});

export interface FilesClient {
  upload(bucket: FileBucket, path: string, blob: Blob, contentType: string): Promise<UploadResult>;
  sign(items: readonly SignItem[]): Promise<SignResult[]>;
  fetchBlob(link: SignedLink): Promise<BlobResult>;
}

export function createFilesClient(deps: FilesDeps): FilesClient {
  const base = baseUrl(deps.base);
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const objectUrl = (bucket: FileBucket, path: string) => new URL(`o/${bucket}/${path}`, base).toString();

  /**
   * 发请求并读完响应体；网络错和超时折成 FileError（代码审查低 6）。
   * 计时器从发请求一直管到 read 读完响应体：响应头到了、响应体卡住（慢网读 10 MB）也会按时变成 retry/timeout，
   * 而不是一直挂着。超时时先 abort 请求，再经自己持有的 reader 取消响应体（read 正在读、流已上锁时也取消得掉）
   */
  async function exchange<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    read: (res: Response) => Promise<T | FileError>,
  ): Promise<T | FileError> {
    const ctl = new AbortController();
    const failed = (): FileError => ({ ok: false, kind: 'retry', code: ctl.signal.aborted ? 'timeout' : 'network', status: 0 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const got = await Promise.race([
        doFetch(url, { ...init, signal: ctl.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' }),
        expired,
      ]);
      if (got === 'timeout') return failed();
      reader = got.body?.getReader();
      const out = await Promise.race([read(reader ? relay(got, reader) : got), expired]);
      return out === 'timeout' ? failed() : out;
    } catch {
      return failed();
    } finally {
      clearTimeout(timer);
      if (ctl.signal.aborted) reader?.cancel().catch(() => undefined);
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
    return exchange(objectUrl(bucket, path), { method: 'PUT', headers, body: blob }, TIMEOUT_MS.upload, async (res): Promise<UploadResult> => {
      const headerEtag = res.headers.get('ETag');
      if (res.status === 409) {
        const err = await failFromResponse(res);
        // 只有 exists 当成功：重试时对象已经在了（条件写保证不会被覆盖，内容由 file-check 核对）
        return err.code === 'exists' ? { ok: true, etag: headerEtag, existed: true } : err;
      }
      if (!res.ok) return failFromResponse(res);
      const body = await readJson(res);
      const parsed = UploadOk.safeParse(body);
      return { ok: true, etag: (parsed.success ? parsed.data.etag : undefined) ?? headerEtag, existed: false };
    });
  }

  /** 一批（≤ 100 项）；返回和这一批同序的结果 */
  async function signBatch(batch: readonly SignItem[]): Promise<SignResult[]> {
    const all = (e: FileError) => batch.map(() => e);
    const headers = await authHeaders({ 'Content-Type': 'application/json' });
    if (!(headers instanceof Headers)) return all(headers);
    const items = batch.map((x) => (x.d === undefined ? { bucket: x.bucket, path: x.path, purpose: x.purpose } : { ...x }));
    const body = await exchange(
      new URL('sign', base).toString(),
      { method: 'POST', headers, body: JSON.stringify({ items }) },
      TIMEOUT_MS.sign,
      async (res): Promise<{ json: unknown } | FileError> => (res.ok ? { json: await readJson(res) } : failFromResponse(res)),
    );
    if ('ok' in body) return all(body);
    const parsed = SignBody.safeParse(body.json);
    if (!parsed.success) return all(local('bad_response'));
    const out: SignResult[] = all(local('bad_response'));
    for (const r of parsed.data.items) {
      const want = batch[r.i];
      if (!want) continue;
      if (!r.ok) {
        out[r.i] = fail(200, r.reason, r.reason);
        continue;
      }
      const expect = { bucket: want.bucket, path: want.path };
      if (want.purpose === 'ms') {
        const expiresAt = r.sig === undefined ? checkMsUrl(r.url, base.toString(), expect) : null;
        out[r.i] = expiresAt === null ? local('bad_url') : { ok: true, url: r.url, sig: null, expiresAt };
      } else {
        const expiresAt = r.sig !== undefined && checkObjectUrl(r.url, base.toString(), expect) ? checkSig(r.sig, want.purpose) : null;
        out[r.i] = expiresAt === null || r.sig === undefined ? local('bad_url') : { ok: true, url: r.url, sig: r.sig, expiresAt };
      }
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

  async function fetchBlob(link: SignedLink): Promise<BlobResult> {
    // 签名只放请求头；地址带查询串（例如 ms 链接）一律不取
    if (!checkObjectUrl(link.url, base.toString()) || checkSig(link.sig) === null) return local('bad_url');
    // 计时包含读完响应体（10 MB 附件在慢网上读一半卡住也会按时结束）
    return exchange(link.url, { method: 'GET', headers: { [SIG_HEADER]: link.sig } }, TIMEOUT_MS.get, async (res): Promise<BlobResult> => {
      if (!res.ok) return failFromResponse(res);
      const blob = await res.blob();
      return { ok: true, blob, contentType: res.headers.get('Content-Type') ?? blob.type };
    });
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
export const fetchBlob: FilesClient['fetchBlob'] = (link) => client().fetchBlob(link);
