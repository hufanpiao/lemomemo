// shared/objstore.ts（任务单 FB-1；架构 0.32 第 4 条、8.6）。Node（vitest）和 Deno（deno task test）跑同一组。
// 默认打内存替身 tests/shared/fake-s3.ts（独立验 SigV4、核 Content-MD5）。
// 设了 OBJSTORE_TEST_ENDPOINT / OBJSTORE_TEST_KEY_ID / OBJSTORE_TEST_SECRET 时，最后一组改打真的替身（MinIO）或 R2：
// 【待 Docker / 待 R2】本机没有 Docker，这一组目前跳过。
import { describe, expect, it } from 'vitest';
import { createObjStore, DELETE_BATCH, ObjStoreError, type ObjFetch, type ObjStore } from '../../shared/objstore.ts';
import { base64, md5, parseListV2, utf8, xmlEscape, xmlUnescape } from '../../shared/objstore-wire.ts';
import { createFakeS3, type FakeS3 } from './fake-s3.ts';

const KEY_ID = 'FAKEKEYIDLOCALTEST';
const SECRET = 'fake-secret-for-local-tests-only';
const NOW = Date.UTC(2026, 9, 28, 1, 2, 3);
const enc = new TextEncoder();
const dec = new TextDecoder();

function setup(extra: { prefix?: string; allowed?: string[]; secret?: string } = {}): { fake: FakeS3; store: ObjStore } {
  const p = extra.prefix ?? '';
  const fake = createFakeS3({
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    buckets: ['images', 'files', 'vault-images', 'vault-files'].map((b) => p + b),
    ...(extra.allowed ? { allowedBuckets: extra.allowed.map((b) => p + b) } : {}),
  });
  const fetch: ObjFetch = (url, init) => fake.handle(new Request(url, init as RequestInit));
  const store = createObjStore({
    endpoint: 'http://fake-s3.test',
    accessKeyId: KEY_ID,
    secretAccessKey: extra.secret ?? SECRET,
    bucketPrefix: p,
    fetch,
    now: () => NOW,
  });
  return { fake, store };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ObjStoreError ? e.code : `other:${String(e)}`;
  }
}

