// 对象存储内存替身和测试数据的自测（任务单 BE-5）：替身的行为要和 shared/objstore.ts 对调用方承诺的一致，否则拿它测出来的“通过”不可信
// 同一组断言再对真客户端（shared/objstore.ts + tests/shared/fake-s3.ts 的内存 S3）跑一遍：两边结果一样，才说明替身没“自说自话”
import { describe, expect, it } from 'vitest';
import { createObjStore, type ObjFetch, type ObjStore, ObjStoreError } from '../../shared/objstore.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { MemoryObjStore } from '../fakes/objstore-memory.ts';
import { countSeedUsers, putSeedObjects, R2_BUCKETS, SEED_USERS, seedObjects } from '../fakes/objstore-seed.ts';
import { createFakeS3 } from '../shared/fake-s3.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (s: unknown) => new Response(s as ReadableStream<Uint8Array>).text();

function realStore(buckets: readonly string[]): ObjStore {
  const fake = createFakeS3({ accessKeyId: 'FAKEKEYIDLOCALTEST', secretAccessKey: 'fake-secret-for-local-tests-only', buckets: [...buckets] });
  const fetch: ObjFetch = (url, init) => fake.handle(new Request(url, init as RequestInit));
  return createObjStore({
    endpoint: 'http://fake-s3.test',
    accessKeyId: 'FAKEKEYIDLOCALTEST',
    secretAccessKey: 'fake-secret-for-local-tests-only',
    fetch,
    now: () => Date.UTC(2026, 9, 28),
  });
}

const code = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) { return e instanceof ObjStoreError ? e.code : String(e); }
};

const impls: [string, (b: readonly string[]) => ObjStore][] = [
  ['内存替身', (b) => new MemoryObjStore(b)],
  ['真客户端 + 内存 S3', realStore],
];

describe.each(impls)('ObjStore 行为（%s）', (_, make) => {
  it('put / get / head：内容、类型、长度、etag；get 是流；不存在回 null', async () => {
    const s = make(['images']);
    const r = await s.put('images', 'u/k.webp', bytes('abc'), { contentType: 'image/webp' });
    expect(r.etag).toBeTruthy();
    const g = await s.get('images', 'u/k.webp');
    expect(g && (await text(g.body))).toBe('abc');
    expect(g).toMatchObject({ contentType: 'image/webp', contentLength: 3, etag: r.etag });
    expect(await s.head('images', 'u/k.webp')).toEqual({ contentType: 'image/webp', contentLength: 3, etag: r.etag });
    expect(await s.get('images', 'u/nope')).toBeNull();
    expect(await s.head('images', 'u/nope')).toBeNull();
  });

  it.each([[true], ['*' as const]])('条件写（ifNoneMatch = %j）：对象已在时抛 exists，内容不变（TC-B0-108 的存储一侧）', async (inm) => {
    const s = make(['files']);
    await s.put('files', 'u/k.pdf', bytes('first'), { contentType: 'application/pdf', ifNoneMatch: inm });
    expect(await code(s.put('files', 'u/k.pdf', bytes('second'), { contentType: 'application/pdf', ifNoneMatch: inm }))).toBe('exists');
    const g = await s.get('files', 'u/k.pdf');
    expect(g && (await text(g.body))).toBe('first');
  });

  it('流式上传也能写；不传 contentType、键不合规抛 bad_input（TC-B0-75）', async () => {
    const s = make(['images']);
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes('ab')); c.enqueue(bytes('c')); c.close(); } });
    await s.put('images', 'u/k', body, { contentType: 'image/webp' });
    expect((await s.head('images', 'u/k'))?.contentLength).toBe(3);
    expect(await code(s.put('images', 'u/k2', bytes('x'), { contentType: '' }))).toBe('bad_input');
    for (const k of ['', '/a', 'a//b', 'a/../b']) expect(await code(s.put('images', k, bytes('x'), { contentType: 'image/webp' })), k).toBe('bad_input');
  });

  it('list / listAll：按前缀、按 key 排序、{ objects, nextToken }，continuationToken 翻完不重不漏', async () => {
    const s = make(['images']);
    for (let i = 0; i < 25; i++) await s.put('images', `u/${String(i).padStart(2, '0')}`, bytes('x'), { contentType: 'image/webp' });
    await s.put('images', 'v/0', bytes('x'), { contentType: 'image/webp' });
    const p1 = await s.list('images', 'u/', { maxKeys: 10 });
    expect(p1.objects.map((x) => x.key)).toEqual(Array.from({ length: 10 }, (_, i) => `u/${String(i).padStart(2, '0')}`));
    expect(p1.objects[0]).toMatchObject({ size: 1 });
    expect(p1.nextToken).not.toBeNull();
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const page: Awaited<ReturnType<ObjStore['list']>> = await s.list('images', 'u/', token ? { continuationToken: token, maxKeys: 10 } : { maxKeys: 10 });
      keys.push(...page.objects.map((o) => o.key));
      token = page.nextToken;
    } while (token);
    expect(keys).toHaveLength(25);
    expect(new Set(keys).size).toBe(25);
    expect((await s.listAll('images', 'u/')).map((o) => o.key)).toEqual(keys);
    expect((await s.list('images', 'u/')).nextToken).toBeNull();
    expect(await code(s.list('images', 'u/', { maxKeys: 1001 }))).toBe('bad_input');
  });

  it('deleteMany：返回个数，超过 1000 个自己拆批；不存在的 key 也不报错', async () => {
    const s = make(['files']);
    await s.put('files', 'u/a', bytes('x'), { contentType: 'application/pdf' });
    expect(await s.deleteMany('files', ['u/a', 'u/nope'])).toBe(2);
    expect(await s.listAll('files', '')).toEqual([]);
    expect(await s.deleteMany('files', Array.from({ length: 1001 }, (_, i) => `u/k${i}`))).toBe(1001);
  });

  it('deletePrefix：只删这个前缀，回 { deleted }；空前缀抛 bad_input', async () => {
    const s = make(['files']);
    for (const k of ['a/1', 'a/2', 'ab/1', 'b/1']) await s.put('files', k, bytes('x'), { contentType: 'application/pdf' });
    expect(await s.deletePrefix('files', 'a/')).toEqual({ deleted: 2 });
    expect((await s.listAll('files', '')).map((o) => o.key)).toEqual(['ab/1', 'b/1']);
    expect(await s.deletePrefix('files', 'a/')).toEqual({ deleted: 0 });
    expect(await code(s.deletePrefix('files', ''))).toBe('bad_input');
  });

  it('没建的桶：list、put、deleteMany 抛 http 404（S3 的 NoSuchBucket），head、get 回 null', async () => {
    const s = make(['images']);
    expect(await s.head('backups', 'k')).toBeNull();
    expect(await s.get('backups', 'k')).toBeNull();
    for (const p of [s.put('backups', 'k', bytes('x'), { contentType: 'image/webp' }), s.deleteMany('backups', ['k'])]) {
      const x = await p.catch((err: unknown) => err);
      expect(x instanceof ObjStoreError && x.code === 'http' && x.status === 404).toBe(true);
    }
    const e = await s.list('backups', '').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ObjStoreError);
    expect((e as ObjStoreError).code).toBe('http');
    expect((e as ObjStoreError).status).toBe(404);
  });
});

