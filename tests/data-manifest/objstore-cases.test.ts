// FB-6、TC-B0-117：store = 'r2' 的桶的注销、孤儿、临时桶用例由生成器产出对象存储探针，不手写；
// 探针在内存 S3 替身（tests/shared/fake-s3.ts，经真的 shared/objstore.ts）上数得对；设了 OBJSTORE_ENDPOINT 时另打真的 S3 替身；
// 设了 IT_*（本地 Supabase）时，探针在真的 account-delete → account-purge 前后数（TC-B0-117，B1）；再设了 OBJSTORE_ENDPOINT 时正向用例在 LocalStack 上再跑一遍。真 R2 的一遍由负责人做。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createObjStore, type ObjFetch } from '../../shared/objstore.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { createFakeS3 } from '../shared/fake-s3.ts';
import { ManifestError, generate } from './generate.ts';
import { describeObjProbe } from './objstore-cases.ts';
import { matches, runObjProbe } from './objstore-probe.ts';
import { sampleManifests } from './sample-manifests.ts';
import { env, liveObjStore, OBJSTORE_LIVE } from '../shared/objstore-live.ts';
import { LIVE_S3_KEY, LIVE_S3_SECRET, LIVE_TIMEOUT_MS, liveSupabase, type LivePurge, startLivePurge } from './purge-runner.ts';
import { liveSkipReason, realS3Backend } from './live-s3.ts';
import type { ObjStore } from '../../shared/objstore.ts';
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
    endpoint: 'https://fake-s3.test',
    accessKeyId: 'FAKEKEYIDLOCALTEST',
    secretAccessKey: 'fake-secret-for-local-tests-only',
    bucketPrefix: prefix,
    fetch,
    now: () => Date.UTC(2026, 9, 28),
  });
  return { fake, store };
}

const put = (s: Pick<ObjStore, 'put'>, bucket: string, key: string) =>
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

// 架构 0.33 第 1、13 条：同样的探针打真的 S3 替身（node build/objstore.mjs up 之后，CI 的 db 任务），没设 OBJSTORE_ENDPOINT 时跳过。
// 这是 B0 留下的“探针在替身上能列前缀数个数”；A、B 用随机 uuid，不和 purge-runner.test.ts（用 SEED_USERS）同时跑时互相踩。
describe.skipIf(!OBJSTORE_LIVE)('探针打真的 S3 替身（没设 OBJSTORE_ENDPOINT 时跳过）', () => {
  it('四个 R2 桶：生成的 count 探针数得对（含头像段、缩略图），删掉 A 之后 A 为 0、B 不变', async () => {
    const store = liveObjStore();
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const keys = (u: string) => ({
      images: [`${u}/${N}/${I}.webp`, `${u}/${N}/${I}.t.webp`, `${u}/anniv/${N}/${I}.webp`],
      files: [`${u}/${N}/${I}.pdf`, `${u}/${N}/${I}.t.webp`],
      'vault-images': [`${u}/${N}/${I}.webp`],
      'vault-files': [`${u}/${N}/${I}.pdf`],
    });
    try {
      for (const u of [a, b]) for (const [bucket, ks] of Object.entries(keys(u))) for (const k of ks) await put(store, bucket, k);
      for (const bucket of R2) {
        const c = byId(`TC-DEL-bucket-${bucket}`);
        const want = keys(a)[bucket as keyof ReturnType<typeof keys>].length;
        expect(await runObjProbe(store, c?.objProbe ?? { bucket, mode: 'count' }, { user_a: a, user_b: b }), bucket).toEqual({ mode: 'count', a: want, b: want });
        await store.deletePrefix(bucket, `${a}/`);
        expect(await runObjProbe(store, c?.objProbe ?? { bucket, mode: 'count' }, { user_a: a, user_b: b }), bucket).toEqual({ mode: 'count', a: 0, b: want });
      }
    } finally {
      for (const bucket of R2) for (const u of [a, b]) await store.deletePrefix(bucket, `${u}/`);
    }
  });
});

