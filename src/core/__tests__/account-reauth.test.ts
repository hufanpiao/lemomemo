// R-382（架构 4.1a 第 2 点、第 6 点单测）：登录过期只关库不清、被移除清库删记号；冷启动、别的标签页、重新登录按 lemo.reauth 处理
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimCache, expireThisTab, markExpired, watchAccount, wipeOnRemoved, type WatchAccountDeps } from '../account.ts';
import { coldStart, resetBootForTest, type BootResult } from '../boot.ts';
import { deleteCacheDb } from '../cache.ts';
import { clearAllCollections } from '../store.ts';
import { fakeIndexedDB, flush, type FakeIDBFactory } from './idb-fake.ts';
import { FUTURE_SKEW_MS, REAUTH_TTL_MS, readReauth, writeReauth } from '../../platform/auth-loss-store.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const S = '00000000-0000-4000-8000-0000000000c1';

afterEach(() => {
  localStorage.clear();
  clearAllCollections();
  resetBootForTest();
});

interface Rig {
  boot: BootResult;
  fake: FakeIDBFactory;
  deps: WatchAccountDeps;
  signedOut: (sid?: string | null) => void;
  storage: (v: string | null) => void;
}

async function rig(resolve: 'expired' | 'removed' = 'expired'): Promise<Rig> {
  const { factory, fake } = fakeIndexedDB();
  const boot = await coldStart({ userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve() });
  if (!boot.cache) throw new Error('no cache');
  await claimCache(boot.cache, A);
  await boot.cache.putDraft({ id: 'd', kind: 'capture', data: 'A 的草稿', updated_at: 1 });
  const h = { so: (_s?: string | null) => undefined as void, st: (_v: string | null) => undefined as void };
  const deps: WatchAccountDeps = {
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    onAuthUser: (_fn, so) => {
      if (so) h.so = (s) => so(s, null);
      return () => undefined;
    },
    onStorageUser: (fn) => {
      h.st = fn;
      return () => undefined;
    },
    currentUserId: () => A,   // 挂上时再比一次读到的还是本账号
    dropSession: vi.fn(() => S),
    onSignedOut: vi.fn(),
    clearLogs: vi.fn(),
    onSwitched: vi.fn(),
    deleteDb: () => deleteCacheDb({ factory, waitMs: 50 }),
    resolve: vi.fn(async () => resolve),
  };
  watchAccount(boot, deps);
  return { boot, fake, deps, signedOut: (s) => h.so(s), storage: (v) => h.st(v) };
}

describe('signedOutHere（本页 SIGNED_OUT）', () => {
  it('判 expired：不清库、只关库，写 lemo.reauth（本账号、作废的 sid），onSignedOut(expired, sid)', async () => {
    const r = await rig('expired');
    r.signedOut();
    expect(r.boot.switching).toBe(true);
    await vi.waitFor(() => expect(r.deps.onSignedOut).toHaveBeenCalledWith('expired', S));
    expect(r.fake.dbs.has('planner-v4')).toBe(true);
    expect(r.boot.cache?.isClosed()).toBe(true);
    expect(readReauth()).toMatchObject({ user_id: A, session_id: S });
    expect(r.deps.clearLogs).not.toHaveBeenCalled();
  });

  it('判 removed：清库、删库、删记号，onSignedOut(removed, sid)', async () => {
    const r = await rig('removed');
    r.signedOut();
    await vi.waitFor(() => expect(r.deps.onSignedOut).toHaveBeenCalledWith('removed', S));
    expect(r.fake.dbs.has('planner-v4')).toBe(false);
    expect(readReauth()).toBeNull();
  });
});