async function readAll(body: unknown): Promise<string> {
  return dec.decode(await new Response(body as BodyInit).arrayBuffer());
}

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('objstore-wire', () => {
  it('MD5 和 RFC 1321 的样例一致（DeleteObjects 的 Content-MD5 用）', () => {
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex(md5(utf8('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(utf8('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hex(md5(utf8('12345678901234567890123456789012345678901234567890123456789012345678901234567890')))).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
    expect(hex(md5(utf8('a'.repeat(1000))))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8');
  });

  it('base64 和 UTF-8 与平台实现一致', () => {
    for (const s of ['', 'a', 'ab', 'abc', '柠檬记 레몬', '😀/x']) {
      expect(dec.decode(utf8(s))).toBe(s);
      expect(Array.from(utf8(s))).toEqual(Array.from(enc.encode(s)));
      expect(base64(utf8(s))).toBe(btoa(String.fromCharCode(...enc.encode(s))));
    }
  });

  it('XML 转义来回一致；列表解析出错时报错而不是当成空', () => {
    expect(xmlUnescape(xmlEscape(`a<&>"'b`))).toBe(`a<&>"'b`);
    expect(xmlUnescape('&#x41;&#66;')).toBe('AB');
    expect(() => parseListV2('<Error><Code>x</Code></Error>')).toThrow('objstore_bad_list_xml');
    expect(() => parseListV2('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>')).toThrow('objstore_bad_list_xml');
  });
});

describe('objstore：读写', () => {
  it('put → get → head 来回一致；签名被替身独立验过', async () => {
    const { fake, store } = setup();
    const key = `${U1}/${U2}/${U2}.webp`;
    const r = await store.put('images', key, enc.encode('RIFF0000WEBPdata'), { contentType: 'image/webp' });
    expect(r.etag).toMatch(/^"[0-9a-f]{32}"$/);
    const got = await store.get('images', key);
    expect(got?.contentType).toBe('image/webp');
    expect(got?.contentLength).toBe(16);
    expect(await readAll(got?.body)).toBe('RIFF0000WEBPdata');
    expect((await store.head('images', key))?.etag).toBe(r.etag);
    expect(fake.calls.every((c) => c.status !== 403)).toBe(true);
  });

  it('没有的对象：get、head 回 null', async () => {
    const { store } = setup();
    expect(await store.get('images', `${U1}/nope.webp`)).toBeNull();
    expect(await store.head('images', `${U1}/nope.webp`)).toBeNull();
  });

  it('条件写：对象已存在时报 exists，原内容不被覆盖', async () => {
    const { fake, store } = setup();
    const key = `${U1}/${U2}/${U2}.pdf`;
    await store.put('files', key, enc.encode('first'), { contentType: 'application/pdf', ifNoneMatch: true });
    expect(await codeOf(store.put('files', key, enc.encode('second'), { contentType: 'application/pdf', ifNoneMatch: true }))).toBe('exists');
    expect(dec.decode(fake.objects.get(`files/${key}`)?.body)).toBe('first');
  });

  it('流式请求体也能传（Pages Function 用 FixedLengthStream，Node 带 duplex）', async () => {
    const { fake, store } = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('ab'));
        c.enqueue(enc.encode('cd'));
        c.close();
      },
    });
    await store.put('files', `${U1}/s.pdf`, stream, { contentType: 'application/pdf' });
    expect(dec.decode(fake.objects.get(`files/${U1}/s.pdf`)?.body)).toBe('abcd');
  });

  it('键里有空格、汉字、加号也签得对（path-style，逐段编码）', async () => {
    const { fake, store } = setup();
    for (const key of [`${U1}/a b+c.txt`, `${U1}/柠檬/(1)!*'.txt`]) {
      await store.put('files', key, enc.encode('x'), { contentType: 'text/plain' });
      expect(fake.objects.has(`files/${key}`)).toBe(true);
      expect((await store.head('files', key))?.contentLength).toBe(1);
    }
  });

  it('R2_BUCKET_PREFIX：调用方写逻辑桶名，实际打 preview- 开头的桶', async () => {
    const { fake, store } = setup({ prefix: 'preview-' });
    await store.put('images', `${U1}/x.webp`, enc.encode('x'), { contentType: 'image/webp' });
    expect(fake.objects.has(`preview-images/${U1}/x.webp`)).toBe(true);
  });

  it('令牌只授 images、files 时碰 vault-* 回 denied（模拟 R2_FILES_*）', async () => {
    const { store } = setup({ allowed: ['images', 'files'] });
    expect(await codeOf(store.put('vault-files', `${U1}/x.pdf`, enc.encode('x'), { contentType: 'application/octet-stream' }))).toBe('denied');
    expect(await codeOf(store.get('vault-images', `${U1}/x.webp`))).toBe('denied');
  });

  it('密钥不对：替身验签失败，报 denied（不会静默成功）', async () => {
    const { store } = setup({ secret: 'wrong-fake-secret' });
    expect(await codeOf(store.head('images', `${U1}/x.webp`))).toBe('denied');
  });

  it('不合规的桶名、键、Content-Type 不发请求直接报 bad_input', async () => {
    const { fake, store } = setup();
    for (const p of [
      store.get('Images', 'a'),
      store.get('images', ''),
      store.get('images', '/abs'),
      store.get('images', 'a/../b'),
      store.get('images', 'a//b'),
      store.get('images', 'a\nb'),
      store.put('images', 'a', enc.encode('x'), { contentType: 'image/webp\r\nx-evil: 1' }),
      store.deletePrefix('images', ''),
      store.list('images', '../'),
    ]) {
      expect(await codeOf(p)).toBe('bad_input');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('网络错误、5xx 分别报 network、http', async () => {
    const store = createObjStore({
      endpoint: 'http://fake-s3.test',
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      fetch: () => Promise.reject(new Error('boom')),
      now: () => NOW,
    });
    expect(await codeOf(store.head('images', 'a'))).toBe('network');
    const { fake, store: s2 } = setup();
    fake.failNext = 503;
    const e = await s2.head('images', 'a').catch((x: unknown) => x);
    expect(e instanceof ObjStoreError && e.code === 'http' && e.status === 503).toBe(true);
  });

  it('报错信息里不带键名和地址（日志不留路径，14.2 第 8 点）', async () => {
    const { fake, store } = setup();
    fake.failNext = 500;
    const e = await store.get('images', `${U1}/secret-name.webp`).catch((x: unknown) => x);
    expect(String(e instanceof Error ? e.message : e)).toBe('objstore_http_500');
  });
});

describe('objstore：列和删（注销、清理用）', () => {
  async function fill(store: ObjStore, bucket: string, prefix: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await store.put(bucket, `${prefix}${String(i).padStart(5, '0')}.webp`, enc.encode('x'), { contentType: 'image/webp' });
    }
  }

  it('list 翻页、listAll 拿全；前缀不串到别人', async () => {
    const { fake, store } = setup();
    fake.pageSize = 3;
    await fill(store, 'images', `${U1}/`, 7);
    await fill(store, 'images', `${U2}/`, 2);
    const p1 = await store.list('images', `${U1}/`);
    expect(p1.objects).toHaveLength(3);
    expect(p1.nextToken === null).toBe(false);
    const all = await store.listAll('images', `${U1}/`);
    expect(all).toHaveLength(7);
    expect(all.every((o) => o.key.startsWith(`${U1}/`) && o.size === 1)).toBe(true);
  });

  it('deleteMany 每次最多 1000 个：2500 个分 3 次删完', async () => {
    const { fake, store } = setup();
    const keys = Array.from({ length: 2500 }, (_, i) => `${U1}/${i}.webp`);
    for (const k of keys) fake.objects.set(`images/${k}`, { body: new Uint8Array(1), contentType: 'image/webp', etag: '"x"' });
    expect(DELETE_BATCH).toBe(1000);
    expect(await store.deleteMany('images', keys)).toBe(2500);
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(3);
    expect(fake.objects.size).toBe(0);
  });

  it('deletePrefix：删完再列一次为 0；别人的不动', async () => {
    const { fake, store } = setup();
    fake.pageSize = 2;
    await fill(store, 'files', `${U1}/`, 5);
    await fill(store, 'files', `${U2}/`, 1);
    expect(await store.deletePrefix('files', `${U1}/`)).toEqual({ deleted: 5 });
    expect(await store.listAll('files', `${U1}/`)).toHaveLength(0);
    expect(await store.listAll('files', `${U2}/`)).toHaveLength(1);
    // 最后一次是“再列一次”的确认
    const last = fake.calls[fake.calls.length - 1];
    expect(last?.method).toBe('GET');
    expect(last?.query).toContain('list-type=2');
  });

  it('有删失败的报 delete_partial；回了“删了”其实没删的，再列一次发现报 not_empty', async () => {
    const { fake, store } = setup();
    await fill(store, 'files', `${U1}/`, 2);
    fake.failDelete.add(`${U1}/00000.webp`);
    expect(await codeOf(store.deletePrefix('files', `${U1}/`))).toBe('delete_partial');
    fake.failDelete.clear();
    fake.ignoreDelete.add(`${U1}/00000.webp`); // 上一步 00001 已删掉，只剩 00000
    expect(await codeOf(store.deletePrefix('files', `${U1}/`))).toBe('not_empty');
  });

  it('空前缀什么都不删也不报错', async () => {
    const { store } = setup();
    expect(await store.deletePrefix('images', `${U1}/`)).toEqual({ deleted: 0 });
  });
});

// ---------- 打真的替身（MinIO）或 R2：【待 Docker / 待 R2】 ----------

function env(name: string): string | undefined {
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return p?.env?.[name];
  } catch {
    return undefined; // Deno 没给 --allow-env
  }
}

