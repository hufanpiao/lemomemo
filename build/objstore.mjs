#!/usr/bin/env node
// S3 替身（架构 8.6、0.32 第 4 条；B0 R2 任务单 O-1）：本机和 CI 里代替 Cloudflare R2。
//
// 用法（仓库根目录；本机和 CI 同一条命令）：
//   node build/objstore.mjs up       核对镜像锁定 → docker compose 起替身 → 等就绪 → 建 4 个桶 → 验四个条件
//   node build/objstore.mjs down     停掉并删掉替身（数据不留）
//   node build/objstore.mjs pin      只核对 docker-compose.objstore.yml 的镜像和 tools/ci-tools.lock 一致（不要 Docker）
//   node build/objstore.mjs buckets  只建 4 个桶（已有就跳过）
//   node build/objstore.mjs verify   只验四个条件
//
// 四个条件（架构 8.6 选定条件）：① SigV4 + path-style 读写；② PutObject 带 If-None-Match: * 在对象已存在时回 412；
// ③ ListObjectsV2 分页；④ DeleteObjects 批量删，删完再列为 0。验证用单独的临时桶，做完删掉，不碰 4 个正式桶。
//
// 替身的地址和凭据是固定的测试值（不是密钥）：OBJSTORE_ENDPOINT 默认 http://127.0.0.1:4566，凭据 test / test。
// 只认本机回环地址：防止有人把 R2 的地址填进来，在真 R2 上建桶、写删测试对象。
// 不依赖任何 npm 包（签名用 node:crypto 自己算），所以在 npm ci 之前也能跑。
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = path.join(ROOT, 'docker-compose.objstore.yml');
const LOCK = path.join(ROOT, 'tools', 'ci-tools.lock');
const LOCK_NAME = 'localstack';

const ENDPOINT = new URL(process.env.OBJSTORE_ENDPOINT ?? 'http://127.0.0.1:4566');
const ACCESS_KEY = process.env.OBJSTORE_ACCESS_KEY_ID ?? 'test';
const SECRET_KEY = process.env.OBJSTORE_SECRET_ACCESS_KEY ?? 'test';
const REGION = process.env.OBJSTORE_REGION ?? 'us-east-1';
const PREFIX = process.env.R2_BUCKET_PREFIX ?? '';
// 和清单 store = 'r2' 的 4 个桶一致（架构 0.32 第 1 条）；预览、正式在 R2 上另有前缀，本机为空
const BUCKETS = ['images', 'files', 'vault-images', 'vault-files'].map((b) => PREFIX + b);

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function assertLocal() {
  const h = ENDPOINT.hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h)) {
    fail(`OBJSTORE_ENDPOINT 必须是本机回环地址，现在是 ${ENDPOINT.origin}（这个脚本只给替身用，不要指向 R2）`);
  }
}

// ───────── 镜像锁定：compose 里的 image 必须等于 ci-tools.lock 那一行的 “文件名@sha256:哈希” ─────────
function pinnedImage() {
  const rows = readFileSync(LOCK, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/))
    .filter((c) => c.length === 6 && c[0] === LOCK_NAME && c[2] === 'oci');
  if (rows.length !== 1) fail(`tools/ci-tools.lock 里 ${LOCK_NAME} / oci 应该正好一行，现在 ${rows.length} 行`);
  const [, version, , ref, sha] = rows[0];
  if (!/^[0-9a-f]{64}$/.test(sha)) fail('tools/ci-tools.lock 里替身镜像的 digest 不是 64 位小写十六进制');
  if (!ref.endsWith(`:${version}`)) fail(`tools/ci-tools.lock 里替身镜像 ${ref} 和版本 ${version} 对不上`);
  return `${ref}@sha256:${sha}`;
}