// QA D-03、架构 0.33 第 1 条：TC-B0-117 整条链路挪到 B1。生成的 count 探针在真的 account-delete → account-purge 前后各数一次：
// 本地 Supabase（IT_* 四个变量，和 store-it 同名）+ S3 后端 + 两个函数的真 index.ts（purge-runner.ts 文末）。
// A、B 用随机 id 的真 Auth 用户（不和 purge-runner.test.ts 的 SEED_USERS 撞；两个文件靠 pg_advisory_lock 串行）。
// 正向用例同一份代码、两种 S3 后端（B1 接手清单 B0-117-dev）：仓库替身（真签名、真验签，pageSize = 2 要翻页；没设 IT_* 时跳过）和
// LocalStack（OBJSTORE_ENDPOINT；删除语义由它认定；没设 IT_* 或 OBJSTORE_ENDPOINT 时跳过）。反证用例（替身回“删了”却没删）只在替身上跑。
// 跳过时打印原因；CI 严格模式里跳过算失败。
const LIVE_SB = liveSupabase(env);
const REAL_S3 = realS3Backend(env);
const probeKeys = (u: string): Record<string, string[]> => ({
  images: [`${u}/${N}/${I}.webp`, `${u}/${N}/${I}.t.webp`, `${u}/anniv/${N}/${I}.webp`],
  files: [`${u}/${N}/${I}.pdf`, `${u}/${N}/${I}.t.webp`],
  'vault-images': [`${u}/${N}/${I}.webp`, `${u}/${N}/${I}.t.webp`],
  'vault-files': [`${u}/${N}/${I}.pdf`],
});
const POSITIVE = 'account-purge 之后四个 R2 桶里 A 的对象为 0、删完再列一次确认、B 不变';

/** 正向用例的测试体：两种后端共用（live 由各自的 beforeAll 建好） */
const positiveProbe = (getLive: () => LivePurge | undefined) => async () => {
  const live = getLive();
  if (!live) throw new Error('没起来');
  const store = live.store;
  const keys = probeKeys;
  const a = await live.mkUser('ca'), b = await live.mkUser('cb');
  for (const u of [a, b]) for (const [bucket, ks] of Object.entries(keys(u))) for (const k of ks) await put(live.store, bucket, k);
  const vars = { user_a: a, user_b: b };
  const probeAll = () => Promise.all(R2.map((bk) => runObjProbe(store, byId(`TC-DEL-bucket-${bk}`)?.objProbe ?? { bucket: bk, mode: 'count' }, vars)));
  const want = R2.map((bk) => ({ mode: 'count', a: keys(a)[bk]?.length, b: keys(b)[bk]?.length }));
  expect(await probeAll()).toEqual(want);

  await live.acts.accountDelete(a);
  expect(await probeAll()).toEqual(want); // 冷静期里一个都不少

  const mark = live.s3Calls.length;
  await live.acts.accountPurge(a);
  const calls = live.s3Calls.slice(mark); // 只看 account-purge 发的请求（下面探针自己的列表不算）
  expect(live.lastPurge).toMatchObject({ purged: 1, failed: 0 });
  expect(await probeAll()).toEqual(want.map((w) => ({ ...w, a: 0 })));
  expect([await live.userExists(a), await live.userExists(b)]).toEqual([false, true]);

  // 删完再列一次：每个桶 account-purge 发的请求里，A 前缀的最后一次 DeleteObjects 之后还有一次 A 前缀的 ListObjectsV2，且回 200
  const prefixOf = (q: string) => new URLSearchParams(q).get('prefix');
  for (const bk of R2) {
    const lastDel = calls.findLastIndex((c) => c.bucket === bk && c.method === 'POST' && new URLSearchParams(c.query).has('delete'));
    const lastList = calls.findLastIndex((c) => c.bucket === bk && c.method === 'GET' && prefixOf(c.query) === `${a}/`);
    expect(lastDel, `${bk} 没有 DeleteObjects`).toBeGreaterThanOrEqual(0);
    expect(calls[lastDel]?.status, `${bk} DeleteObjects`).toBe(200);
    expect(lastList, `${bk} 删完没有再列`).toBeGreaterThan(lastDel);
    expect(calls[lastList]?.status).toBe(200);
    // 没碰 B 的前缀
    expect(calls.some((c) => c.bucket === bk && prefixOf(c.query) === `${b}/`), bk).toBe(false);
  }
  // B 的每个对象逐个 head 还在
  for (const [bucket, ks] of Object.entries(keys(b))) for (const k of ks) expect(await live.store.head(bucket, k), `${bucket}/${k}`).not.toBeNull();
};

