// 对象存储的内存替身（架构 0.32 第 4 条、8.6；任务单 BE-5）：给不起 Docker 的单测用（服务器函数、注销 runner、/files 的逻辑测试）
// 起 S3 替身容器（运维 O-1）的集成测试用真的 shared/objstore.ts；这里 implements 同一个 ObjStore 接口（前端 B 定稿的那份），
// 接口一变 tsc 就报错。只模拟真客户端对调用方承诺的行为：
//   put：ifNoneMatch 为 true 或 '*' 且对象已在时抛 ObjStoreError('exists')（R2 条件写回 412）；成功回 { etag }
//   get 流式、head 回 { contentType, contentLength, etag }；不存在回 null
//   list：按前缀、按 key 排序、分页（{ continuationToken, maxKeys } → { objects, nextToken }）；listAll 自动翻页
//   deleteMany：每 1000 个一批（和真客户端一样自己拆批），不存在的 key 也算删了，返回请求删除的个数
//   deletePrefix：前缀不准空；删完再列一次，不是 0 抛 not_empty；返回 { deleted }
//   键、桶、参数不合规抛 bad_input；没建的桶按 S3 回 404：get、head 回 null，其他抛 ObjStoreError('http', 404)
// 纯 TS，不用 Node、Deno 的 API（vitest 和 deno test 都能 import）
import {
  DELETE_BATCH,
  type ListedObject,
  type ListPage,
  type ObjBody,
  type ObjectBody,
  type ObjectMeta,
  type ObjStore,
  ObjStoreError,
  type PutOptions,
} from '../../shared/objstore.ts';

/** 每次调用记一笔，测试用来断言“删完又列了一次”（TC-B0-117）、“没过授权就没碰存储”（TC-B0-115） */
export type CallOp = 'put' | 'get' | 'head' | 'list' | 'deleteMany';
export type Call = { op: CallOp; bucket: string; key?: string; prefix?: string; n?: number };

type Stored = { bytes: Uint8Array; contentType: string; etag: string };

export const LIST_PAGE_MAX = 1000;
const enc = new TextEncoder();
// eslint-disable-next-line no-control-regex -- 和 shared/objstore.ts 一样拦控制字符
const KEY_BAD_RE = /[\u0000-\u001f\u007f]/;

