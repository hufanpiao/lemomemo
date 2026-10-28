// 对象存储内存替身和测试数据的自测（任务单 BE-5）：替身的行为要和 S3 / R2 对调用方承诺的一致，否则拿它测出来的“通过”不可信
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import { DELETE_BATCH_MAX, listAll, MemoryObjStore } from '../fakes/objstore-memory.ts';
import { R2_BUCKETS, SEED_USERS, seedObjects } from '../fakes/objstore-seed.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
async function text(s: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(s).text();
}

describe('MemoryObjStore', () => {
  it('put / get / head：内容、类型、etag；get 是流', async () => {
    const s = new MemoryObjStore(['images']);
    const r = await s.put('images', 'k', bytes('abc'), { contentType: 'image/webp' });
    expect(r.ok).toBe(true);
    const g = await s.get('images', 'k');
    expect(g && (await text(g.body))).toBe('abc');
    expect(await s.head('images', 'k')).toMatchObject({ size: 3, contentType: 'image/webp', etag: r.ok ? r.etag : '' });
    expect(await s.get('images', 'nope')).toBeNull();
    expect(await s.head('images', 'nope')).toBeNull();
  });

  it('条件写：对象已在时回 exists，内容不变（TC-B0-108 的存储一侧）；不带条件时覆盖', async () => {
    const s = new MemoryObjStore(['files']);
    await s.put('files', 'k', bytes('first'), { contentType: 'application/pdf', ifNoneMatch: '*' });
    expect(await s.put('files', 'k', bytes('second'), { contentType: 'application/pdf', ifNoneMatch: '*' })).toEqual({ ok: false, code: 'exists' });
    const g = await s.get('files', 'k');
    expect(g && (await text(g.body))).toBe('first');
    await s.put('files', 'k', bytes('third'), { contentType: 'application/pdf' });
    const g2 = await s.get('files', 'k');
    expect(g2 && (await text(g2.body))).toBe('third');
  });

  it('流式上传也能写；不传 contentType 抛错（TC-B0-75）', async () => {
    const s = new MemoryObjStore(['images']);
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes('ab')); c.enqueue(bytes('c')); c.close(); } });
    expect((await s.put('images', 'k', body, { contentType: 'image/webp' })).ok).toBe(true);
    expect((await s.head('images', 'k'))?.size).toBe(3);
    await expect(s.put('images', 'k2', bytes('x'), { contentType: '' })).rejects.toThrow('content_type_required');
  });

  it('list：按前缀、按 key 排序、分页翻完不重不漏', async () => {
    const s = new MemoryObjStore(['images']);
    for (let i = 0; i < 25; i++) await s.put('images', `u/${String(i).padStart(2, '0')}`, bytes('x'), { contentType: 'image/webp' });
    await s.put('images', 'v/0', bytes('x'), { contentType: 'image/webp' });
    const p1 = await s.list('images', 'u/', { maxKeys: 10 });
    expect(p1.items.map((x) => x.key)).toEqual(Array.from({ length: 10 }, (_, i) => `u/${String(i).padStart(2, '0')}`));
    expect(p1.nextToken).not.toBeNull();
    const all = await listAll(s, 'images', 'u/', 10);
    expect(all).toHaveLength(25);
    expect(new Set(all.map((x) => x.key)).size).toBe(25);
    expect((await s.list('images', 'u/')).nextToken).toBeNull();
  });

  it('deleteMany：每次最多 1000 个，超了抛错；不存在的 key 也不报错', async () => {
    const s = new MemoryObjStore(['files']);
    await s.put('files', 'a', bytes('x'), { contentType: 'application/pdf' });
    expect(await s.deleteMany('files', ['a', 'nope'])).toEqual({ deleted: 2 });
    expect(s.count('files', '')).toBe(0);
    await expect(s.deleteMany('files', Array.from({ length: DELETE_BATCH_MAX + 1 }, (_, i) => `k${i}`))).rejects.toThrow('delete_batch_too_large');
  });

  it('没建的桶抛 NoSuchBucket；failOnce 模拟一次失败；calls 记下每次调用', async () => {
    const s = new MemoryObjStore(['images']);
    await expect(s.head('backups', 'k')).rejects.toThrow('NoSuchBucket');
    s.failOnce('list');
    await expect(s.list('images', '')).rejects.toThrow('objstore_unavailable');
    expect((await s.list('images', '')).items).toEqual([]);
    expect(s.calls.map((c) => c.op)).toEqual(['head', 'list', 'list']);
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

  it('A、B 在四个桶里都有对象（注销用例前置：TC-B0-117）', async () => {
    const s = new MemoryObjStore(R2_BUCKETS);
    for (const o of seedObjects()) await s.put(o.bucket, o.key, o.body, { contentType: o.contentType, ifNoneMatch: '*' });
    for (const b of R2_BUCKETS) for (const u of Object.values(SEED_USERS)) expect(s.count(b, `${u}/`), `${b} ${u}`).toBeGreaterThan(0);
    expect([...R2_BUCKETS].sort()).toEqual(allManifests.flatMap((m) => m.buckets).filter((b) => b.store === 'r2' && b.limits).map((b) => b.name).sort());
  });
});
