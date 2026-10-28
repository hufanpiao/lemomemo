// 注销 runner（对象存储那一半，TC-B0-117）：生成器产出的 runner = 'objstore' 注销用例，造数据 → account-delete → account-purge → runObjProbe
// 离线：内存替身（tests/fakes/objstore-memory.ts）+ purge 替身；设了 OBJSTORE_ENDPOINT 时另打真的 S3 替身；真的 account-purge 那一遍随 TC-B0-117 到 B1
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import { MemoryObjStore } from '../fakes/objstore-memory.ts';
import { R2_BUCKETS, SEED_USERS, seedObjects } from '../fakes/objstore-seed.ts';
import { generate } from './generate.ts';
import { memoryPurgeActs, type PurgeActs, purgeCases, runPurgeCases } from './purge-runner.ts';
import type { ObjStore } from '../../shared/objstore.ts';
import { liveObjStore, OBJSTORE_LIVE } from '../shared/objstore-live.ts';

const cases = generate(allManifests).cases;

describe('注销 runner（离线：内存替身）', () => {
  it('四个 R2 桶的注销用例都归这个 runner，SQL 的不归', () => {
    expect(purgeCases(cases).map((c) => c.id).sort()).toEqual(R2_BUCKETS.map((b) => `TC-DEL-bucket-${b}`).sort());
  });

  it('全过：冷静期里不少，account-purge 后 A 为 0、B 不变，删完又列了一次', async () => {
    const store = new MemoryObjStore(R2_BUCKETS);
    const acts = memoryPurgeActs(store, allManifests);
    const out = await runPurgeCases(cases, { store, acts });
    for (const o of out) expect(o.problems, o.id).toEqual([]);
    expect(out).toHaveLength(4);
    const images = out.find((o) => o.id === 'TC-DEL-bucket-images');
    expect(images?.before).toEqual({ mode: 'count', a: 3, b: 3 });
    expect(images?.afterPurge).toEqual({ mode: 'count', a: 0, b: 3 });
    for (const b of R2_BUCKETS) {
      expect(store.count(b, `${SEED_USERS.a}/`), b).toBe(0);
      expect(store.count(b, `${SEED_USERS.b}/`), b).toBe(seedObjects().filter((o) => o.bucket === b && o.owner === 'b').length);
    }
    // 每个桶 deletePrefix 都是“列 → 删 → 再列一次”
    const ops = store.calls.filter((c) => c.op === 'deleteMany').map((c) => c.bucket);
    expect(ops.sort()).toEqual([...R2_BUCKETS].sort());
    expect(acts.pending.size).toBe(0);
  });

  it('account-purge 没删：每条都报“A 还剩”', async () => {
    const store = new MemoryObjStore(R2_BUCKETS);
    const noop: PurgeActs = { accountDelete: async () => {}, accountPurge: async () => {} };
    const out = await runPurgeCases(cases, { store, acts: noop });
    expect(out.every((o) => !o.ok && o.problems.some((p) => p.includes('A 还剩')))).toBe(true);
  });

  it('account-delete 就删了（没等冷静期）、purge 顺手删了 B：都报出来', async () => {
    const store = new MemoryObjStore(R2_BUCKETS);
    const eager = memoryPurgeActs(store, allManifests);
    const acts: PurgeActs = {
      accountDelete: async (u) => { await eager.accountDelete(u); await eager.accountPurge(u); },
      accountPurge: async () => { for (const b of R2_BUCKETS) await store.deletePrefix(b, `${SEED_USERS.b}/`); },
    };
    const out = await runPurgeCases(cases, { store, acts });
    for (const o of out) {
      expect(o.problems.some((p) => p.includes('冷静期里对象变了')), o.id).toBe(true);
      expect(o.problems.some((p) => p.includes('动了 B 的对象')), o.id).toBe(true);
    }
  });

  it('造的数据少了一段（头像段）：报“没覆盖”，不让“删完为 0”蒙混过关', async () => {
    const store = new MemoryObjStore(R2_BUCKETS);
    const seed = seedObjects().filter((o) => !o.key.includes('/anniv/'));
    const out = await runPurgeCases(cases, { store, acts: memoryPurgeActs(store, allManifests), seed });
    const images = out.find((o) => o.id === 'TC-DEL-bucket-images');
    expect(images?.ok).toBe(false);
    expect(images?.problems.join('|')).toContain('<user>/anniv/');
    expect(out.filter((o) => o.id !== 'TC-DEL-bucket-images').every((o) => o.ok)).toBe(true);
  });

  it('purge 替身：没先 account-delete 就 purge 报错；存储失败往上抛', async () => {
    const store = new MemoryObjStore(R2_BUCKETS);
    const acts = memoryPurgeActs(store, allManifests);
    await expect(acts.accountPurge(SEED_USERS.a)).rejects.toThrow('account_purge_not_pending');
    await acts.accountDelete(SEED_USERS.a);
    store.failOnce('deleteMany');
    await store.put('images', `${SEED_USERS.a}/x`, new Uint8Array([1]), { contentType: 'image/webp' });
    await expect(acts.accountPurge(SEED_USERS.a)).rejects.toThrow('objstore_network');
  });
});