function checkKey(key: string): void {
  if (!key || key.startsWith('/') || KEY_BAD_RE.test(key) || enc.encode(key).length > 1024) throw new ObjStoreError('bad_input');
  if (key.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new ObjStoreError('bad_input');
}

function checkPrefix(prefix: string, allowEmpty: boolean): void {
  if (prefix === '' && allowEmpty) return;
  if (!prefix || prefix.startsWith('/') || KEY_BAD_RE.test(prefix) || prefix.split('/').some((s) => s === '.' || s === '..')) {
    throw new ObjStoreError('bad_input');
  }
}

async function readAll(body: ObjBody): Promise<Uint8Array> {
  if (typeof body === 'string') return enc.encode(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 不是加密用途，只要“内容不同 etag 就不同”：FNV-1a 32 位，十六进制，带引号（S3 的 ETag 带引号） */
function etagOf(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; }
  return `"${h.toString(16).padStart(8, '0')}-${b.length}"`;
}

export class MemoryObjStore implements ObjStore {
  readonly calls: Call[] = [];
  private readonly buckets = new Map<string, Map<string, Stored>>();
  /** 下一次某个操作抛这个错（模拟网络失败、5xx），用一次就清掉 */
  private readonly failNext = new Map<CallOp, Error>();

  /** 只认建过的桶（和替身启动脚本建 4 个桶一样，逻辑桶名） */
  constructor(bucketNames: readonly string[]) {
    for (const n of bucketNames) this.buckets.set(n, new Map());
  }

  failOnce(op: CallOp, err: Error = new ObjStoreError('network')): void {
    this.failNext.set(op, err);
  }

  private bucket(op: CallOp, name: string): Map<string, Stored> {
    const e = this.failNext.get(op);
    if (e) { this.failNext.delete(op); throw e; }
    const b = this.buckets.get(name);
    // NoSuchBucket：S3 回 404。get、head 的 404 真客户端分不出是桶没有还是对象没有，一律回 null；其他操作抛 http 404
    if (!b) {
      if (op === 'get' || op === 'head') return new Map();
      throw new ObjStoreError('http', 404);
    }
    return b;
  }

  async put(bucket: string, key: string, body: ObjBody, opts: PutOptions): Promise<{ etag: string | null }> {
    this.calls.push({ op: 'put', bucket, key });
    checkKey(key);
    // 服务器上传一律显式传 contentType（TC-B0-75）；真客户端不发请求直接 bad_input
    if (!opts.contentType || /[\r\n]/.test(opts.contentType)) throw new ObjStoreError('bad_input');
    const b = this.bucket('put', bucket);
    const bytes = await readAll(body);
    if (opts.ifNoneMatch && b.has(key)) throw new ObjStoreError('exists', 412);
    const etag = etagOf(bytes);
    b.set(key, { bytes, contentType: opts.contentType, etag });
    return { etag };
  }

  async get(bucket: string, key: string): Promise<ObjectBody | null> {
    this.calls.push({ op: 'get', bucket, key });
    checkKey(key);
    const o = this.bucket('get', bucket).get(key);
    if (!o) return null;
    const bytes = o.bytes.slice();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    return { contentType: o.contentType, contentLength: bytes.length, etag: o.etag, body };
  }

  async head(bucket: string, key: string): Promise<ObjectMeta | null> {
    this.calls.push({ op: 'head', bucket, key });
    checkKey(key);
    const o = this.bucket('head', bucket).get(key);
    return o ? { contentType: o.contentType, contentLength: o.bytes.length, etag: o.etag } : null;
  }

  async list(bucket: string, prefix: string, opts: { continuationToken?: string; maxKeys?: number } = {}): Promise<ListPage> {
    this.calls.push({ op: 'list', bucket, prefix });
    checkPrefix(prefix, true);
    const max = opts.maxKeys ?? LIST_PAGE_MAX;
    if (!Number.isInteger(max) || max < 1 || max > LIST_PAGE_MAX) throw new ObjStoreError('bad_input');
    const b = this.bucket('list', bucket);
    // 和 ListObjectsV2 一样按 key 的字节序排；token 是上一页最后一个 key（真 S3 是不透明串，调用方不能解析它）
    const after = opts.continuationToken;
    const keys = [...b.keys()].filter((k) => k.startsWith(prefix)).sort().filter((k) => !after || k > after);
    const page = keys.slice(0, max);
    const objects = page.map((key) => {
      const o = b.get(key) as Stored;
      return { key, size: o.bytes.length, etag: o.etag };
    });
    return { objects, nextToken: keys.length > max ? (page[page.length - 1] ?? null) : null };
  }

  async listAll(bucket: string, prefix: string): Promise<ListedObject[]> {
    const out: ListedObject[] = [];
    let token: string | null = null;
    do {
      const page: ListPage = await this.list(bucket, prefix, token ? { continuationToken: token } : {});
      out.push(...page.objects);
      token = page.nextToken;
    } while (token);
    return out;
  }

  async deleteMany(bucket: string, keys: readonly string[]): Promise<number> {
    for (const k of keys) checkKey(k);
    let n = 0;
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      this.calls.push({ op: 'deleteMany', bucket, n: batch.length });
      const b = this.bucket('deleteMany', bucket);
      for (const k of batch) b.delete(k);
      n += batch.length;
    }
    return n;
  }

  async deletePrefix(bucket: string, prefix: string): Promise<{ deleted: number }> {
    // 前缀不准空：防止一个空字符串把整个桶删光
    checkPrefix(prefix, false);
    const objs = await this.listAll(bucket, prefix);
    const deleted = objs.length ? await this.deleteMany(bucket, objs.map((o) => o.key)) : 0;
    const again = await this.list(bucket, prefix, { maxKeys: 1 });
    if (again.objects.length > 0) throw new ObjStoreError('not_empty');
    return { deleted };
  }

  /** 测试辅助：某个前缀下有几个对象（不记调用、不触发 failOnce） */
  count(bucket: string, prefix: string): number {
    return [...(this.buckets.get(bucket)?.keys() ?? [])].filter((k) => k.startsWith(prefix)).length;
  }

  /** 测试辅助：直接塞一个对象（不记调用），用来模拟“删的同时又有人写进来”，测 not_empty */
  plant(bucket: string, key: string, bytes: Uint8Array, contentType = 'application/octet-stream'): void {
    const b = this.buckets.get(bucket);
    if (!b) throw new ObjStoreError('http', 404);
    b.set(key, { bytes, contentType, etag: etagOf(bytes) });
  }
}
