// 注销 runner（对象存储那一半，TC-B0-117）：生成器产出的 runner = 'objstore' 注销用例，造数据 → account-delete → account-purge → runObjProbe
// 离线：内存替身（tests/fakes/objstore-memory.ts）+ purge 替身；设了 OBJSTORE_ENDPOINT 时另打真的 S3 替身；
// 设了 IT_*（本地 Supabase）时跑真的 account-delete → account-purge 整条链路（TC-B0-117，B1）；再设了 OBJSTORE_ENDPOINT 时正向用例在 LocalStack 上再跑一遍
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import { MemoryObjStore } from '../fakes/objstore-memory.ts';
import { R2_BUCKETS, SEED_USERS, seedObjects } from '../fakes/objstore-seed.ts';
import { generate } from './generate.ts';
import {
  LIVE_S3_KEY, LIVE_S3_SECRET, LIVE_TIMEOUT_MS, liveSupabase, type LivePurge, memoryPurgeActs, type PurgeActs, purgeCases, runPurgeCases, startLivePurge,
} from './purge-runner.ts';
import { type LiveS3, liveSkipReason, realS3Backend } from './live-s3.ts';
import { createFakeS3 } from '../shared/fake-s3.ts';
import type { ObjStore } from '../../shared/objstore.ts';
import { env, liveObjStore, OBJSTORE_LIVE } from '../shared/objstore-live.ts';

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
// 真的 account-delete / account-purge 函数打本地 Supabase 的那一遍是 TC-B0-117（0.33 第 1 条挪到 B1），见文末一组。
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

// TC-B0-117 整条链路（架构 0.33 第 1 条挪到 B1）：同一个 runPurgeCases，acts 换成真的 account（delete）、account-purge 的 index.ts，
// 打本地 Supabase（IT_* 四个变量，和 store-it 同名）。说明见 purge-runner.ts 文末。
// 正向用例同一份代码、两种 S3 后端（B1 接手清单 B0-117-dev）：
//   ① 仓库替身 tests/shared/fake-s3.ts（pageSize 2，真翻页）：没设 IT_* 时跳过；
//   ② 真的 S3 兼容实现 LocalStack（OBJSTORE_ENDPOINT，node build/objstore.mjs up）：删除语义由 LocalStack 认定，没设 IT_* 或 OBJSTORE_ENDPOINT 时跳过。
// 跳过时在输出里打印原因；CI 的 db 任务两种都设了，严格模式里跳过就算失败。反证用例（下面的网络守卫、objstore-cases 的“替身回删了却没删”）只用替身。
const LIVE = liveSupabase(env);
const REAL_S3 = realS3Backend(env);

