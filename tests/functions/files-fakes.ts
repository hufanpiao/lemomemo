// /files 单测用的替身：内存对象存储（实现 shared/objstore.ts 的 ObjStore 接口）、files_authorize 的假 RPC、假时钟。
// 对象存储本身（S3 签名、XML）另由 tests/shared/objstore.test.ts 打 S3 替身测；这里只测 /files 函数自己的规矩。
import { ObjStoreError, type ObjBody, type ObjStore } from '../../shared/objstore.ts';

export interface MemObject {
  body: Uint8Array;
  contentType: string;
  etag: string;
}

export interface MemStore extends ObjStore {
  objects: Map<string, MemObject>;
  puts: number;
}

async function bytesOf(body: ObjBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer());
}

export function memStore(): MemStore {
  const objects = new Map<string, MemObject>();
  let n = 0;
  const s: MemStore = {
    objects,
    puts: 0,
    async put(bucket, key, body, opts) {
      s.puts++;
      let bytes: Uint8Array;
      try {
        bytes = await bytesOf(body);
      } catch {
        throw new ObjStoreError('network'); // 上传中途断了：不留对象
      }
      const id = `${bucket}/${key}`;
      if (opts.ifNoneMatch && objects.has(id)) throw new ObjStoreError('exists', 412);
      const etag = `"etag-${++n}"`;
      objects.set(id, { body: bytes, contentType: opts.contentType, etag });
      return { etag };
    },
    async get(bucket, key) {
      const o = objects.get(`${bucket}/${key}`);
      if (!o) return null;
      return { body: new Response(o.body.slice()).body, contentType: o.contentType, contentLength: o.body.length, etag: o.etag };
    },
    async head(bucket, key) {
      const o = objects.get(`${bucket}/${key}`);
      return o ? { contentType: o.contentType, contentLength: o.body.length, etag: o.etag } : null;
    },
    async list() {
      return { objects: [], nextToken: null };
    },
    async listAll() {
      return [];
    },
    async deleteMany() {
      throw new Error('files 函数不准删对象');
    },
    async deletePrefix() {
      throw new Error('files 函数不准删对象');
    },
  };
  return s;
}

export const UA = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const UB = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const NOTE = '11111111-0000-4000-8000-000000000001';
export const ID1 = '22222222-0000-4000-8000-000000000002';
export const ID2 = '33333333-0000-4000-8000-000000000003';

/** 测试账号的“JWT”：Bearer fakejwt.<user_id>（不是真的令牌，只给假 RPC 认人） */
export const bearer = (uid: string) => `Bearer fakejwt.${uid}`;

export interface FakeAuthz {
  fetch: (req: Request) => Promise<Response>;
  calls: { op: string; items: { bucket: string; path: string }[] }[];
  /** 允许的 (op, bucket/path)；默认：路径第一段是本人就放行 */
  deny: Map<string, string>;
  /** 整批回这个错误（account_disabled、session_revoked、rate_limited） */
  batchError: string | null;
  /** 用 raise（PostgREST 4xx {message}）的写法回整批错误 */
  raise: boolean;
  /** 人为延迟（毫秒），测 2 秒超时 */
  delayMs: number;
  /** 模拟后端入参校验 raise 22023（bad_op、bad_items、put_one_item、too_many_items） */
  badInput: string | null;
}

export function fakeAuthz(): FakeAuthz {
  const st: FakeAuthz = {
    calls: [],
    deny: new Map(),
    batchError: null,
    raise: false,
    delayMs: 0,
    badInput: null,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/rest/v1/rpc/files_authorize') return new Response('[]', { status: 404 });
      const body = (await req.json()) as { p_op: string; p_items: { bucket: string; path: string }[] };
      st.calls.push({ op: body.p_op, items: body.p_items });
      if (st.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, st.delayMs);
          req.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      }
      const m = /^Bearer fakejwt\.([0-9a-f-]{36})$/.exec(req.headers.get('authorization') ?? '');
      if (!m) return Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 });
      if (req.headers.get('apikey') !== 'fake-anon-key') return Response.json({ message: 'no apikey' }, { status: 401 });
      if (st.badInput) return Response.json({ code: '22023', message: st.badInput }, { status: 400 });
      if (st.batchError) {
        return st.raise ? Response.json({ code: 'P0001', message: st.batchError }, { status: 400 }) : Response.json({ error: st.batchError });
      }
      const uid = m[1] ?? '';
      const items = body.p_items.map((it, i) => {
        const why = st.deny.get(`${body.p_op}:${it.bucket}/${it.path}`);
        if (why) return { i, ok: false, reason: why };
        return it.path.startsWith(`${uid}/`) ? { i, ok: true } : { i, ok: false, reason: 'not_owner' };
      });
      return Response.json({ uid, items });
    },
  };
  return st;
}

export function clock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (s: number) => (t += s * 1000) };
}

export const webp = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50].slice(0, n));
  return b;
};

export const png = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  return b;
};