describe('MemoryObjStore 的测试辅助', () => {
  it('failOnce 模拟一次失败；calls 记下每次调用；deletePrefix 删完又列了一次（TC-B0-117）', async () => {
    const s = new MemoryObjStore(['images']);
    s.failOnce('list');
    expect(await code(s.list('images', ''))).toBe('network');
    expect((await s.list('images', '')).objects).toEqual([]);
    await s.put('images', 'u/1', bytes('x'), { contentType: 'image/webp' });
    s.calls.length = 0;
    await s.deletePrefix('images', 'u/');
    expect(s.calls.map((c) => c.op)).toEqual(['list', 'deleteMany', 'list']);
  });

  it('删的同时又有对象写进来：deletePrefix 抛 not_empty', async () => {
    class Racy extends MemoryObjStore {
      override async deleteMany(bucket: string, keys: readonly string[]): Promise<number> {
        const n = await super.deleteMany(bucket, keys);
        this.plant(bucket, 'u/late', bytes('x'));
        return n;
      }
    }
    const s = new Racy(['images']);
    await s.put('images', 'u/1', bytes('x'), { contentType: 'image/webp' });
    expect(await code(s.deletePrefix('images', 'u/'))).toBe('not_empty');
  });

  it('deleteMany 超过 1000 个时按 1000 一批记调用', async () => {
    const s = new MemoryObjStore(['files']);
    await s.deleteMany('files', Array.from({ length: 2001 }, (_, i) => `u/k${i}`));
    expect(s.calls.map((c) => c.n)).toEqual([1000, 1000, 1]);
  });
});

describe('测试数据（objstore-seed）', () => {
  it('每个对象的路径都符合它那个桶在清单里的某一段 pathPattern，桶都是 store = r2', () => {
    const segs = allManifests.flatMap((m) => m.buckets);
    for (const o of seedObjects()) {
      const mine = segs.filter((b) => b.name === o.bucket);
      expect(mine.length, o.bucket).toBeGreaterThan(0);
      expect(mine.every((b) => b.store === 'r2'), o.bucket).toBe(true);
      expect(mine.some((b) => new RegExp(b.pathPattern).test(o.key)), `${o.bucket}/${o.key}`).toBe(true);
      expect(o.key.startsWith(`${SEED_USERS[o.owner]}/`)).toBe(true);
    }
  });

  it.each(impls)('putSeedObjects / countSeedUsers：A、B 在四个桶里都有对象；重复跑不覆盖（%s）', async (_, make) => {
    const s = make(R2_BUCKETS);
    const n = seedObjects().length;
    expect(await putSeedObjects(s)).toEqual({ put: n, existed: 0 });
    expect(await putSeedObjects(s)).toEqual({ put: 0, existed: n });
    const counts = await countSeedUsers(s);
    for (const b of R2_BUCKETS) for (const u of ['a', 'b'] as const) expect(counts[b][u], `${b} ${u}`).toBeGreaterThan(0);
    expect([...R2_BUCKETS].sort()).toEqual(allManifests.flatMap((m) => m.buckets).filter((b) => b.store === 'r2' && b.limits).map((b) => b.name).sort());
  });
});