describe('别的标签页删了会话（storage 事件）', () => {
  it('记号是本账号的：只关库、onSignedOut(expired, 记号里的 sid)，库还在', async () => {
    const r = await rig();
    writeReauth(A, S);
    r.storage(null);
    expect(r.deps.onSignedOut).toHaveBeenCalledWith('expired', S);
    expect(r.boot.cache?.isClosed()).toBe(true);
    await flush();
    expect(r.fake.dbs.has('planner-v4')).toBe(true);
  });

  it('没有记号、或记号是别的账号的：照旧清库删库', async () => {
    for (const mark of [null, B]) {
      localStorage.clear();
      resetBootForTest();
      const r = await rig();
      if (mark) writeReauth(mark, S);
      r.storage(null);
      await vi.waitFor(() => expect(r.deps.onSignedOut).toHaveBeenCalledWith());
      expect(r.fake.dbs.has('planner-v4')).toBe(false);
    }
  });

  it('换了账号登录（storage 带 B）：按换账号处理（switched），不看记号', async () => {
    const r = await rig();
    writeReauth(A, S);
    r.storage(B);
    await vi.waitFor(() => expect(r.deps.onSwitched).toHaveBeenCalledTimes(1));
    expect(r.deps.onSignedOut).not.toHaveBeenCalled();
  });
});

describe('冷启动没有会话', () => {
  /** 先按 A 建好库，再写记号（mark），然后没有会话冷启动 */
  async function coldNoSession(mark: () => void, now = Date.now()): Promise<FakeIDBFactory> {
    const { factory, fake } = fakeIndexedDB();
    const b = await coldStart({ userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve() });
    b.cache?.close();
    resetBootForTest();
    mark();
    await coldStart({ userId: null, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(), now: () => now } as Parameters<typeof coldStart>[0]);
    return fake;
  }

  it('有有效记号：不删库', async () => {
    expect((await coldNoSession(() => writeReauth(A, S))).dbs.has('planner-v4')).toBe(true);
    expect(readReauth()).not.toBeNull();
  });

  it('没有记号、记号过了 30 天、记号时间晚于本机 1 天以上：删库，记号一起删', async () => {
    const t = Date.now();
    for (const at of [null, t - REAUTH_TTL_MS - 1, t + FUTURE_SKEW_MS + 60_000]) {
      localStorage.clear();
      expect((await coldNoSession(() => at !== null && writeReauth(A, S, at), t)).dbs.has('planner-v4')).toBe(false);
      expect(localStorage.getItem('lemo.reauth')).toBeNull();
    }
  });

  it('同一账号重新登录：库原样用，删掉记号', async () => {
    const { factory } = fakeIndexedDB();
    const b = await coldStart({ userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve() });
    if (!b.cache) throw new Error('no cache');
    await claimCache(b.cache, A);
    await b.cache.putDraft({ id: 'd', kind: 'capture', data: 'x', updated_at: 1 });
    b.cache.close();
    resetBootForTest();
    writeReauth(A, S);
    const b2 = await coldStart({ userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve() });
    expect(b2.switchedUser).toBe(false);
    expect(localStorage.getItem('lemo.reauth')).toBeNull();
    b2.cache?.close();
  });
});

describe('记号的 reason（R-382 复核建议 ①）', () => {
  it('expireThisTab(boot, null, disabled)：记号原因记 disabled；不给按 expired', async () => {
    const r = await rig();
    expect(expireThisTab(r.boot, null, 'disabled')).toBe(true);
    expect(readReauth()).toMatchObject({ user_id: A, session_id: null, reason: 'disabled' });
    localStorage.clear();
    const r2 = await rig();
    expect(markExpired(r2.boot, S)).toBe(true);
    expect(readReauth()?.reason).toBe('expired');
  });

  it('别的标签页已写下 disabled 记号，本页随后收到 SIGNED_OUT 判 expired：记号原因仍是 disabled', async () => {
    const r = await rig('expired');
    writeReauth(A, null, Date.now(), undefined, 'disabled');
    r.signedOut();
    await vi.waitFor(() => expect(r.deps.onSignedOut).toHaveBeenCalledWith('expired', S));
    expect(readReauth()).toMatchObject({ session_id: S, reason: 'disabled' });
  });

  it('清库出口照旧同一步删记号：disabled 记号也删（wipeOnRemoved）', async () => {
    const r = await rig();
    writeReauth(A, null, Date.now(), undefined, 'disabled');
    await wipeOnRemoved(r.boot, { clearCacheStorage: () => Promise.resolve(), onRemoved: vi.fn(), wipeMs: 200, cachesMs: 50 });
    expect(readReauth()).toBeNull();
  });
});
