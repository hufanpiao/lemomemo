// 本页 SIGNED_OUT 的跨标签页组合（K6-signedout 审查建议 ④、复查建议 ①；TC-B1-61 ②、TC-B1-83）：
// 用真的会话层（platform/session.ts 的 authEventHandler、标记、takeLocalSession、goToAuth）+ 真的 watchAccount（core/account.ts）
// + 假 IndexedDB，不加载 supabase-js；onAuthStateChange 的事件由测试按真实顺序手动发
// • A 页自己退出（打标记）→ B 页收到 supabase-js 转来的 SIGNED_OUT 和 storage(null)：两种先后都按普通退出（不提示被移除），
//   清库期间的写入被拒（switching）、在途那一项回来时不写库，最后整库删掉
// • 复查建议 ①：被移除时本机会话在收到 SIGNED_OUT 的同一个同步段里就删；清库那几秒里别的标签页登录的新会话，回登录页时不再被删
// • K6-sugg4 ④：收到转来的 SIGNED_OUT 时本机会话已是别的标签页用同一账号刚登录的 s2（本页最后见到的是 s1）：不删 s2、不清库、不跳
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimCache, watchAccount, type WatchAccountDeps } from '../../core/account.ts';
import { coldStart, getBoot, resetBootForTest, type BootResult } from '../../core/boot.ts';
import { deleteCacheDb } from '../../core/cache.ts';
import { fakeIndexedDB, type FakeIDBFactory } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { clearAllCollections } from '../../core/store.ts';
import { write } from '../../core/write.ts';
import {
  authEventHandler, clearAnyLocalSession, goToAuth, markSelfSignOut, readExitNotice, readSessionUserId, resetSelfSignOutForTest,
  takeLocalSession, type AuthEventSession,
} from '../../platform/session.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
/** 会话键：测试环境没配 supabaseUrl 时 session.ts 按 `sb-*-auth-token` 格式找，这个名字也认 */
const KEY = 'sb-lemotest-auth-token';
const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const seed = (sid: string, user = A): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));

interface Tab {
  boot: BootResult;
  fake: FakeIDBFactory;
  deps: WatchAccountDeps;
  /** supabase-js 发给本页的 onAuthStateChange 事件 */
  emit: (event: string, session: AuthEventSession) => void;
  /** 别的标签页改了会话（storage 事件） */
  storage: () => void;
  replace: ReturnType<typeof vi.fn>;
}

/** B 页：会话 s1 的账号 A，库里有一条没发的、一条在途的；挂上真的会话层分发和 watchAccount */
async function tabB(over: Partial<WatchAccountDeps> = {}): Promise<Tab> {
  seed('s1');
  const replace = vi.fn();
  vi.stubGlobal('location', { replace });
  const { factory, fake } = fakeIndexedDB();
  const boot = await coldStart({ userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve() });
  if (!boot.cache) throw new Error('no cache');
  await claimCache(boot.cache, A);
  await write.insert('todos', { ...todo(1), id: uid(1) });
  await write.insert('todos', { ...todo(2), id: uid(2) });
  let emit: Tab['emit'] = () => undefined;
  let storageFn: (id: string | null) => void = () => undefined;
  const deps: WatchAccountDeps = {
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    clearLogs: vi.fn(),
    onAuthUser: (fn, out) => {
      emit = authEventHandler(fn, out);   // 默认选项：读 localStorage 的会话和标记（同 onAuthUser 里那一份）
      return () => undefined;
    },
    onStorageUser: (fn) => {
      storageFn = fn;
      return () => undefined;
    },
    currentUserId: () => readSessionUserId(),
    dropSession: () => takeLocalSession(),
    onSignedOut: goToAuth,
    deleteDb: () => deleteCacheDb({ factory, waitMs: 50 }),
    onSwitched: vi.fn(),
    ...over,
  };
  watchAccount(boot, deps);
  return { boot, fake, deps, emit: (e, s) => emit(e, s), storage: () => storageFn(readSessionUserId()), replace };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  resetSelfSignOutForTest();
  getBoot()?.cache?.close();
  clearAllCollections();
  resetBootForTest();
});

describe('A 页自己退出 → B 页收到转来的 SIGNED_OUT 和 storage(null)（审查建议 ④）', () => {
  /** A 页：打标记（带退出前的 session_id）、signOut 删掉本机会话；B 页内存里没有标记 */
  const signOutInTabA = (): void => {
    markSelfSignOut();
    resetSelfSignOutForTest();
    localStorage.removeItem(KEY);
  };

  for (const order of ['SIGNED_OUT 先到', 'storage(null) 先到'] as const) {
    it(`${order}：按普通退出（不提示被移除、不清日志队列），清库期间写入被拒、在途那一项回来不写库，整库删掉`, async () => {
      const b = await tabB();
      const inflight = await b.boot.outbox?.next();
      expect(inflight).toBeTruthy();
      signOutInTabA();
      if (order === 'SIGNED_OUT 先到') {
        b.emit('SIGNED_OUT', null);
        b.storage();
      } else {
        b.storage();
        b.emit('SIGNED_OUT', null);
      }
      // 同步设闸：清库期间的写入一律拒（页面马上离开，不提示）
      expect(b.boot.switching).toBe(true);
      expect(await write.insert('todos', { ...todo(3), id: uid(3) })).toEqual({ ok: false, reason: 'switching' });
      // 在途那一项这时才回来：不写库、不抛
      await expect(b.boot.outbox?.ack(inflight?.op_id ?? '', { status: 'ok', rev: 1, prev_rev: null })).resolves.toBeUndefined();
      await vi.waitFor(() => expect(b.replace).toHaveBeenCalledWith('/app/auth/'));
      expect(b.replace).toHaveBeenCalledTimes(1);
      expect(readExitNotice()).toBeNull();
      expect(b.deps.clearLogs).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(b.fake.dbs.has('planner-v4')).toBe(false));
      expect(b.boot.cache?.isClosed()).toBe(true);
    });
  }

  it('对照：标记是上一个会话的（A 页退出后又登录了新会话 s2，s2 随即被移除）：B 页按被移除提示', async () => {
    const b = await tabB();
    markSelfSignOut(localStorage, Date.now(), 's0');   // 早先那次自己退出留下的标记
    resetSelfSignOutForTest();
    b.emit('TOKEN_REFRESHED', { user: { id: A }, access_token: tok('s1') });
    localStorage.removeItem(KEY);
    b.emit('SIGNED_OUT', null);
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledTimes(1));
    expect(readExitNotice()).toBe('removed');
    expect(b.deps.clearLogs).toHaveBeenCalledTimes(1);
  });
});