function checkPin() {
  const want = pinnedImage();
  const images = [...readFileSync(COMPOSE, 'utf8').matchAll(/^\s*image:\s*["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  if (images.length !== 1) fail(`docker-compose.objstore.yml 里应该正好一个 image，现在 ${images.length} 个`);
  if (images[0] !== want) fail(`docker-compose.objstore.yml 的镜像 ${images[0]} 和 tools/ci-tools.lock 的 ${want} 不一致：两处一起改`);
  console.log(`替身镜像锁定一致：${want}`);
}

// ───────── SigV4（path-style；替身不在乎区域，R2 用 auto，见本机开发环境第六节） ─────────
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function s3(method, bucket, key = '', { query = {}, headers = {}, body, secret = SECRET_KEY } = {}) {
  const pathname = '/' + [bucket, ...(key ? key.split('/') : [])].map(enc).join('/');
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = now.slice(0, 8);
  const h = { ...headers, host: ENDPOINT.host, 'x-amz-date': now, 'x-amz-content-sha256': sha256hex(payload) };
  const names = Object.keys(h).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [method, pathname, qs, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), lower['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), REGION), 's3'), 'aws4_request');
  const sig = createHmac('sha256', kSign).update(toSign).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  const send = { ...lower, authorization: auth };
  delete send.host;
  const res = await fetch(`${ENDPOINT.origin}${pathname}${qs ? `?${qs}` : ''}`, {
    method,
    headers: send,
    body: body === undefined ? undefined : payload,
  });
  return { status: res.status, text: await res.text() };
}

const tagAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);

// ───────── 就绪、建桶 ─────────
async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${ENDPOINT.origin}/_localstack/health`);
      if (r.ok) {
        const s3state = (await r.json())?.services?.s3;
        if (s3state === 'running' || s3state === 'available') return console.log(`替身就绪（s3: ${s3state}）`);
      }
    } catch {
      // 容器还没起来，接着等
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  fail('替身 3 分钟内没有就绪：docker compose -f docker-compose.objstore.yml logs 看原因');
}

async function ensureBucket(b) {
  const head = await s3('HEAD', b);
  if (head.status === 200) return console.log(`  桶 ${b}：已有`);
  const r = await s3('PUT', b);
  if (r.status !== 200) fail(`建桶 ${b} 失败：HTTP ${r.status} ${r.text.slice(0, 200)}`);
  console.log(`  桶 ${b}：已建`);
}

async function buckets() {
  assertLocal();
  console.log('建桶：');
  for (const b of BUCKETS) await ensureBucket(b);
}

// ───────── 四个条件 ─────────
async function verify() {
  assertLocal();
  const t = `objstore-selftest-${randomBytes(4).toString('hex')}`;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '通过' : '不通过'}：${name}（${detail}）`);
  };
  await ensureBucket(t);
  try {
    // ① SigV4 + path-style：写、读回一样的字节
    const key = 'u/0001/a b+c.webp';
    const body = randomBytes(64);
    const put = await s3('PUT', t, key, { body, headers: { 'content-type': 'image/webp' } });
    const get = await s3('GET', t, key);
    check('① SigV4 path-style 读写', put.status === 200 && get.status === 200, `PUT ${put.status}、GET ${get.status}`);
    // 签名错了替身拒不拒：只报告、不判失败（LocalStack 对请求头签名默认不校验；签名正确性由 objstore 的单测按 AWS 公布的样例核对）
    const bad = await s3('GET', t, key, { secret: 'wrong-secret' });
    console.log(`  （信息）错误签名的 GET：HTTP ${bad.status}${bad.status === 403 ? '，替身会校验签名' : '，替身不校验签名'}`);

    // ② 条件写：新对象 200，已存在 412
    const k2 = 'u/0001/cond.bin';
    const first = await s3('PUT', t, k2, { body: 'one', headers: { 'if-none-match': '*' } });
    const second = await s3('PUT', t, k2, { body: 'two', headers: { 'if-none-match': '*' } });
    const after = await s3('GET', t, k2);
    check(
      '② If-None-Match: * 已存在回 412',
      first.status === 200 && second.status === 412 && after.text === 'one',
      `第一次 ${first.status}、第二次 ${second.status}、内容${after.text === 'one' ? '没被覆盖' : '被覆盖了'}`,
    );

    // ③ ListObjectsV2 分页：前缀 p/ 下 5 个对象，每页 2 个
    for (let i = 0; i < 5; i++) await s3('PUT', t, `p/${i}.bin`, { body: String(i) });
    const seen = [];
    let token;
    let pages = 0;
    do {
      const q = { 'list-type': '2', prefix: 'p/', 'max-keys': '2', ...(token ? { 'continuation-token': token } : {}) };
      const r = await s3('GET', t, '', { query: q });
      if (r.status !== 200) break;
      seen.push(...tagAll(r.text, 'Key'));
      token = tagAll(r.text, 'NextContinuationToken')[0];
      pages++;
    } while (token && pages < 10);
    check('③ ListObjectsV2 分页', seen.length === 5 && pages === 3, `${pages} 页、共 ${seen.length} 个`);

    // ④ DeleteObjects：一次删完，再列一次为 0
    const all = [key, k2, ...seen];
    const xml = `<Delete><Quiet>true</Quiet>${all.map((k) => `<Object><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Key></Object>`).join('')}</Delete>`;
    const md5 = createHash('md5').update(xml).digest('base64');
    const del = await s3('POST', t, '', { query: { delete: '' }, body: xml, headers: { 'content-md5': md5, 'content-type': 'application/xml' } });
    const left = await s3('GET', t, '', { query: { 'list-type': '2' } });
    const remain = tagAll(left.text, 'Key').length;
    check('④ DeleteObjects 删完再列为 0', del.status === 200 && !/<Error>/.test(del.text) && remain === 0, `POST ${del.status}、剩 ${remain} 个`);
  } finally {
    const left = await s3('GET', t, '', { query: { 'list-type': '2' } });
    for (const k of tagAll(left.text, 'Key')) await s3('DELETE', t, k);
    await s3('DELETE', t);
  }
  const bad = results.filter((r) => !r.ok);
  if (bad.length) fail(`替身不满足 ${bad.map((r) => r.name).join('、')}：按架构 8.6 换替身或找运维`);
  console.log('四个条件全部通过');
}

function compose(args) {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE, ...args], { stdio: 'inherit', cwd: ROOT });
  if (r.error) fail(`运行 docker 失败：${r.error.message}（本机要先装 Docker Desktop，见本机开发环境第三节）`);
  if (r.status !== 0) fail(`docker compose ${args.join(' ')} 失败（退出码 ${r.status}）`);
}

async function main(cmd) {
  switch (cmd) {
    case 'pin':
      return checkPin();
    case 'up':
      assertLocal();
      checkPin();
      compose(['up', '-d']);
      await waitReady();
      await buckets();
      return verify();
    case 'down':
      return compose(['down', '--volumes', '--remove-orphans']);
    case 'buckets':
      return buckets();
    case 'verify':
      return verify();
    default:
      return fail('用法：node build/objstore.mjs up | down | pin | buckets | verify');
  }
}

main(process.argv[2]).catch((e) => {
  const refused = e?.cause?.code === 'ECONNREFUSED';
  fail(refused ? `连不上 ${ENDPOINT.origin}：替身没起来？先 node build/objstore.mjs up` : String(e?.stack ?? e));
});
