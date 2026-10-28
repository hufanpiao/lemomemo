// 对象存储客户端（架构 0.32 第 4 条、3.3 G“R2 起”、3.4、8.6；任务单 FB-1）。
// 照片和附件存在 Cloudflare R2，一律走 S3 接口（不用 R2 绑定）：Pages Function（/files/v1/*，令牌 R2_FILES_*）
// 和服务器函数（Deno，supabase/functions，令牌 R2_FN_*，经 build/copy_shared.mjs 复制成 _shared/gen/objstore.ts）共用这一份；
// 本机和 CI 打 S3 兼容替身（MinIO），预览和正式换成 R2 的地址和令牌，代码不变。
//
// • SigV4 签名用 aws4fetch（package.json 和 Deno 的 npm:aws4fetch@<版本> 锁同一版），path-style：<endpoint>/<桶>/<键>
// • 网络请求和时钟都由调用方传进来（shared 不碰全局 fetch、不读系统时间，A2、A12），测试可以换成内存替身
// • 不打印任何东西；出错抛 ObjStoreError，message 是英文错误码，不带键名和地址（14.2 第 8 点：日志不留路径）
// • 只有 put 带 If-None-Match: * 的条件写；没有覆盖写的便捷方法，删除只给清理和注销用（deleteMany、deletePrefix）
import { AwsV4Signer } from 'aws4fetch';
import { base64, deleteBody, type ListedObject, type ListPage, md5, parseDeleteResult, parseListV2, utf8 } from './objstore-wire.ts';

export type { ListedObject, ListPage } from './objstore-wire.ts';

// ---------- 和运行环境之间的最小接口（shared 的 lib 里没有 DOM 类型，按结构写） ----------

export interface ObjHeaders {
  get(name: string): string | null;
}

export interface ObjResponse {
  status: number;
  headers: ObjHeaders;
  /** 流式响应体（Web ReadableStream）；只透传给调用方，这里不读 */
  body: unknown;
  text(): Promise<string>;
}

export interface ObjRequestInit {
  method: string;
  /** aws4fetch 签好的 Headers 对象，原样交给 fetch */
  headers: unknown;
  body?: unknown;
  /** Node（undici）发流式请求体要带 */
  duplex?: 'half';
}

export type ObjFetch = (url: string, init: ObjRequestInit) => Promise<ObjResponse>;

/** 请求体：字节，或者流（Web ReadableStream；Workers 里要包成 FixedLengthStream，R2 的 PutObject 要知道长度） */
export type ObjBody = Uint8Array | ArrayBuffer | string | { getReader(): unknown };

export interface ObjStoreConfig {
  /** https://<账号 ID>.r2.cloudflarestorage.com；本机是替身的 http://127.0.0.1:<端口>（8.4、8.6） */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2_BUCKET_PREFIX：预览 'preview-'，正式 ''。调用方一律写逻辑桶名（images、files、vault-images、vault-files） */
  bucketPrefix?: string;
  /** R2 是 'auto'；替身按自己的设置（默认也用 'auto'） */
  region?: string;
  fetch: ObjFetch;
  /** 现在的毫秒数（签名的 X-Amz-Date 用） */
  now: () => number;
}

export type ObjStoreErrorCode =
  | 'exists' // 条件写：对象已存在（S3 回 412）
  | 'denied' // 403：令牌没有这个桶的权限
  | 'http' // 其他非预期状态码
  | 'network' // fetch 抛错（含超时中止）
  | 'bad_response' // 响应体解析不了
  | 'bad_input' // 桶名、键、参数不合规（没发请求）
  | 'delete_partial' // DeleteObjects 有删失败的
  | 'not_empty'; // 删完再列一次，前缀下还有对象

export class ObjStoreError extends Error {
  readonly code: ObjStoreErrorCode;
  readonly status: number | null;
  constructor(code: ObjStoreErrorCode, status: number | null = null) {
    super(status === null ? `objstore_${code}` : `objstore_${code}_${status}`);
    this.name = 'ObjStoreError';
    this.code = code;
    this.status = status;
  }
}

export interface ObjectMeta {
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
}

export interface ObjectBody extends ObjectMeta {
  /** Web ReadableStream，调用方直接交给 Response */
  body: unknown;
}

export interface PutOptions {
  contentType: string;
  /** If-None-Match: *，对象已存在就抛 ObjStoreError('exists')（3.3 G：不提供覆盖） */
  ifNoneMatch?: boolean | '*';
}