describe('被移除时删本机会话的时机（复查建议 ①）', () => {
  it('收到 SIGNED_OUT 的同一个同步段里就删；清库那几秒里别的标签页登录的新会话，回登录页时不删', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const b = await tabB({ deleteDb: () => gate });
    b.emit('SIGNED_OUT', null);   // 会话层：不是自己退出 → watchAccount 的 signedOutHere
    expect(readSessionUserId()).toBeNull();   // 同步删掉了（还没 await 任何东西）
    // 清库还没完：别的标签页登录了 B（新会话 s2）
    seed('s2', B);
    b.storage();   // 本页已经在走退出流程，只处理一次
    release();
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledWith('/app/auth/'));
    expect(readExitNotice()).toBe('removed');
    expect(readSessionUserId()).toBe(B);   // 新会话还在：登录页显示“当前已登录 B”，不会把 B 也登出
  });

  it('同一个账号在别的标签页重新登录（新会话 s2）也不删；旧会话 s1 被令牌刷新写回来了才删', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const b = await tabB({ deleteDb: () => gate });
    b.emit('SIGNED_OUT', null);
    seed('s2');
    release();
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledTimes(1));
    expect(readSessionUserId()).toBe(A);
  });

  it('旧会话被写回（晚到的刷新把 s1 写回本机）：回登录页前再删一次', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const b = await tabB({ deleteDb: () => gate });
    b.emit('SIGNED_OUT', null);
    seed('s1');
    release();
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledTimes(1));
    expect(readSessionUserId()).toBeNull();
  });

  it('对照（修之前的写法）：不在开头删、回登录页时直接删，会把清库期间别的标签页刚登录的新会话也删掉', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const b = await tabB({ deleteDb: () => gate });
    b.deps.dropSession = () => null;   // 修之前：开头不删
    b.deps.onSignedOut = () => {
      clearAnyLocalSession();   // 修之前：回登录页时不管是谁的会话都删
      goToAuth();
    };
    b.emit('SIGNED_OUT', null);
    seed('s2', B);
    release();
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledTimes(1));
    expect(readSessionUserId()).toBeNull();   // 这就是复查建议 ① 说的窗口
  });

  it('清库期间收到别的账号的 SIGNED_IN：只处理一次，不按换账号再走一遍', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const b = await tabB({ deleteDb: () => gate });
    b.emit('SIGNED_OUT', null);
    seed('s2', B);
    b.emit('SIGNED_IN', { user: { id: B }, access_token: tok('s2') });
    release();
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledTimes(1));
    expect(b.deps.onSwitched).not.toHaveBeenCalled();
  });
});

describe('转来的 SIGNED_OUT 到时本机已是同一账号的新会话（K6-sugg4 ④）', () => {
  it('本页最后见到 s1，本机会话已是 s2：不删 s2、不清库、不跳登录页；之后 s2 自己的 SIGNED_OUT 照常处理', async () => {
    const b = await tabB();
    seed('s2');   // 别的标签页用同一账号登录（还没转来 SIGNED_IN）
    b.emit('SIGNED_OUT', null);   // s1 在别处被退出，supabase-js 转来的
    expect(readSessionUserId()).toBe(A);
    expect(b.boot.switching).toBe(false);
    await Promise.resolve();
    expect(b.replace).not.toHaveBeenCalled();
    // 本页改认 s2：s2 随即被移除（本机会话已删），照常按被移除处理
    localStorage.removeItem(KEY);
    b.emit('SIGNED_OUT', null);
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledWith('/app/auth/'));
    expect(readExitNotice()).toBe('removed');
  });

  it('本机会话还是 s1（或已经没了）：照旧按被移除处理', async () => {
    const b = await tabB();
    b.emit('SIGNED_OUT', null);
    await vi.waitFor(() => expect(b.replace).toHaveBeenCalledTimes(1));
    expect(readSessionUserId()).toBeNull();
    expect(readExitNotice()).toBe('removed');
  });

  it('对照（修之前的写法：不比本机会话的 session_id）：s2 被删、库被清', async () => {
    let emitOld: Tab['emit'] = () => undefined;
    const b = await tabB({
      onAuthUser: (fn, out) => {
        emitOld = authEventHandler(fn, out, { localSessionId: () => null });   // 读不出本机 sid = 退回修之前
        return () => undefined;
      },
    });
    seed('s2');
    emitOld('SIGNED_OUT', null);
    expect(readSessionUserId()).toBeNull();   // 这就是建议 ④ 说的：删掉了本账号刚登录的新会话
    expect(b.boot.switching).toBe(true);
  });
});
