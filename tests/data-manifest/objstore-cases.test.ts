// FB-6、TC-B0-117：store = 'r2' 的桶的注销、孤儿、临时桶用例由生成器产出对象存储探针，不手写；
// 探针在内存 S3 替身（tests/shared/fake-s3.ts，经真的 shared/objstore.ts）上数得对。打 LocalStack 替身、真 R2 的一遍【待 Docker / 待 R2】。
import { describe, expect, it } from 'vitest';
import { createObjStore, type ObjFetch } from '../../shared/objstore.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { createFakeS3 } from '../shared/fake-s3.ts';
import { ManifestError, generate } from './generate.ts';
import { describeObjProbe } from './objstore-cases.ts';
import { matches, runObjProbe } from './objstore-probe.ts';
import { sampleManifests } from './sample-manifests.ts';
import type { Manifest } from './types.ts';

const R2 = ['images', 'files', 'vault-images', 'vault-files'];
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const N = '11111111-0000-4000-8000-000000000001';
const I = '22222222-0000-4000-8000-000000000002';

const real = generate(allManifests).cases;
const byId = (id: string) => real.find((c) => c.id === id);

function fakeStore(prefix = '') {
  const fake = createFakeS3({ accessKeyId: 'FAKEKEYIDLOCALTEST', secretAccessKey: 'fake-secret-for-local-tests-only', buckets: R2.map((b) => prefix + b) });
  const fetch: ObjFetch = (url, init) => fake.handle(new Request(url, init as RequestInit));
  const store = createObjStore({
    endpoint: 'http://fake-s3.test',
    accessKeyId: 'FAKEKEYIDLOCALTEST',
    secretAccessKey: 'fake-secret-for-local-tests-only',
    bucketPrefix: prefix,
    fetch,
    now: () => Date.UTC(2026, 9, 28),
  });
  return { fake, store };
}

const put = (s: ReturnType<typeof fakeStore>['store'], bucket: string, key: string) =>
  s.put(bucket, key, new TextEncoder().encode('x'), { contentType: 'application/octet-stream' });

describe('生成器：R2 桶用对象存储探针（真清单）', () => {
  it('四个 R2 桶各一条注销用例，runner = objstore，不查 storage.objects', () => {
    for (const b of R2) {
      const c = byId(`TC-DEL-bucket-${b}`);
      expect(c?.runner, b).toBe('objstore');
      expect(c?.target).toBe(`r2:${b}`);
      expect(c?.probe).toBeUndefined();
      expect(c?.objProbe?.mode).toBe('count');
    }
    for (const c of real.filter((x) => x.runner === 'objstore')) expect(JSON.stringify(c)).not.toContain('storage.objects');
  });

  it('Supabase 的桶（backups、vault-preview）照旧是 SQL 探针', () => {
    expect(byId('TC-DEL-bucket-backups')?.runner).toBe('sql');
    expect(byId('TC-DEL-bucket-backups')?.probe?.a).toContain('storage.objects');
    expect(byId('TC-DEL-bucket-vault-preview')?.probe?.a).toContain('private.vault_preview');
  });

  it('images 两段（notes 插图、anniv 头像）合成一条，两个选择器都按 <user> 前缀列，正则照抄清单', () => {
    const c = byId('TC-DEL-bucket-images');
    expect(c?.manifests.sort()).toEqual(['anniv', 'notes']);
    const sels = c?.objProbe?.selectors ?? [];
    expect(sels.map((s) => s.prefix).sort()).toEqual(['<user>/', '<user>/anniv/']);
    const patterns = allManifests.flatMap((m) => m.buckets).filter((b) => b.name === 'images').map((b) => b.pathPattern);
    expect(sels.map((s) => s.pattern).sort()).toEqual([...patterns].sort());
    expect(describeObjProbe(c?.objProbe ?? { bucket: 'x', mode: 'snapshot' })).toContain('<user>/anniv/');
  });

  it('R2 桶的孤儿清理用例也走对象存储（head :old_id、:new_id）', () => {
    const orphans = real.filter((c) => c.kind === 'orphan-sweep' && c.target.startsWith('r2:'));
    expect(orphans.map((c) => c.id).sort()).toEqual(['TC-ORPHAN-files', 'TC-ORPHAN-images', 'TC-ORPHAN-images-anniv', 'TC-ORPHAN-vault-files', 'TC-ORPHAN-vault-images']);
    for (const c of orphans) expect(c.objProbe).toEqual({ bucket: c.target.slice(3), mode: 'head', keys: [':old_id', ':new_id'] });
  });

  it('同一个桶几段的 store 不一致、R2 桶按登记表找人：生成时就报错', () => {
    const notes = sampleManifests.find((m) => m.feature === 'notes');
    const mixed: Manifest[] = sampleManifests.map((m) =>
      m === notes ? { ...m, buckets: (m.buckets ?? []).map((b) => ({ ...b, store: 'r2' as const })) } : m,
    );
    expect(() => generate(mixed)).toThrow(/store 不一致/);
    const registry: Manifest[] = sampleManifests.map((m) =>
      m.feature === 'vault' ? { ...m, buckets: (m.buckets ?? []).map((b) => ({ ...b, store: 'r2' as const })) } : m,
    );
    expect(() => generate(registry)).toThrow(ManifestError);
  });
});

