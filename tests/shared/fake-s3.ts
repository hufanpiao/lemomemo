// 内存里的 S3 替身（只给测试用；本机没有 Docker、S3 替身 LocalStack（运维 O-1）起不来时用它，任务单 FB-1）。
// 只实现 shared/objstore.ts 用到的：PutObject（If-None-Match: *）、GetObject、HeadObject、ListObjectsV2、DeleteObjects。
// SigV4 自己独立验一遍（不用 aws4fetch），签错了回 403 SignatureDoesNotMatch——这样能测出签名、路径编码的毛病；
// DeleteObjects 核对 Content-MD5（用 node:crypto 算，和 shared 里自写的 MD5 互相印证）。
// Node（vitest）和 Deno（deno test tests/shared）都能跑；tests/e2e/fake-backends.ts 把它挂到真的 HTTP 端口上给 wrangler 用。
import { createHash, createHmac } from 'node:crypto';

export interface FakeObject {
  body: Uint8Array;
  contentType: string;
  etag: string;
}

export interface FakeS3Options {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** 已经建好的桶（真实桶名，含 preview- 前缀） */
  buckets: readonly string[];
  /** 这把令牌能碰哪些桶（模拟 R2 令牌按桶授权）；不写就是全部 */
  allowedBuckets?: readonly string[];
}

export interface FakeCall {
  method: string;
  bucket: string;
  key: string;
  query: string;
  status: number;
}

export interface FakeS3 {
  handle(req: Request): Promise<Response>;
  objects: Map<string, FakeObject>;
  calls: FakeCall[];
  /** DeleteObjects 时故意报删失败的键 */
  failDelete: Set<string>;
  /** DeleteObjects 时回“删了”、其实没删的键（测“删完再列一次”） */
  ignoreDelete: Set<string>;
  /** 列表一页最多回几条（测翻页） */
  pageSize: number;
  /** 下一次请求整体回这个状态码（测错误处理） */
  failNext: number | null;
}

// 验签用 node:crypto 的同步 HMAC、SHA-256：原来每个请求要 1 次 digest + 5 次 importKey + 5 次 sign，共 11 次 crypto.subtle 异步往返
// （每次都排进 libuv 线程池再回事件循环），机器忙时每次往返都要等调度，一条造几十个对象的用例会从 0.3 秒拖到 5 秒以上超时。
// 同步算结果完全一样，也仍然独立于 shared/objstore.ts 用的 aws4fetch
const hmac = (key: Uint8Array | string, s: string): Uint8Array => createHmac('sha256', key).update(s, 'utf8').digest();

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function rawPathAndQuery(url: string): { path: string; query: string } {
  const afterScheme = url.indexOf('//') + 2;
  const p = url.indexOf('/', afterScheme);
  const rest = p < 0 ? '/' : url.slice(p);
  const q = rest.indexOf('?');
  return { path: q < 0 ? rest : rest.slice(0, q), query: q < 0 ? '' : rest.slice(q + 1) };
}

function parseQuery(query: string): [string, string][] {
  if (!query) return [];
  return query.split('&').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? '' : pair.slice(i + 1);
    return [decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))];
  });
}

async function verifySig(req: Request, opts: FakeS3Options): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  const [, ak, date, region, signedHeaders = '', sig] = m;
  if (ak !== opts.accessKeyId || region !== (opts.region ?? 'auto')) return false;
  const amzDate = req.headers.get('x-amz-date') ?? '';
  if (!amzDate.startsWith(date ?? '-')) return false;
  const url = new URL(req.url);
  const { path, query } = rawPathAndQuery(req.url);
  const canonPath = path.split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/');
  const canonQuery = parseQuery(query)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const names = signedHeaders.split(';');
  if (!names.includes('host') || !names.includes('x-amz-date') || !names.includes('x-amz-content-sha256')) return false;
  const canonHeaders = names.map((n) => `${n}:${(n === 'host' ? url.host : (req.headers.get(n) ?? '')).trim().replace(/\s+/g, ' ')}`).join('\n');
  const payload = req.headers.get('x-amz-content-sha256') ?? '';
  const canonical = [req.method, canonPath, canonQuery, canonHeaders + '\n', signedHeaders, payload].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical, 'utf8').digest('hex')].join('\n');
  let k = hmac('AWS4' + opts.secretAccessKey, date ?? '');
  k = hmac(k, region ?? '');
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  return createHmac('sha256', k).update(sts, 'utf8').digest('hex') === sig;
}

