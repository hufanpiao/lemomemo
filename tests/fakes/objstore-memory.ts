// 对象存储的内存替身（架构 0.32 第 4 条、8.6；任务单 BE-5）：给不起 Docker 的单测用（服务器函数、注销生成用例、/files 的逻辑测试）
// 起 S3 替身容器（运维 O-1）的集成测试用真的 shared/objstore.ts；这里只模拟它对调用方承诺的行为：
//   put 带 ifNoneMatch: '*' 时对象已在就回 exists（R2 条件写回 412）；get 流式；head；list 按前缀、按 key 排序、分页；
//   deleteMany 每次最多 1000 个（超了抛错，和 S3 DeleteObjects 一样）；不存在的 key 也算删了
// 接口 ObjStore 是后端按任务单 FB-1 那一行写的“调用方约定”，前端 B 定稿 shared/objstore.ts 后以那边导出的类型为准，这里跟着改
// 纯 TS，不用 Node、Deno 的 API（vitest 和 deno test 都能 import）

export type PutOptions = { contentType: string; ifNoneMatch?: '*' };
export type PutResult = { ok: true; etag: string } | { ok: false; code: 'exists' };
export type ObjectInfo = { key: string; size: number; etag: string; contentType: string };
export type GetResult = ObjectInfo & { body: ReadableStream<Uint8Array> };
export type ListPage = { items: ObjectInfo[]; nextToken: string | null };

export interface ObjStore {
  put(bucket: string, key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts: PutOptions): Promise<PutResult>;
  get(bucket: string, key: string): Promise<GetResult | null>;
  head(bucket: string, key: string): Promise<ObjectInfo | null>;
  list(bucket: string, prefix: string, opts?: { token?: string | null; maxKeys?: number }): Promise<ListPage>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<{ deleted: number }>;
}

/** 每次调用记一笔，测试用来断言“删完又列了一次”（TC-B0-117）、“没过授权就没碰存储”（TC-B0-115） */
export type Call = { op: 'put' | 'get' | 'head' | 'list' | 'deleteMany'; bucket: string; key?: string; prefix?: string; n?: number };

type Stored = { bytes: Uint8Array; contentType: string; etag: string };

export const DELETE_BATCH_MAX = 1000;
export const LIST_PAGE_MAX = 1000;

async function readAll(body: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice();
  const parts: Uint8Array[] = [];
  const reader = body.getReader();
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
  private failNext = new Map<Call['op'], Error>();

  /** 只认建过的桶（和替身启动脚本建 4 个桶一样）；碰没建的桶抛 NoSuchBucket */
  constructor(bucketNames: readonly string[]) {
    for (const n of bucketNames) this.buckets.set(n, new Map());
  }

  failOnce(op: Call['op'], err: Error = new Error('objstore_unavailable')): void {
    this.failNext.set(op, err);
  }

  private bucket(op: Call['op'], name: string): Map<string, Stored> {
    const e = this.failNext.get(op);
    if (e) { this.failNext.delete(op); throw e; }
    const b = this.buckets.get(name);
    if (!b) throw new Error(`NoSuchBucket: ${name}`);
    return b;
  }

  async put(bucket: string, key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts: PutOptions): Promise<PutResult> {
    this.calls.push({ op: 'put', bucket, key });
    const b = this.bucket('put', bucket);
    if (!opts.contentType) throw new Error('content_type_required');   // 服务器上传一律显式传 contentType（TC-B0-75）
    const bytes = await readAll(body);
    if (opts.ifNoneMatch === '*' && b.has(key)) return { ok: false, code: 'exists' };
    const etag = etagOf(bytes);
    b.set(key, { bytes, contentType: opts.contentType, etag });
    return { ok: true, etag };
  }

  async get(bucket: string, key: string): Promise<GetResult | null> {
    this.calls.push({ op: 'get', bucket, key });
    const o = this.bucket('get', bucket).get(key);
    if (!o) return null;
    const bytes = o.bytes.slice();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    return { key, size: bytes.length, etag: o.etag, contentType: o.contentType, body };
  }

  async head(bucket: string, key: string): Promise<ObjectInfo | null> {
    this.calls.push({ op: 'head', bucket, key });
    const o = this.bucket('head', bucket).get(key);
    return o ? { key, size: o.bytes.length, etag: o.etag, contentType: o.contentType } : null;
  }

  async list(bucket: string, prefix: string, opts: { token?: string | null; maxKeys?: number } = {}): Promise<ListPage> {
    this.calls.push({ op: 'list', bucket, prefix });
    const b = this.bucket('list', bucket);
    const max = Math.min(Math.max(1, opts.maxKeys ?? LIST_PAGE_MAX), LIST_PAGE_MAX);
    // 和 ListObjectsV2 一样按 key 的字节序排；token 是上一页最后一个 key（真 S3 是不透明串，调用方不能解析它）
    const keys = [...b.keys()].filter((k) => k.startsWith(prefix)).sort().filter((k) => !opts.token || k > opts.token);
    const page = keys.slice(0, max);
    const items = page.map((key) => {
      const o = b.get(key) as Stored;
      return { key, size: o.bytes.length, etag: o.etag, contentType: o.contentType };
    });
    return { items, nextToken: keys.length > max ? (page[page.length - 1] ?? null) : null };
  }

  async deleteMany(bucket: string, keys: readonly string[]): Promise<{ deleted: number }> {
    this.calls.push({ op: 'deleteMany', bucket, n: keys.length });
    const b = this.bucket('deleteMany', bucket);
    if (keys.length > DELETE_BATCH_MAX) throw new Error(`delete_batch_too_large: ${keys.length}`);
    for (const k of keys) b.delete(k);
    return { deleted: keys.length };
  }

  /** 测试辅助：某个前缀下有几个对象（注销生成用例的“对象存储探针”，TC-B0-117） */
  count(bucket: string, prefix: string): number {
    return [...(this.buckets.get(bucket)?.keys() ?? [])].filter((k) => k.startsWith(prefix)).length;
  }
}

/** 按前缀把对象全部列出来（翻完所有页） */
export async function listAll(s: ObjStore, bucket: string, prefix: string, maxKeys?: number): Promise<ObjectInfo[]> {
  const out: ObjectInfo[] = [];
  let token: string | null = null;
  do {
    const page: ListPage = await s.list(bucket, prefix, maxKeys === undefined ? { token } : { token, maxKeys });
    out.push(...page.items);
    token = page.nextToken;
  } while (token);
  return out;
}
