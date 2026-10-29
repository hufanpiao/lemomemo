// 主 App 收到 account_disabled 先探测再决定（R-256 ③ 后续；sync-wiring 文件头）：
// pending_deletion → 冷静期退出；disabled → 停用退出；unknown → 保守清本机、提示 disabled_unsure；active → 不清本机、重新载入页面。
// 探测用被拒那次请求所用会话的令牌；本机会话已被换掉时不拿别人的令牌去查。account_pending_deletion、session_revoked 不探测
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions, type BootResult } from '../../core/boot.ts';
import { clearAllCollections } from '../../core/store.ts';
import type { Sync, SyncOptions } from '../../core/sync/engine.ts';
import { fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import type { AccountProbe as AccountStatus } from '../../platform/account-status.ts';
import { ACTIVE_RELOAD_KEY, ACTIVE_RELOAD_WINDOW_MS, wireSync } from '../sync-wiring.ts';

const upgradeReload = vi.fn();

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: upgradeReload, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

function spySync() {
  let onRemoved: SyncOptions['onRemoved'] = () => undefined;
  const sync = { start: vi.fn(), stop: vi.fn(), drain: vi.fn(() => Promise.resolve()), subscribe: () => () => undefined, onEvent: () => () => undefined } as unknown as Sync;
  const create = vi.fn((_b: BootResult, o: SyncOptions) => {
    onRemoved = o.onRemoved;
    return sync;
  });
  return { create, removed: (code: string, sid: string | null = 's1') => onRemoved(code, sid) };
}

/** 内存版 sessionStorage（跨“重新载入”保留，用例之间各自新建） */
function memStore(m = new Map<string, string>()) {
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

/** status 的回答由用例给；session = 本机会话现在是谁 */
function deps(create: (b: BootResult, o: SyncOptions) => Sync, answer: () => Promise<AccountStatus>, session = { sid: 's1' as string | null, token: 'tok-1' as string | null }) {
  return {
    transport: fakeTransport(),
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    clearLocalSessionIf: vi.fn(),
    goToAuth: vi.fn(),
    setExitNotice: vi.fn((_n: string, _sid?: string | null) => undefined),
    create,
    probeAccount: vi.fn((_token: string) => answer()),
    readSession: vi.fn(() => session),
    reload: vi.fn(),
    reloadMarks: () => marks,
    now: () => clock,
    log: vi.fn(),
  };
}

let marks = memStore();
let clock = 1_000_000;

beforeEach(() => {
  marks = memStore();
  clock = 1_000_000;
  clearAllCollections();
  upgradeReload.mockClear();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('收到 account_disabled：先探测 status 再决定', () => {
  for (const [kind, notice] of [
    ['pending_deletion', 'pending_deletion'],
    ['disabled', 'disabled'],
    ['unknown', 'disabled_unsure'],
  ] as const) {
    it(`${kind} → 清本机、回登录页，退出原因 ${notice}；探测用被拒那次会话的令牌，探测完以前不清、不删会话`, async () => {
      const boot = await coldStart(opts(fakeIndexedDB().factory));
      const s = spySync();
      let answer = (_s: AccountStatus): void => undefined;
      const d = deps(s.create, () => new Promise((r) => (answer = r)));
      wireSync(boot, d);
      s.removed('account_disabled', 's1');
      expect(d.probeAccount).toHaveBeenCalledWith('tok-1');
      await Promise.resolve();
      expect(d.clearLocalSessionIf).not.toHaveBeenCalled();
      expect(d.clearCacheStorage).not.toHaveBeenCalled();
      answer(kind === 'pending_deletion' ? { kind, purgeAfter: null } : { kind });
      await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
      expect(d.setExitNotice.mock.calls.map((c) => c[0])).toContain(notice);
      // 冷静期不删会话（R-262），其余只删被拒那次的 s1
      if (notice === 'pending_deletion') expect(d.clearLocalSessionIf).not.toHaveBeenCalled();
      else expect(d.clearLocalSessionIf).toHaveBeenCalledWith('s1');
      // 本页自己记的原因也带上被拒那次的 sid（exit-notice 存起来，过期规则同一套）
      expect(d.setExitNotice).toHaveBeenCalledWith(notice, 's1');
      expect(d.clearCacheStorage).toHaveBeenCalledTimes(1);
      expect(boot.cache?.isClosed()).toBe(true);
      expect(d.reload).not.toHaveBeenCalled();
    });
  }

  it('active（刚好恢复了）→ 不清本机、不删会话、不回登录页，重新载入页面重新同步', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = deps(s.create, async () => ({ kind: 'active' }));
    wireSync(boot, d);
    s.removed('account_disabled', 's1');
    await vi.waitFor(() => expect(d.reload).toHaveBeenCalledTimes(1));
    expect(d.goToAuth).not.toHaveBeenCalled();
    expect(d.setExitNotice).not.toHaveBeenCalled();
    expect(d.clearLocalSessionIf).not.toHaveBeenCalled();
    expect(d.clearCacheStorage).not.toHaveBeenCalled();
    expect(boot.switching).toBe(false);
    expect(boot.cache?.isClosed()).toBe(false);
  });

  it('本机会话已被别的标签页换成 s2：不拿 s2 的令牌去查，按 unknown 保守清本机；只删被拒的 s1', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = deps(s.create, async () => ({ kind: 'active' }), { sid: 's2', token: 'tok-2' });
    wireSync(boot, d);
    s.removed('account_disabled', 's1');
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    expect(d.probeAccount).not.toHaveBeenCalled();
    expect(d.setExitNotice.mock.calls.map((c) => c[0])).toContain('disabled_unsure');
    expect(d.clearLocalSessionIf.mock.calls.every(([sid]) => sid === 's1')).toBe(true);
  });

  it('被拒那次请求发出时没有读得出的会话（sid: null；K6-sugg5 ②、OUTBOX-sid-type 起必须显式给）：不拿本机现在那个会话的令牌去探测，按 disabled_unsure 退出、只用 null 删', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = deps(s.create, async () => ({ kind: 'pending_deletion', purgeAfter: null }));
    wireSync(boot, d);
    const ob = boot.outbox;
    if (!ob) throw new Error('outbox');
    await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const a = await ob.next();
    expect(await ob.fail(a?.op_id ?? '', { status: 403, code: 'account_disabled', sid: null })).toBe('disabled');
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    expect(d.probeAccount).not.toHaveBeenCalled();
    expect(d.setExitNotice.mock.calls.map((c) => c[0])).toContain('disabled_unsure');
    expect(d.clearLocalSessionIf.mock.calls.every(([sid]) => sid === null)).toBe(true);
  });

  it('K6-sugg5 审查建议：sid 为 null 且本机读不到账号（没有会话）→ 不探测、按 expired（登录已失效，请重新登录；R-263）退出；本机有账号或读出错 → 照旧 disabled_unsure', async () => {
    const cases: [() => string | null, string][] = [[() => null, 'expired'], [() => 'A', 'disabled_unsure'], [() => { throw new Error('x'); }, 'disabled_unsure']];
    for (const [readUserId, notice] of cases) {
      resetBootForTest();
      const boot = await coldStart(opts(fakeIndexedDB().factory));
      const d = { ...deps(spySync().create, async () => ({ kind: 'active' }), { sid: null, token: null }), readUserId: vi.fn(readUserId) };
      wireSync(boot, d);
      const ob = boot.outbox;
      if (!ob) throw new Error('outbox');
      await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
      const a = await ob.next();
      await ob.fail(a?.op_id ?? '', { status: 403, code: 'account_disabled', sid: null });
      await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
      expect(d.probeAccount).not.toHaveBeenCalled();
      expect(d.setExitNotice).toHaveBeenCalledWith(notice, null);
      expect(d.clearLocalSessionIf.mock.calls.every(([sid]) => sid === null)).toBe(true);
      expect(d.reload).not.toHaveBeenCalled();
      boot.cache?.close();
    }
  });

  it('R-262：探测出冷静期 → 不删会话，但照样清库（clearAll）、清运行时缓存、回登录页；反例：探测出停用照旧删 s1', async () => {
    for (const [kind, deleted] of [['pending_deletion', false], ['disabled', true]] as const) {
      resetBootForTest();
      const boot = await coldStart(opts(fakeIndexedDB().factory));
      const cache = boot.cache;
      if (!cache) throw new Error('cache');
      const clearAll = vi.spyOn(cache, 'clearAll');
      const s = spySync();
      const d = deps(s.create, async () => (kind === 'pending_deletion' ? { kind, purgeAfter: null } : { kind }));
      wireSync(boot, d);
      s.removed('account_disabled', 's1');
      await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
      expect(d.clearLocalSessionIf.mock.calls).toEqual(deleted ? [['s1'], ['s1']] : []);
      expect(clearAll).toHaveBeenCalledTimes(1);
      expect(d.clearCacheStorage).toHaveBeenCalledTimes(1);
      expect(cache.isClosed()).toBe(true);
      expect(d.setExitNotice).toHaveBeenCalledWith(kind, 's1');
    }
  });

  it('account_pending_deletion、session_revoked 不探测，照旧直接退出', async () => {
    for (const [code, notice] of [['account_pending_deletion', 'pending_deletion'], ['session_revoked', 'removed']] as const) {
      resetBootForTest();
      const boot = await coldStart(opts(fakeIndexedDB().factory));
      const s = spySync();
      const d = deps(s.create, async () => ({ kind: 'active' }));
      wireSync(boot, d);
      s.removed(code, 's1');
      await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
      expect(d.probeAccount).not.toHaveBeenCalled();
      expect(d.setExitNotice.mock.calls.map((c) => c[0])).toContain(notice);
    }
  });

  it('探测期间别的退出流程接手了（boot.switching）：不再清第二遍、不再跳', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    let answer = (_s: AccountStatus): void => undefined;
    const d = deps(s.create, () => new Promise((r) => (answer = r)));
    wireSync(boot, d);
    s.removed('account_disabled', 's1');
    boot.switching = true;
    answer({ kind: 'disabled' });
    await new Promise((r) => setTimeout(r, 10));
    expect(d.goToAuth).not.toHaveBeenCalled();
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('signed_out（401、unauthorized、session_revoked）：和断网分开，按被移除退出（removed）', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = deps(s.create, async () => ({ kind: 'signed_out' }));
    wireSync(boot, d);
    s.removed('account_disabled', 's1');
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    expect(d.setExitNotice.mock.calls.map((c) => c[0])).toContain('removed');
    expect(d.clearLocalSessionIf).toHaveBeenCalledWith('s1');
  });
});

describe('active 的重新载入有次数限制（RPC 和探测一直说不到一块时不能无限载入）', () => {
  /** 模拟一次页面载入：新 boot、新 wireSync，收到 account_disabled、探测 active */
  async function oneLoad(store = marks) {
    resetBootForTest();
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = { ...deps(s.create, async () => ({ kind: 'active' })), reloadMarks: () => store };
    wireSync(boot, d);
    s.removed('account_disabled', 's1');
    await vi.waitFor(() => expect(d.reload.mock.calls.length + d.log.mock.calls.length).toBeGreaterThan(0));
    return { boot, d };
  }

  it('连续两次 active 只重新载入一次：第二次闸保持关着、记 disabled_probe_active_loop，不清本机、不跳转', async () => {
    const first = await oneLoad();
    expect(first.d.reload).toHaveBeenCalledTimes(1);
    expect(marks.m.get(ACTIVE_RELOAD_KEY)).toBe(String(clock));
    clock += 60_000;
    const second = await oneLoad();
    expect(second.d.reload).not.toHaveBeenCalled();
    expect(second.d.log).toHaveBeenCalledWith('disabled_probe_active_loop');
    expect(second.d.goToAuth).not.toHaveBeenCalled();
    expect(second.d.setExitNotice).not.toHaveBeenCalled();
    expect(second.d.clearLocalSessionIf).not.toHaveBeenCalled();
    expect(second.d.clearCacheStorage).not.toHaveBeenCalled();
    expect(second.boot.cache?.isClosed()).toBe(false);
  });

  it('超过 5 分钟再遇到 active：可以再载入一次', async () => {
    await oneLoad();
    clock += ACTIVE_RELOAD_WINDOW_MS;
    const again = await oneLoad();
    expect(again.d.reload).toHaveBeenCalledTimes(1);
  });

  it('sessionStorage 读不出、写不进、写了读不回：都不重新载入（记不住就会循环），记日志', async () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined };
    const noWrite = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    const forgetful = { getItem: () => null, setItem: () => undefined };
    for (const store of [throwing, noWrite, forgetful]) {
      const r = await oneLoad(store as unknown as typeof marks);
      expect(r.d.reload).not.toHaveBeenCalled();
      expect(r.d.log).toHaveBeenCalledWith('disabled_probe_active_loop');
      expect(r.d.goToAuth).not.toHaveBeenCalled();
    }
  });
});

describe('sid 读不出（null）时删会话（第八轮必改 1：不另认同账号）', () => {
  it('停用、被移除都只用 clearLocalSessionIf(null)', async () => {
    for (const code of ['account_disabled', 'session_revoked'] as const) {
      resetBootForTest();
      const boot = await coldStart(opts(fakeIndexedDB().factory));
      const s = spySync();
      const d = deps(s.create, async () => ({ kind: 'disabled' }), { sid: null, token: null });
      wireSync(boot, d);
      s.removed(code, null);
      await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
      expect(d.clearLocalSessionIf.mock.calls.every(([x]) => x === null)).toBe(true);
      expect(d.clearLocalSessionIf).toHaveBeenCalledTimes(2);
    }
  });
});
