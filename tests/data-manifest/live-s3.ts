// TC-B0-117 真链路的 S3 后端（purge-runner.ts 的 startLivePurge 用；B1 接手清单 B0-117-dev）：同一份测试代码、两种后端，按环境变量切换
//   ① 仓库替身 tests/shared/fake-s3.ts：地址是假的（不监听端口），fetch 层把请求转给替身的 handle；正向、反证用例都用
//   ② 真的 S3 兼容实现 LocalStack（node build/objstore.mjs up）：设了 OBJSTORE_ENDPOINT 时请求原样发过去，删除语义由它认定；只跑正向用例
// 两种后端的每个 S3 请求都记进 calls（字段和 fake-s3 的 calls 一致）。纯 TS，不用 Node、Deno 专有的 API（Workers 那套 tsc 也会查到本文件）

/** 仓库的 S3 替身要的只有这个（tests/shared/fake-s3.ts 的 createFakeS3 返回值满足） */
export interface FakeS3Backend { handle(req: Request): Promise<Response> }
/** 真的 S3 兼容实现：只许本机回环地址；桶由 build/objstore.mjs 建好（images、files、vault-images、vault-files，前缀 bucketPrefix） */
export interface RealS3Backend { endpoint: string; accessKeyId: string; secretAccessKey: string; region?: string; bucketPrefix?: string }
export type LiveS3 = FakeS3Backend | RealS3Backend;
/** 打 S3 的一个请求，测试用来断言“删完又列了一次”“没碰 B 的前缀”（bucket 已去掉前缀） */
export interface S3Call { method: string; bucket: string; key: string; query: string; status: number }

type Read = (name: string) => string | undefined;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const isLoopback = (u: string) => URL.canParse(u) && LOOPBACK.has(new URL(u).hostname);

/** 设了 OBJSTORE_ENDPOINT（和 build/objstore.mjs、ci.yml db 任务同名）就返回 LocalStack 后端，否则 null。凭据缺省是 LocalStack 的固定测试值 test / test（不是密钥） */
export function realS3Backend(read: Read): RealS3Backend | null {
  const endpoint = read('OBJSTORE_ENDPOINT');
  if (!endpoint) return null;
  return {
    endpoint,
    accessKeyId: read('OBJSTORE_ACCESS_KEY_ID') || 'test',
    secretAccessKey: read('OBJSTORE_SECRET_ACCESS_KEY') || 'test',
    region: read('OBJSTORE_REGION') || 'us-east-1',
    bucketPrefix: read('R2_BUCKET_PREFIX') ?? '',
  };
}

/** 真链路要跳过的原因（缺哪些变量），都齐了返回 null；调用方打印出来再 describe.skipIf。withRealS3：这一组还要 LocalStack */
export function liveSkipReason(read: Read, withRealS3: boolean): string | null {
  const miss = ['IT_API_URL', 'IT_DB_URL', 'IT_ANON_KEY', 'IT_SERVICE_KEY', ...(withRealS3 ? ['OBJSTORE_ENDPOINT'] : [])].filter((n) => !read(n));
  if (!miss.length) return null;
  const how = withRealS3 ? '要本地 Supabase（IT_*）和 LocalStack（node build/objstore.mjs up 后设 OBJSTORE_ENDPOINT=http://127.0.0.1:4566）' : '要本地 Supabase（IT_*）';
  return `没设 ${miss.join('、')}：${how}`;
}

export interface S3Route {
  /** 测试和函数打的 S3 地址（origin） */
  base: string;
  /** LocalStack 后端时是它，替身时 null */
  real: RealS3Backend | null;
  /** createObjStore 要的地址、凭据、桶前缀、区域（函数的 R2_* 变量也取这里的） */
  cfg: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucketPrefix: string; region?: string };
  calls: S3Call[];
  /** fetch 层：url.origin === base 的请求交给它（转给替身，或用 realFetch 原样发给 LocalStack），记一笔 */
  forward(url: URL, input: Request | URL | string, init: RequestInit | undefined, realFetch: typeof fetch): Promise<Response>;
}

/** 替身时用 fallback 的假地址和凭据；LocalStack 不是本机地址就拒绝（不打真 R2） */
export function s3Route(s3: LiveS3, fallback: { endpoint: string; accessKeyId: string; secretAccessKey: string }): S3Route {
  const real = 'endpoint' in s3 ? s3 : null;
  if (real && !isLoopback(real.endpoint)) throw new Error('live purge：OBJSTORE_ENDPOINT 只许本机回环地址（LocalStack），不打真 R2');
  const prefix = real?.bucketPrefix ?? '';
  const calls: S3Call[] = [];
  const base = new URL(real ? real.endpoint : fallback.endpoint).origin;
  const cred = real ? { accessKeyId: real.accessKeyId, secretAccessKey: real.secretAccessKey } : { accessKeyId: fallback.accessKeyId, secretAccessKey: fallback.secretAccessKey };
  return {
    base,
    real,
    cfg: { endpoint: base, ...cred, bucketPrefix: prefix, ...(real?.region ? { region: real.region } : {}) },
    calls,
    async forward(url, input, init, realFetch) {
      const req = new Request(input, init);
      const res = 'handle' in s3 ? await s3.handle(req) : await realFetch(req);
      const segs = url.pathname.split('/').slice(1);
      const bucket = decodeURIComponent(segs[0] ?? '');
      calls.push({
        method: req.method, bucket: bucket.startsWith(prefix) ? bucket.slice(prefix.length) : bucket,
        key: segs.slice(1).map(decodeURIComponent).join('/'), query: url.search.slice(1), status: res.status,
      });
      return res;
    },
  };
}
