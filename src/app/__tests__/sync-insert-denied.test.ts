// Q-15（R-382）：管理员停用账号后，本机未发的“新建”走 PostgREST upsert，只被 RLS 的 with check（private.is_active()）拦，
// 回 403、code 42501，带不出 account_disabled。修法 A：新建回 42501 时先探测一次账号状态（account status）——
// 已停用就按 R-382 的停用路径（发 disabled、只关库不清、写 reason 'disabled' 的记号、回登录页）；正常或探测不出照旧 permanent。
// 一轮发送里多条 42501 只探测一次；“重试”重发也不是每次都探测（5 分钟内不再探）；改、软删走 apply_patch，不探测；
// 冷静期按冷静期退出；被拒的会话和本机对不上不探测；探测期间封存不写回；退出时沿用第一次探测的结果、不因第二次不确定而清库
// 用真引擎（createSync）跑发送，只换掉网络（fakeTransport）和 status 探测
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions, type BootResult } from '../../core/boot.ts';
import { claimCache } from '../../core/account.ts';
import { clearAllCollections } from '../../core/store.ts';
import { createSync, type SyncOptions } from '../../core/sync/engine.ts';
import { fakeLife, fakeTransport, type FakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB, type FakeIDBFactory } from '../../core/__tests__/idb-fake.ts';
import { seed, todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import type { OutboxEvent, OutboxItem } from '../../core/outbox-types.ts';
import type { AccountProbe } from '../../platform/account-status.ts';
import { readReauth } from '../../platform/auth-loss-store.ts';
import { wireSync } from '../sync-wiring.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';
const DENIED = { status: 403, code: '42501' };

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

let clock = 1_000_000;

/** 新建一律回 403 42501（RLS with check 拦下）；patch 照常 */
function deniedTransport(): FakeTransport {
  const t = fakeTransport();
  t.sid = S;
  t.insertRow = async (table, data) => {
    t.calls.push(`insert:${table}:${String(data['id'])}`);
    return { ok: false, error: { ...DENIED } };
  };
  return t;
}

async function start(
  probe: (token: string) => Promise<AccountProbe>, t: FakeTransport = deniedTransport(),
  session: { sid: string | null; token: string | null } = { sid: S, token: 'tok-1' },
) {
  const { factory, fake } = fakeIndexedDB();
  const boot = await coldStart(opts(factory));
  if (!boot.cache || !boot.outbox) throw new Error('no cache');
  await claimCache(boot.cache, A);
  const events: OutboxEvent[] = [];
  boot.outbox.onEvent((e) => events.push(e));
  const d = {
    transport: t,
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    clearLocalSessionIf: vi.fn(),
    resolveAuthLoss: vi.fn(() => Promise.resolve('removed' as const)),
    goToAuth: vi.fn(),
    setExitNotice: vi.fn((_n: string, _sid?: string | null) => undefined),
    readExitNotice: vi.fn((): null => null),
    clearLogs: vi.fn(),
    log: vi.fn((..._a: unknown[]) => undefined),
    probeAccount: vi.fn(probe),
    readSession: vi.fn(() => ({ ...session })),
    reload: vi.fn(),
    now: () => clock,
    create: (b: BootResult, o: SyncOptions) => createSync(b, { ...o, lifecycle: fakeLife(), skipConfig: true, now: () => clock }),
  };
  const sync = wireSync(boot, d);
  if (!sync) throw new Error('no sync');
  return { boot, fake, d, t, sync, events };
}

const outboxSize = (fake: FakeIDBFactory): number => fake.dbs.get('planner-v4')?.stores.get('outbox')?.records.size ?? 0;

async function items(boot: BootResult): Promise<OutboxItem[]> {
  const ob = boot.outbox;
  if (!ob) throw new Error('no outbox');
  return ob.list();
}

beforeEach(() => {
  clearAllCollections();
  clock = 1_000_000;
});
afterEach(() => {
  localStorage.clear();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('Q-15：新建回 403 42501 时探测账号状态', () => {
  it('复现：探测为已停用 → 发 disabled、只关库不清（队列还在）、记号 reason disabled、回登录页；探测只打一次', async () => {
    // 探测结果等入队完成后再给：入队会马上踢一次发送，探测立刻回 disabled 会在 enqueue 自己收尾前关库
    let release = (): void => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const r = await start(async () => {
      await gate;
      return { kind: 'disabled' };
    });
    await r.boot.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    release();
    await r.sync.sendNow();
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(r.events).toContainEqual({ type: 'disabled', code: 'account_disabled', sid: S });
    expect(r.d.probeAccount).toHaveBeenCalledTimes(1);
    expect(r.d.probeAccount).toHaveBeenCalledWith('tok-1');
    expect(readReauth()).toMatchObject({ user_id: A, reason: 'disabled' });
    expect(r.boot.cache?.isClosed()).toBe(true);
    expect(r.fake.dbs.has('planner-v4')).toBe(true);
    expect(outboxSize(r.fake)).toBeGreaterThan(0);
    expect(r.d.clearCacheStorage).not.toHaveBeenCalled();
    expect(r.d.setExitNotice).toHaveBeenCalledWith('disabled', S);
    expect(r.d.clearLocalSessionIf).toHaveBeenCalledWith(S);
  });

  for (const [name, probe] of [
    ['探测正常（active）', async (): Promise<AccountProbe> => ({ kind: 'active' })],
    ['探测失败（unknown）', async (): Promise<AccountProbe> => ({ kind: 'unknown' })],
    ['探测抛错', async (): Promise<AccountProbe> => Promise.reject(new Error('boom'))],
  ] as const) {
    it(`${name} → 照旧 permanent：进失败区（error 42501），不发 disabled、不退出、不关库`, async () => {
      const r = await start(probe);
      await r.boot.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
      await r.sync.sendNow();
      await vi.waitFor(async () => expect((await items(r.boot)).map((i) => i.state)).toEqual(['failed']));
      expect((await items(r.boot))[0]?.error).toBe('42501');
      expect(r.d.probeAccount).toHaveBeenCalledTimes(1);
      expect(r.events.some((e) => e.type === 'disabled' || e.type === 'removed')).toBe(false);
      expect(r.d.goToAuth).not.toHaveBeenCalled();
      expect(r.d.reload).not.toHaveBeenCalled();
      expect(r.boot.cache?.isClosed()).toBe(false);
      expect(r.boot.switching).toBe(false);
    });
  }

  it('一轮发送里三条新建都回 42501：只探测一次，三条都进失败区', async () => {
    const r = await start(async () => ({ kind: 'active' }));
    const ob = r.boot.outbox;
    if (!ob) throw new Error('outbox');
    for (const n of [1, 2, 3]) await ob.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
    await r.sync.sendNow();
    await vi.waitFor(async () => expect((await items(r.boot)).map((i) => i.state)).toEqual(['failed', 'failed', 'failed']));
    expect(r.t.calls.filter((c) => c.startsWith('insert:'))).toHaveLength(3);
    expect(r.d.probeAccount).toHaveBeenCalledTimes(1);
  });

  it('点“重试”重发（42501 给重试）：5 分钟内不再探测，过了 5 分钟才再探一次', async () => {
    const r = await start(async () => ({ kind: 'active' }));
    const ob = r.boot.outbox;
    if (!ob) throw new Error('outbox');
    await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await r.sync.sendNow();
    await vi.waitFor(async () => expect((await items(r.boot)).map((i) => i.state)).toEqual(['failed']));
    const retry = async (): Promise<void> => {
      const [it0] = await items(r.boot);
      await ob.retryFailed([it0?.op_id ?? '']);
      await r.sync.sendNow();
      await vi.waitFor(async () => expect((await items(r.boot)).map((i) => i.state)).toEqual(['failed']));
    };
    clock += 60_000;
    await retry();
    expect(r.t.calls.filter((c) => c.startsWith('insert:'))).toHaveLength(2);
    expect(r.d.probeAccount).toHaveBeenCalledTimes(1);
    clock += 5 * 60_000;
    await retry();
    expect(r.d.probeAccount).toHaveBeenCalledTimes(2);
  });

  it('探测为冷静期（pending_deletion）→ 按冷静期退出：清库、不删会话（不调 clearLocalSessionIf）、退出原因 pending_deletion', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const r = await start(async () => {
      await gate;
      return { kind: 'pending_deletion', purgeAfter: null };
    });
    await r.boot.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    release();
    await r.sync.sendNow();
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(r.events).toContainEqual({ type: 'disabled', code: 'account_disabled', sid: S });
    expect(r.d.probeAccount).toHaveBeenCalledTimes(1);
    expect(r.d.setExitNotice).toHaveBeenCalledWith('pending_deletion', S);
    expect(r.d.clearLocalSessionIf).not.toHaveBeenCalled();
    expect(r.d.clearCacheStorage).toHaveBeenCalledTimes(1);
    expect(r.boot.cache?.isClosed()).toBe(true);
  });

  it('沿用第一次探测的结果：探出已停用后令牌刚好刷新、第二次探测会回 unknown，也不再探第二次、不落成 disabled_unsure 清库', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const session = { sid: S as string | null, token: 'tok-1' as string | null };
    let n = 0;
    const r = await start(async () => {
      await gate;
      n += 1;
      if (n > 1) return { kind: 'unknown' };
      session.token = 'tok-2';   // 第一次探测期间令牌刷新了
      return { kind: 'disabled' };
    }, deniedTransport(), session);
    await r.boot.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    release();
    await r.sync.sendNow();
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(r.d.probeAccount).toHaveBeenCalledTimes(1);
    expect(r.d.setExitNotice).toHaveBeenCalledWith('disabled', S);
    expect(r.d.setExitNotice.mock.calls.map((c) => c[0])).not.toContain('disabled_unsure');
    expect(readReauth()).toMatchObject({ user_id: A, reason: 'disabled' });
    expect(r.d.clearCacheStorage).not.toHaveBeenCalled();
    expect(outboxSize(r.fake)).toBeGreaterThan(0);
  });

  it('被拒那次请求的会话和本机会话对不上（别的标签页换了人）：不探测，照旧 permanent', async () => {
    const r = await start(async () => ({ kind: 'disabled' }), deniedTransport(), { sid: 's-other', token: 'tok-other' });
    await r.boot.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await r.sync.sendNow();
    await vi.waitFor(async () => expect((await items(r.boot)).map((i) => i.state)).toEqual(['failed']));
    expect(r.d.probeAccount).not.toHaveBeenCalled();
    expect(r.events.some((e) => e.type === 'disabled')).toBe(false);
    expect(r.d.goToAuth).not.toHaveBeenCalled();
  });

  it('探测期间库被封存（换账号、清库）：不写回——这一项不进失败区、不发 disabled、不退出', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((res) => (release = res));
    let probing = false;
    const r = await start(async () => {
      probing = true;
      await gate;
      return { kind: 'disabled' };
    });
    const ob = r.boot.outbox;
    if (!ob) throw new Error('outbox');
    const fail = vi.spyOn(ob, 'fail');
    await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await vi.waitFor(() => expect(probing).toBe(true));
    r.boot.cache?.seal();
    release();
    await r.sync.idle();
    expect(fail).not.toHaveBeenCalled();
    expect((await items(r.boot)).map((i) => i.state)).toEqual(['inflight']);
    expect(r.events.some((e) => e.type === 'disabled' || e.type === 'error')).toBe(false);
    expect(r.d.goToAuth).not.toHaveBeenCalled();
  });

  it('改（apply_patch）回 42501：不探测，照旧 permanent', async () => {
    const t = fakeTransport();
    t.sid = S;
    const r = await start(async () => ({ kind: 'disabled' }), t);
    const ob = r.boot.outbox;
    if (!ob) throw new Error('outbox');
    const row = t.server.insert('todos', todo(1));
    if (!r.boot.cache) throw new Error('no cache');
    await seed(r.boot.cache, 'todos', uid(1), todo(1), row.rev);
    t.failNext.push({ ...DENIED });
    await ob.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
    await r.sync.sendNow();
    await vi.waitFor(async () => expect((await items(r.boot)).map((i) => i.state)).toEqual(['failed']));
    expect(r.d.probeAccount).not.toHaveBeenCalled();
    expect(r.d.goToAuth).not.toHaveBeenCalled();
  });
});