describe('runner：探针在 S3 替身上数得对（经 shared/objstore.ts）', () => {
  it.each([[''], ['preview-']])('每个 R2 桶每一段都造 A、B 的对象，A 删完为 0，B 不变（R2_BUCKET_PREFIX = %j）', async (prefix) => {
    const { store, fake } = fakeStore(prefix);
    const probes = R2.map((b) => byId(`TC-DEL-bucket-${b}`)?.objProbe).filter((p) => p !== undefined);
    expect(probes).toHaveLength(4);
    for (const u of [A, B]) {
      await put(store, 'images', `${u}/${N}/${I}.webp`);
      await put(store, 'images', `${u}/${N}/${I}.t.webp`);
      await put(store, 'images', `${u}/anniv/${N}/${I}.webp`);
      await put(store, 'files', `${u}/${N}/${I}.pdf`);
      await put(store, 'vault-images', `${u}/${N}/${I}.webp`);
      await put(store, 'vault-files', `${u}/${N}/${I}.t.webp`);
    }
    // 不合清单正则的 key 不算（防止探针数成“前缀下所有东西”）
    await put(store, 'files', `${A}/${N}/notes.txt`);
    const vars = { user_a: A, user_b: B };
    const before = await Promise.all(probes.map((p) => runObjProbe(store, p, vars)));
    expect(before).toEqual([
      { mode: 'count', a: 3, b: 3 },
      { mode: 'count', a: 1, b: 1 },
      { mode: 'count', a: 1, b: 1 },
      { mode: 'count', a: 1, b: 1 },
    ]);
    for (const b of R2) await store.deletePrefix(b, `${A}/`);
    const after = await Promise.all(probes.map((p) => runObjProbe(store, p, vars)));
    expect(after.map((r) => (r.mode === 'count' ? [r.a, r.b] : null))).toEqual([[0, 3], [0, 1], [0, 1], [0, 1]]);
    // 真的打到了带前缀的桶
    expect([...fake.objects.keys()].every((k) => k.startsWith(prefix))).toBe(true);
  });

  it('head 模式：:old_id 清掉、:new_id 还在', async () => {
    const { store } = fakeStore();
    const oldKey = `${A}/${N}/${I}.webp`;
    const newKey = `${A}/${N}/33333333-0000-4000-8000-000000000003.webp`;
    await put(store, 'images', newKey);
    const p = byId('TC-ORPHAN-images')?.objProbe;
    expect(p).toBeDefined();
    if (!p) return;
    expect(await runObjProbe(store, p, { user_a: A, user_b: B, keys: { ':old_id': oldKey, ':new_id': newKey } })).toEqual({
      mode: 'head',
      present: { ':old_id': false, ':new_id': true },
    });
    await expect(runObjProbe(store, p, { user_a: A, user_b: B })).rejects.toThrow(/:old_id/);
  });

  it('snapshot 模式和按第几级目录找人的选择器', async () => {
    const { store } = fakeStore();
    await put(store, 'files', `${A}/${N}/${I}.pdf`);
    const snap = await runObjProbe(store, { bucket: 'files', mode: 'snapshot' }, { user_a: A, user_b: B });
    expect(snap).toEqual({ mode: 'snapshot', digest: `${A}/${N}/${I}.pdf` });
    const lvl = { prefix: '', level: 2, pattern: '^\\d{4}-\\d{2}-\\d{2}/[0-9a-f-]{36}/x\\.gz$' };
    expect(matches(lvl, `2026-10-28/${A}/x.gz`, A)).toBe(true);
    expect(matches(lvl, `2026-10-28/${B}/x.gz`, A)).toBe(false);
    expect(matches(lvl, `${A}/2026-10-28/x.gz`, A)).toBe(false);
    await expect(runObjProbe(store, { bucket: 'files', mode: 'count', selectors: [] }, { user_a: A, user_b: B })).rejects.toThrow();
    await expect(runObjProbe(store, { bucket: 'files', mode: 'snapshot' }, { user_a: A, user_b: A })).rejects.toThrow();
  });
});

// 【待 Docker / 待 R2】同样的探针打 LocalStack 替身（node build/objstore.mjs up 之后，CI 的 db 任务）和预览环境的 R2：
// 后端的注销 runner（tests/data-manifest/purge-runner.ts）已把 runner = 'objstore' 的用例接上（造数据 → account-delete → account-purge → runObjProbe），
// 离线用内存替身跑通（purge-runner.test.ts）；打真替身那一遍待 Docker、待 B1 的 account-purge。
describe.skip('TC-B0-117 整条链路（待 Docker：本地 Supabase + S3 替身 + account-purge）', () => {
  it('account-purge 之后四个 R2 桶里 A 的对象为 0、删完再列一次确认、B 不变', () => {});
});