// 架构 0.33 第 13 条（代码审查中 2 ②）：同一个 runPurgeCases 打真的 S3 替身（LocalStack，node build/objstore.mjs up），没设 OBJSTORE_ENDPOINT 时跳过。
// B0 能跑的是“生成的探针用例在真替身上列前缀、数个数”（架构 0.33 第 1 条留在 B0 的部分）：acts 仍用 memoryPurgeActs，
// 但它删对象走的是真客户端（shared/objstore.ts 的 deletePrefix、deleteMany）打真替身。
// 真的 account-delete / account-purge 函数打本地 Supabase 的那一遍是 TC-B0-117，0.33 第 1 条挪到 B1，留 todo。
describe.skipIf(!OBJSTORE_LIVE)('注销 runner：探针打真的 S3 替身（没设 OBJSTORE_ENDPOINT 时跳过）', () => {
  async function clean(store: ObjStore) {
    for (const b of R2_BUCKETS) for (const u of Object.values(SEED_USERS)) await store.deletePrefix(b, `${u}/`);
  }

  it('四个 R2 桶：造数据 → 冷静期里不少 → purge 后 A 为 0、B 不变（删对象走真客户端）', async () => {
    const store = liveObjStore();
    await clean(store); // 替身里可能有 seed.mjs 或上一次留下的同一批 key
    try {
      const out = await runPurgeCases(cases, { store, acts: memoryPurgeActs(store, allManifests) });
      expect(out).toHaveLength(4);
      for (const o of out) expect(o.problems, o.id).toEqual([]);
      expect(out.find((o) => o.id === 'TC-DEL-bucket-images')?.before).toEqual({ mode: 'count', a: 3, b: 3 });
      for (const b of R2_BUCKETS) {
        expect(await store.listAll(b, `${SEED_USERS.a}/`), b).toHaveLength(0);
        expect((await store.listAll(b, `${SEED_USERS.b}/`)).length, b).toBe(seedObjects().filter((o) => o.bucket === b && o.owner === 'b').length);
      }
    } finally {
      await clean(store);
    }
  });

  it('purge 什么都没删：真替身上同样每条都报“A 还剩”', async () => {
    const store = liveObjStore();
    await clean(store);
    try {
      const noop: PurgeActs = { accountDelete: async () => {}, accountPurge: async () => {} };
      const out = await runPurgeCases(cases, { store, acts: noop });
      expect(out.every((o) => !o.ok && o.problems.some((p) => p.includes('A 还剩')))).toBe(true);
    } finally {
      await clean(store);
    }
  });
});

describe('TC-B0-117 整条链路（架构 0.33 第 1 条挪到 B1）', () => {
  it.todo('真的 account-delete（A 的会话）→ account-purge（冷静期注入成已满）之后四个 R2 桶里 A 为 0、B 不变（要 B1 的 account-purge、本地 Supabase 和 S3 替身）');
});