export interface ObjStore {
  put(bucket: string, key: string, body: ObjBody, opts: PutOptions): Promise<{ etag: string | null }>;
  /** 没有这个对象返回 null */
  get(bucket: string, key: string): Promise<ObjectBody | null>;
  head(bucket: string, key: string): Promise<ObjectMeta | null>;
  /** ListObjectsV2 的一页 */
  list(bucket: string, prefix: string, opts?: { continuationToken?: string; maxKeys?: number }): Promise<ListPage>;
  /** 按前缀列全部（自动翻页） */
  listAll(bucket: string, prefix: string): Promise<ListedObject[]>;
  /** 每次最多 1000 个；有删失败的抛 delete_partial。返回请求删除的个数 */
  deleteMany(bucket: string, keys: readonly string[]): Promise<number>;
  /** 删掉前缀下全部对象，删完再列一次，不是 0 就抛 not_empty（3.4、3.5 第 2 点：注销和清理用） */
  deletePrefix(bucket: string, prefix: string): Promise<{ deleted: number }>;
}

export const DELETE_BATCH = 1000;
const LIST_PAGE_MAX = 1000;
/** 防止替身或服务端回了重复的 token 时无限翻页 */
const LIST_PAGES_LIMIT = 10_000;

const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// 键：不能空、不能以 / 开头、不能有空段和 . / .. 段、不能有控制字符；长度按 S3 的 1024 字节
// eslint-disable-next-line no-control-regex -- 就是要拦控制字符
const KEY_BAD_RE = /[\u0000-\u001f\u007f]/;

function checkBucket(bucket: string): void {
  if (!BUCKET_RE.test(bucket)) throw new ObjStoreError('bad_input');
}