function positiveChain(title: string, skip: string | null, backend: () => LiveS3) {
  if (skip) console.warn(`[跳过] ${title}：${skip}`);
  describe.skipIf(skip !== null)(title, () => {
    let live: LivePurge | undefined;
    beforeAll(async () => {
      if (LIVE) live = await startLivePurge(LIVE, backend());
    }, LIVE_TIMEOUT_MS);
    afterAll(async () => {
      await live?.close();
    }, LIVE_TIMEOUT_MS);

    it('真的 account-delete（A 的会话）→ account-purge（冷静期注入成已满）之后四个 R2 桶里 A 为 0、B 不变', async () => {
      if (!live) throw new Error('没起来');
      const mark = live.s3Calls.length; // 只看这条用例里的请求（runPurgeCases 自己不删，DeleteObjects 只能是 account-purge 发的）
      const a = await live.mkUser('a', SEED_USERS.a);
      const b = await live.mkUser('b', SEED_USERS.b);
      const out = await runPurgeCases(cases, { store: live.store, acts: live.acts });
      expect(out).toHaveLength(4);
      for (const o of out) expect(o.problems, o.id).toEqual([]);
      expect(out.find((o) => o.id === 'TC-DEL-bucket-images')?.before).toEqual({ mode: 'count', a: 3, b: 3 });
      // 函数那一侧：这一次只删了 A；A 不在 auth.users 了，B 还在
      expect(live.lastPurge).toMatchObject({ ok: true, purged: 1, failed: 0 });
      expect([await live.userExists(a), await live.userExists(b)]).toEqual([false, true]);
      // 四个桶按前缀直接列（不经探针的正则）：A 为 0，B 和造的一样多、一个不少
      for (const bk of R2_BUCKETS) {
        expect(await live.store.listAll(bk, `${a}/`), bk).toHaveLength(0);
        const wantB = seedObjects().filter((o) => o.bucket === bk && o.owner === 'b').map((o) => o.key).sort();
        expect((await live.store.listAll(bk, `${b}/`)).map((o) => o.key).sort(), bk).toEqual(wantB);
      }
      // 每个桶都真的发过 DeleteObjects，且 S3 回 200（LocalStack 上就是它认定的删除）
      for (const bk of R2_BUCKETS) {
        const dels = live.s3Calls.slice(mark).filter((c) => c.bucket === bk && c.method === 'POST' && new URLSearchParams(c.query).has('delete'));
        expect(dels.length, `${bk} 没有 DeleteObjects`).toBeGreaterThan(0);
        expect(dels.every((c) => c.status === 200), bk).toBe(true);
      }
      // 申请注销、注销完成两封信都发给了 A（Resend 被拦下）
      expect(live.mails.filter((m) => m.startsWith('purge-it-a-')).length).toBeGreaterThanOrEqual(2);
    }, LIVE_TIMEOUT_MS);
  });
}

positiveChain('TC-B0-117 真 account-purge 整条链路（本地 Supabase + S3 替身；没设 IT_* 时跳过）', liveSkipReason(env, false), () => {
  const fake = createFakeS3({ accessKeyId: LIVE_S3_KEY, secretAccessKey: LIVE_S3_SECRET, buckets: R2_BUCKETS });
  fake.pageSize = 2; // 删前缀时真的走 ListObjectsV2 翻页
  return fake;
});
positiveChain('TC-B0-117 LocalStack 正向：真 account-purge 整条链路（本地 Supabase + LocalStack；没设 IT_* 或 OBJSTORE_ENDPOINT 时跳过）', liveSkipReason(env, true), () => {
  if (!REAL_S3) throw new Error('没设 OBJSTORE_ENDPOINT');
  return REAL_S3;
});

// 网络守卫：account 的第一封信在响应之后的后台任务里发（EdgeRuntime.waitUntil）。close 要等它结束再还原，
// 还原后 globalThis.fetch 是“只许本机”的守卫：后台晚到的发信也只会被拦下或被拒，任何时刻都打不到 api.resend.com
describe.skipIf(!LIVE)('TC-B0-117 真链路的网络守卫：后台晚到的发信被拦（没设 IT_* 时跳过）', () => {
  it('申请注销后立刻 close：后台那封信记在 mails 里（没真发）；close 之后打 api.resend.com 直接被拒', async () => {
    if (!LIVE) throw new Error('没设 IT_*');
    const fake = createFakeS3({ accessKeyId: LIVE_S3_KEY, secretAccessKey: LIVE_S3_SECRET, buckets: R2_BUCKETS });
    const real = globalThis.fetch; // startLivePurge 之前的原 fetch：close 之后不能还原成它，得是守卫
    const live = await startLivePurge(LIVE, fake);
    let closed = false;
    try {
      const u = await live.mkUser('bg');
      await live.acts.accountDelete(u); // 响应已回，信还在后台路上
      expect(live.background()).toBeGreaterThanOrEqual(1);
      await live.close();
      closed = true;
      expect(live.mails.some((m) => m.startsWith('purge-it-bg-'))).toBe(true);
      expect(globalThis.fetch).not.toBe(real);
      await expect(globalThis.fetch('https://api.resend.com/emails', { method: 'POST', body: '{}' })).rejects.toThrow(/不许连 api\.resend\.com/);
    } finally {
      if (!closed) await live.close();
    }
  }, LIVE_TIMEOUT_MS);
});
