// E2E 用的本机假后端（playwright.config.ts、playwright.real.config.ts 的 webServer 先起它，再起 wrangler pages dev）：
// 端口从 fakePorts(process.env) 取：默认 9199、9198（无后端组）；真后端组的配置经 webServer env 传 9197、9196（fake-values.ts，R-267 D1）
//   127.0.0.1:9199  S3 替身（tests/shared/fake-s3.ts：独立验 SigV4、If-None-Match 412），代替 R2；建 images、files、vault-images、vault-files
//   127.0.0.1:9198  假 Supabase：只答 /rest/v1/app_config（版本门）、/functions/v1/*（回 {forwarded, secretOk} 标记）和 /rest/v1/rpc/files_authorize（tests/functions/files-fakes.ts 的 fakeAuthz）
// 凭据全是一看就是假的固定值（FAKE…、fake-…），只给本机用；要 Docker 的真替身（LocalStack）和本地 Supabase 的一遍见 TC-B0-116【待 Docker】。
// 用法：node tests/e2e/fake-backends.ts（Node 22.18 以上，直接跑 .ts）
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fakeAuthz } from '../functions/files-fakes.ts';
import { createFakeS3 } from '../shared/fake-s3.ts';
import { DEFAULT_FAKE_PORTS, FAKE_PROXY_SECRET, FAKE_S3_KEY_ID, FAKE_S3_SECRET, fakePorts } from './fake-values.ts';

const ports = fakePorts(process.env, DEFAULT_FAKE_PORTS);

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = req.method ?? 'GET';
  return new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

function serve(port: number, handle: (r: Request) => Promise<Response>): void {
  createServer((req, res) => {
    toRequest(req, port)
      .then(handle)
      .then((r) => send(res, r))
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  }).listen(port, '127.0.0.1');
}

const s3 = createFakeS3({
  accessKeyId: FAKE_S3_KEY_ID,
  secretAccessKey: FAKE_S3_SECRET,
  region: 'auto',
  buckets: ['images', 'files', 'vault-images', 'vault-files'],
  // 模拟 R2_FILES_* 令牌只授 images、files
  allowedBuckets: ['images', 'files'],
});
const authz = fakeAuthz();

serve(ports.s3, (r) => s3.handle(r));
serve(ports.supabase, async (r) => {
  const url = new URL(r.url);
  if (url.pathname === '/rest/v1/app_config') return Response.json([{ min_client_version: '4.0.0' }]);
  if (url.pathname === '/health') return new Response('ok');
  // /functions/v1/*：回一个带标记的响应，给 b1-version-gate.spec.ts 核对转发层拼对了路径、带上了 x-proxy-secret（只回对不对，不回密钥本身）
  if (url.pathname.startsWith('/functions/v1/')) {
    return Response.json({ forwarded: url.pathname, secretOk: r.headers.get('x-proxy-secret') === FAKE_PROXY_SECRET });
  }
  return authz.fetch(r);
});
console.log(`fake backends: s3 ${ports.s3}, supabase ${ports.supabase}`);