const FAKE_TITLE = 'TC-B0-117 真 account-purge：生成的探针前后数（本地 Supabase + S3 替身；没设 IT_* 时跳过）';
const fakeSkip = liveSkipReason(env, false);
if (fakeSkip) console.warn(`[跳过] ${FAKE_TITLE}：${fakeSkip}`);

describe.skipIf(!LIVE_SB)(FAKE_TITLE, () => {
  let live: LivePurge | undefined;
  const fake = createFakeS3({ accessKeyId: LIVE_S3_KEY, secretAccessKey: LIVE_S3_SECRET, buckets: R2 });
  fake.pageSize = 2;
  beforeAll(async () => {
    if (LIVE_SB) live = await startLivePurge(LIVE_SB, fake);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  }, LIVE_TIMEOUT_MS);

  it(POSITIVE, positiveProbe(() => live), LIVE_TIMEOUT_MS);

  it('删完再列一次是真的：替身对 A 的一个对象回“删了”却没删，account-purge 判失败（原因是 R2 再列不为 0）、不删账号，A 留在桶里', async () => {
    if (!live) throw new Error('没起来');
    const a = await live.mkUser('cx');
    const stuck = `${a}/${N}/${I}.pdf`;
    await put(live.store, 'files', stuck);
    await live.acts.accountDelete(a);
    fake.ignoreDelete.add(stuck);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(live.acts.accountPurge(a)).rejects.toThrow(/失败 0 个/);
      expect(live.lastPurge).toMatchObject({ purged: 0, failed: 1 });
      // 失败原因只能是“R2 删完再列不为 0”（index.ts 的日志 account-purge: <码>:<user_id 前 8 位>），不是别的步骤出错
      const codes = logs.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('account-purge: '));
      expect(codes).toContain(`account-purge: r2_not_empty:${a.slice(0, 8)}`);
      expect(codes.filter((m) => m.endsWith(`:${a.slice(0, 8)}`))).toEqual([`account-purge: r2_not_empty:${a.slice(0, 8)}`]);
      expect(await live.userExists(a)).toBe(true);
      expect(await live.store.listAll('files', `${a}/`)).toHaveLength(1);
    } finally {
      logs.mockRestore();
      fake.ignoreDelete.delete(stuck);
    }
  }, LIVE_TIMEOUT_MS);
});

const LS_TITLE = 'TC-B0-117 LocalStack 正向：生成的探针前后数（本地 Supabase + LocalStack；没设 IT_* 或 OBJSTORE_ENDPOINT 时跳过）';
const lsSkip = liveSkipReason(env, true);
if (lsSkip) console.warn(`[跳过] ${LS_TITLE}：${lsSkip}`);

describe.skipIf(lsSkip !== null)(LS_TITLE, () => {
  let live: LivePurge | undefined;
  beforeAll(async () => {
    if (LIVE_SB && REAL_S3) live = await startLivePurge(LIVE_SB, REAL_S3);
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  }, LIVE_TIMEOUT_MS);

  it(POSITIVE, positiveProbe(() => live), LIVE_TIMEOUT_MS);
});
