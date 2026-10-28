// shared/objstore.ts 和 shared/objstore-net.ts 的防呆（B0 第一轮评审返工；objstore.test.ts 超过 300 行，拆出来）：
// 请求超时（代码审查中 3）、不用的响应体取消（代码审查低 1）、deletePrefix 只认 <uuid>/（代码审查低 2、安全审查低 3）、
// 非本机地址不许 http（安全审查低 2）。Node（vitest）和 Deno（deno task test）跑同一组；不连网络，fetch 都是假的。
import { describe, expect, it } from 'vitest';
import { createObjStore, ObjStoreError, type ObjFetch, type ObjResponse, type ObjStore, type ObjStoreConfig } from '../../shared/objstore.ts';
import { createFakeS3, type FakeS3 } from './fake-s3.ts';

const KEY_ID = 'FAKEKEYIDLOCALTEST';
const SECRET = 'fake-secret-for-local-tests-only';
const NOW = Date.UTC(2026, 9, 28, 1, 2, 3);
const enc = new TextEncoder();
const dec = new TextDecoder();
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

function setup(): { fake: FakeS3; store: ObjStore } {
  const fake = createFakeS3({ accessKeyId: KEY_ID, secretAccessKey: SECRET, buckets: ['images', 'files', 'vault-images', 'vault-files'] });
  const fetch: ObjFetch = (url, init) => fake.handle(new Request(url, init as RequestInit));
  return { fake, store: createObjStore({ endpoint: 'https://fake-s3.test', accessKeyId: KEY_ID, secretAccessKey: SECRET, fetch, now: () => NOW }) };
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 带 cancel 计数的假响应体；text() 可以设成永远不回 */
function fakeRes(status: number, opts: { text?: () => Promise<string>; headers?: Record<string, string> } = {}) {
  const st = { cancelled: 0 };
  const body = {
    cancel: () => {
      st.cancelled++;
      return Promise.resolve();
    },
  };
  const h = opts.headers ?? {};
  const res: ObjResponse = {
    status,
    headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
    body,
    text: opts.text ?? (() => Promise.resolve('')),
  };
  return { res, st };
}

function rawStore(fetch: ObjFetch, extra: Partial<ObjStoreConfig> = {}): ObjStore {
  return createObjStore({ endpoint: 'https://fake-s3.test', accessKeyId: KEY_ID, secretAccessKey: SECRET, fetch, now: () => NOW, ...extra });
}

describe('objstore：请求超时（代码审查 中 3）', () => {
  it('fetch 一直不回：五种操作都报 timeout，并且中止了请求', async () => {
    const signals: { aborted: boolean }[] = [];
    const hang: ObjFetch = (_u, init) => {
      signals.push(init.signal as { aborted: boolean });
      return new Promise(() => {});
    };
    const s = rawStore(hang, { timeoutMs: 20, transferTimeoutMs: 30 });
    expect(await codeOf(s.head('images', `${U1}/a.webp`))).toBe('timeout');
    expect(await codeOf(s.list('images', `${U1}/`))).toBe('timeout');
    expect(await codeOf(s.deleteMany('images', [`${U1}/a.webp`]))).toBe('timeout');
    expect(await codeOf(s.get('images', `${U1}/a.webp`))).toBe('timeout');
    expect(await codeOf(s.put('images', `${U1}/a.webp`, enc.encode('x'), { contentType: 'image/webp' }))).toBe('timeout');
    expect(signals).toHaveLength(5);
    expect(signals.every((x) => x.aborted)).toBe(true);
  });

  it('put、get 用较长的 transferTimeoutMs；list、head、删除用 timeoutMs', async () => {
    const slow: ObjFetch = async () => {
      await sleep(150);
      return fakeRes(200).res;
    };
    const s = rawStore(slow, { timeoutMs: 20, transferTimeoutMs: 2000 });
    expect(await codeOf(s.put('files', `${U1}/a.pdf`, enc.encode('x'), { contentType: 'application/pdf' }))).toBe(null);
    expect(await codeOf(s.get('files', `${U1}/a.pdf`))).toBe(null);
    expect(await codeOf(s.head('files', `${U1}/a.pdf`))).toBe('timeout');
  });

  it('get 只给“拿到响应头”计时：调用方慢慢读响应体不算超时、不被中止', async () => {
    let signal: { aborted: boolean } | null = null;
    const f: ObjFetch = (_u, init) => {
      signal = init.signal as { aborted: boolean };
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(enc.encode('abc')); c.close(); } }),
        text: () => Promise.resolve(''),
      });
    };
    const s = rawStore(f, { transferTimeoutMs: 20 });
    const got = await s.get('files', `${U1}/a.pdf`);
    await sleep(60);
    expect(signal === null ? null : (signal as { aborted: boolean }).aborted).toBe(false);
    expect(await readAll(got?.body)).toBe('abc');
  });

  it('list 读响应体（XML）也在计时内：体一直不来也报 timeout', async () => {
    const f: ObjFetch = () => Promise.resolve(fakeRes(200, { text: () => new Promise(() => {}) }).res);
    expect(await codeOf(rawStore(f, { timeoutMs: 20 }).list('images', `${U1}/`))).toBe('timeout');
  });

  it('超时以后才回来的响应：响应体被取消（不占连接）', async () => {
    const late = fakeRes(200);
    const f: ObjFetch = async () => {
      await sleep(60);
      return late.res;
    };
    expect(await codeOf(rawStore(f, { timeoutMs: 10 }).head('images', `${U1}/a.webp`))).toBe('timeout');
    await sleep(150);
    expect(late.st.cancelled).toBe(1);
  });

  it('超时参数不合规（0、负数、非整数）直接报 bad_input', () => {
    const f: ObjFetch = () => Promise.resolve(fakeRes(200).res);
    for (const t of [0, -1, 1.5, Number.NaN]) {
      expect(() => rawStore(f, { timeoutMs: t })).toThrow('objstore_bad_input');
      expect(() => rawStore(f, { transferTimeoutMs: t })).toThrow('objstore_bad_input');
    }
  });
});