const LIVE = env('OBJSTORE_TEST_ENDPOINT');

describe('objstore：打真的 S3 替身（待 Docker / 待 R2；没设 OBJSTORE_TEST_ENDPOINT 时跳过）', () => {
  if (!LIVE) {
    it('跳过：本机没有替身（运维 O-1 写好 docker-compose.objstore.yml 后在 CI 跑）', () => {
      expect(LIVE).toBe(undefined);
    });
    return;
  }
  const store = createObjStore({
    endpoint: LIVE,
    accessKeyId: env('OBJSTORE_TEST_KEY_ID') ?? '',
    secretAccessKey: env('OBJSTORE_TEST_SECRET') ?? '',
    bucketPrefix: env('OBJSTORE_TEST_BUCKET_PREFIX') ?? '',
    region: env('OBJSTORE_TEST_REGION') ?? 'auto',
    fetch: (url, init) => fetch(url, init as RequestInit),
    now: () => Date.now(),
  });
  const run = `objstore-test-${Date.now().toString(36)}`;
  it('条件写回 exists、列、批量删、删完为 0（架构 8.6 的四个条件）', async () => {
    const key = `${run}/a.pdf`;
    await store.put('files', key, enc.encode('one'), { contentType: 'application/pdf', ifNoneMatch: true });
    expect(await codeOf(store.put('files', key, enc.encode('two'), { contentType: 'application/pdf', ifNoneMatch: true }))).toBe('exists');
    expect(await readAll((await store.get('files', key))?.body)).toBe('one');
    for (let i = 0; i < 5; i++) await store.put('files', `${run}/${i}.pdf`, enc.encode('x'), { contentType: 'application/pdf' });
    expect(await store.listAll('files', `${run}/`)).toHaveLength(6);
    expect(await store.deletePrefix('files', `${run}/`)).toEqual({ deleted: 6 });
  });
});