function xmlErr(status: number, code: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`, {
    status,
    headers: { 'content-type': 'application/xml' },
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createFakeS3(opts: FakeS3Options): FakeS3 {
  const objects = new Map<string, FakeObject>();
  const calls: FakeCall[] = [];
  const state: FakeS3 = { handle, objects, calls, failDelete: new Set(), ignoreDelete: new Set(), pageSize: 1000, failNext: null };

  async function handle(req: Request): Promise<Response> {
    const { path, query } = rawPathAndQuery(req.url);
    const segs = path.split('/').slice(1);
    const bucket = decodeURIComponent(segs[0] ?? '');
    const key = segs.slice(1).map(decodeURIComponent).join('/');
    const q = new Map(parseQuery(query));
    const res = await route(req, bucket, key, q);
    calls.push({ method: req.method, bucket, key, query, status: res.status });
    return res;
  }

  async function route(req: Request, bucket: string, key: string, q: Map<string, string>): Promise<Response> {
    if (state.failNext !== null) {
      const s = state.failNext;
      state.failNext = null;
      return xmlErr(s, 'InjectedFailure');
    }
    if (!(await verifySig(req, opts))) return xmlErr(403, 'SignatureDoesNotMatch');
    if (!opts.buckets.includes(bucket)) return xmlErr(404, 'NoSuchBucket');
    if (opts.allowedBuckets && !opts.allowedBuckets.includes(bucket)) return xmlErr(403, 'AccessDenied');
    const id = `${bucket}/${key}`;

    if (req.method === 'PUT' && key) {
      let body: Uint8Array;
      try {
        body = new Uint8Array(await req.arrayBuffer());
      } catch {
        return xmlErr(400, 'IncompleteBody'); // 上传中途断开：不留对象
      }
      if (req.headers.get('if-none-match') === '*' && objects.has(id)) return xmlErr(412, 'PreconditionFailed');
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      objects.set(id, { body, contentType: req.headers.get('content-type') ?? 'application/octet-stream', etag });
      return new Response(null, { status: 200, headers: { etag } });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && key) {
      const o = objects.get(id);
      if (!o) return req.method === 'HEAD' ? new Response(null, { status: 404 }) : xmlErr(404, 'NoSuchKey');
      const headers = { 'content-type': o.contentType, 'content-length': String(o.body.length), etag: o.etag };
      return new Response(req.method === 'HEAD' ? null : o.body.slice(), { status: 200, headers });
    }
    if (req.method === 'GET' && !key && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? '';
      const max = Math.min(Number(q.get('max-keys') ?? '1000'), state.pageSize);
      const all = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1)).sort();
      const start = q.has('continuation-token') ? Number((q.get('continuation-token') ?? '').replace(/^tok-/, '')) : 0;
      const page = all.slice(start, start + max);
      const truncated = start + max < all.length;
      const contents = page
        .map((k) => {
          const o = objects.get(`${bucket}/${k}`);
          return `<Contents><Key>${esc(k)}</Key><Size>${o?.body.length ?? 0}</Size><ETag>${esc(o?.etag ?? '')}</ETag></Contents>`;
        })
        .join('');
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>tok-${start + max}</NextContinuationToken>` : ''}` +
        `${contents}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    if (req.method === 'POST' && !key && q.has('delete')) {
      const body = new Uint8Array(await req.arrayBuffer());
      const md5 = createHash('md5').update(body).digest('base64');
      if (req.headers.get('content-md5') !== md5) return xmlErr(400, 'BadDigest');
      const xml = new TextDecoder().decode(body);
      const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) =>
        (m[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
      );
      if (keys.length > 1000) return xmlErr(400, 'MalformedXML');
      const errors: string[] = [];
      for (const k of keys) {
        if (state.failDelete.has(k)) errors.push(`<Error><Key>${esc(k)}</Key><Code>InternalError</Code></Error>`);
        else if (!state.ignoreDelete.has(k)) objects.delete(`${bucket}/${k}`);
      }
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><DeleteResult>${errors.join('')}</DeleteResult>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    return xmlErr(405, 'MethodNotAllowed');
  }

  return state;
}