function checkKey(key: string): void {
  if (!key || key.startsWith('/') || KEY_BAD_RE.test(key) || utf8(key).length > 1024) throw new ObjStoreError('bad_input');
  if (key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new ObjStoreError('bad_input');
}

function checkPrefix(prefix: string, allowEmpty: boolean): void {
  if (prefix === '' && allowEmpty) return;
  if (!prefix || prefix.startsWith('/') || KEY_BAD_RE.test(prefix) || prefix.split('/').some((s) => s === '.' || s === '..')) {
    throw new ObjStoreError('bad_input');
  }
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** X-Amz-Date 的格式：20261028T010203Z */
function amzDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** X-Amz-Date，例如 20130524T000000Z */
  datetime: string;
  cache?: Map<string, ArrayBuffer>;
  /** 只给样例向量测试用：连 range 等 aws4fetch 默认不签的头也签 */
  allHeaders?: boolean;
}

export interface SignedRequest {
  url: string;
  /** 签好的 Headers 对象（运行环境的 Headers），原样交给 fetch */
  headers: ObjHeaders;
  authorization: string;
}

/**
 * S3 的 SigV4 头签名（service 固定 s3；只签请求头，不用预签名查询串）。objstore 的每个请求都经这里；
 * tests/shared/objstore-sigv4.test.ts 用 AWS 官方文档的样例向量核对（替身 LocalStack 默认不验签名，不能只靠它证明签得对）。
 * 没带 X-Amz-Content-Sha256 时 aws4fetch 对 s3 用 UNSIGNED-PAYLOAD（流式请求体只能这样；全程 HTTPS）。
 */
export async function signS3(input: SignInput): Promise<SignedRequest> {
  const signer = new AwsV4Signer({
    method: input.method,
    url: input.url,
    headers: input.headers,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    service: 's3',
    region: input.region,
    datetime: input.datetime,
    ...(input.cache ? { cache: input.cache } : {}),
    ...(input.allHeaders ? { allHeaders: true } : {}),
  });
  const signed = await signer.sign();
  const headers = signed.headers as ObjHeaders;
  return { url: String(signed.url), headers, authorization: headers.get('authorization') ?? '' };
}

export function createObjStore(cfg: ObjStoreConfig): ObjStore {
  const endpoint = cfg.endpoint.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#]+$/.test(endpoint)) throw new ObjStoreError('bad_input');
  // 读不到 R2_BUCKET_PREFIX（正式环境不设）当空字符串
  const prefix = cfg.bucketPrefix ?? '';
  if (prefix && !/^[a-z0-9-]+$/.test(prefix)) throw new ObjStoreError('bad_input');
  const region = cfg.region || 'auto';
  const keyCache = new Map<string, ArrayBuffer>();

  const bucketUrl = (bucket: string) => {
    checkBucket(bucket);
    const real = prefix + bucket;
    checkBucket(real);
    return `${endpoint}/${real}`;
  };

  async function send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ObjBody,
  ): Promise<ObjResponse> {
    const signed = await signS3({
      method,
      url,
      headers,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region,
      datetime: amzDate(cfg.now()),
      cache: keyCache,
    });
    const init: ObjRequestInit = { method, headers: signed.headers };
    if (body !== undefined) {
      init.body = body;
      if (typeof body === 'object' && 'getReader' in body) init.duplex = 'half';
    }
    try {
      return await cfg.fetch(signed.url, init);
    } catch {
      throw new ObjStoreError('network');
    }
  }

  function fail(res: ObjResponse): never {
    if (res.status === 403) throw new ObjStoreError('denied', 403);
    throw new ObjStoreError('http', res.status);
  }

  function meta(res: ObjResponse): ObjectMeta {
    const len = res.headers.get('content-length');
    return {
      contentType: res.headers.get('content-type'),
      contentLength: len !== null && /^\d+$/.test(len) ? Number(len) : null,
      etag: res.headers.get('etag'),
    };
  }

  async function list(bucket: string, pfx: string, opts: { continuationToken?: string; maxKeys?: number } = {}): Promise<ListPage> {
    checkPrefix(pfx, true);
    const q = new Map<string, string>([['list-type', '2']]);
    if (pfx) q.set('prefix', pfx);
    if (opts.continuationToken) q.set('continuation-token', opts.continuationToken);
    const max = opts.maxKeys ?? LIST_PAGE_MAX;
    if (!Number.isInteger(max) || max < 1 || max > LIST_PAGE_MAX) throw new ObjStoreError('bad_input');
    q.set('max-keys', String(max));
    const qs = [...q].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const res = await send('GET', `${bucketUrl(bucket)}?${qs}`, {});
    if (res.status !== 200) fail(res);
    try {
      return parseListV2(await res.text());
    } catch {
      throw new ObjStoreError('bad_response');
    }
  }

  async function listAll(bucket: string, pfx: string): Promise<ListedObject[]> {
    const out: ListedObject[] = [];
    let token: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < LIST_PAGES_LIMIT; i++) {
      const page = await list(bucket, pfx, token ? { continuationToken: token } : {});
      out.push(...page.objects);
      if (!page.nextToken) return out;
      if (seen.has(page.nextToken)) throw new ObjStoreError('bad_response');
      seen.add(page.nextToken);
      token = page.nextToken;
    }
    throw new ObjStoreError('bad_response');
  }

  async function deleteMany(bucket: string, keys: readonly string[]): Promise<number> {
    for (const k of keys) checkKey(k);
    let n = 0;
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const xml = deleteBody(batch);
      const bytes = utf8(xml);
      const res = await send(
        'POST',
        `${bucketUrl(bucket)}?delete=`,
        { 'content-type': 'application/xml', 'content-md5': base64(md5(bytes)) },
        bytes,
      );
      if (res.status !== 200) fail(res);
      let failures: { key: string; code: string }[];
      try {
        failures = parseDeleteResult(await res.text());
      } catch {
        throw new ObjStoreError('bad_response');
      }
      if (failures.length > 0) throw new ObjStoreError('delete_partial');
      n += batch.length;
    }
    return n;
  }

  return {
    async put(bucket, key, body, opts) {
      checkKey(key);
      if (!opts.contentType || /[\r\n]/.test(opts.contentType)) throw new ObjStoreError('bad_input');
      const headers: Record<string, string> = { 'content-type': opts.contentType };
      if (opts.ifNoneMatch) headers['if-none-match'] = '*';
      const res = await send('PUT', `${bucketUrl(bucket)}/${encodeKey(key)}`, headers, body);
      if (res.status === 412 && opts.ifNoneMatch) throw new ObjStoreError('exists', 412);
      if (res.status !== 200) fail(res);
      return { etag: res.headers.get('etag') };
    },

    async get(bucket, key) {
      checkKey(key);
      const res = await send('GET', `${bucketUrl(bucket)}/${encodeKey(key)}`, {});
      if (res.status === 404) return null;
      if (res.status !== 200) fail(res);
      return { ...meta(res), body: res.body };
    },

    async head(bucket, key) {
      checkKey(key);
      const res = await send('HEAD', `${bucketUrl(bucket)}/${encodeKey(key)}`, {});
      if (res.status === 404) return null;
      if (res.status !== 200) fail(res);
      return meta(res);
    },

    list,
    listAll,
    deleteMany,

    async deletePrefix(bucket, pfx) {
      // 前缀不准空：防止一个空字符串把整个桶删光
      checkPrefix(pfx, false);
      const objs = await listAll(bucket, pfx);
      const deleted = objs.length ? await deleteMany(bucket, objs.map((o) => o.key)) : 0;
      const again = await list(bucket, pfx, { maxKeys: 1 });
      if (again.objects.length > 0) throw new ObjStoreError('not_empty');
      return { deleted };
    },
  };
}