describe('objstore：不用的响应体一律取消（代码审查 低 1）', () => {
  it('404、412、403、5xx 和 put 的 200：响应体都被 cancel；get 200 的体交给调用方，不取消', async () => {
    const cases: [number, (s: ObjStore) => Promise<unknown>, string | null][] = [
      [404, (s) => s.get('files', `${U1}/a.pdf`), null],
      [404, (s) => s.head('files', `${U1}/a.pdf`), null],
      [500, (s) => s.get('files', `${U1}/a.pdf`), 'http'],
      [403, (s) => s.head('files', `${U1}/a.pdf`), 'denied'],
      [200, (s) => s.put('files', `${U1}/a.pdf`, enc.encode('x'), { contentType: 'application/pdf' }), null],
      [412, (s) => s.put('files', `${U1}/a.pdf`, enc.encode('x'), { contentType: 'application/pdf', ifNoneMatch: true }), 'exists'],
      [503, (s) => s.put('files', `${U1}/a.pdf`, enc.encode('x'), { contentType: 'application/pdf' }), 'http'],
      [500, (s) => s.list('files', `${U1}/`), 'http'],
      [500, (s) => s.deleteMany('files', [`${U1}/a.pdf`]), 'http'],
    ];
    for (const [status, op, want] of cases) {
      const r = fakeRes(status);
      const s = rawStore(() => Promise.resolve(r.res));
      expect(await codeOf(op(s)), `${status}`).toBe(want);
      expect(r.st.cancelled, `${status} ${want ?? 'ok'}`).toBe(1);
    }
    const ok = fakeRes(200);
    await rawStore(() => Promise.resolve(ok.res)).get('files', `${U1}/a.pdf`);
    expect(ok.st.cancelled).toBe(0);
  });
});

describe('objstore：deletePrefix 只认 <uuid>/（代码审查 低 2、安全审查 低 3）', () => {
  it('不是“小写 uuid + /”的前缀一律 bad_input，一个请求都不发', async () => {
    const { fake, store } = setup();
    for (const p of [
      U1, // 少了 /
      `${U1}//`,
      `${U1}/x/`, // 只许整个人的前缀
      `${U1}/${U2}/`,
      'AAAAAAAA-0000-4000-8000-00000000000A/', // 大写
      `${U1.slice(0, 35)}/`, // 短一位
      `${U1}0/`,
      'a/',
      'objstore-test/',
      '/',
      `x${U1}/`,
      `../${U1}/`,
    ]) {
      expect(await codeOf(store.deletePrefix('files', p)), p).toBe('bad_input');
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe('objstore：非本机地址不许 http（安全审查 低 2）', () => {
  const f: ObjFetch = () => Promise.resolve(fakeRes(200).res);
  it('https 任何主机、http 只许 127.0.0.1 / localhost / [::1]', () => {
    for (const ep of ['https://abc.r2.cloudflarestorage.com', 'https://fake-s3.test/', 'http://127.0.0.1:4566', 'http://localhost:4566', 'http://[::1]:4566', 'http://127.0.0.1']) {
      expect(() => rawStore(f, { endpoint: ep }), ep).not.toThrow();
    }
    for (const ep of [
      'http://fake-s3.test',
      'http://abc.r2.cloudflarestorage.com',
      'http://127.0.0.1.evil.test:4566',
      'http://localhost.evil.test',
      'http://user@127.0.0.1:4566',
      'http://127.0.0.2:4566',
      'ftp://127.0.0.1',
      'https://x.test/path',
      'HTTP://127.0.0.1:4566',
    ]) {
      expect(() => rawStore(f, { endpoint: ep }), ep).toThrow('objstore_bad_input');
    }
  });
});
