// 退出原因跨标签页（DISABLED-probe-later ②）和限次触发后让出主页（复审建议 10-30；sync-wiring 文件头）：
// • 本页因被移除、停用、冷静期退出：删会话之前先广播 reset，带上退出原因和被拒的 sid
// • 别的标签页收到带 notice 的 reset：先 setExitNotice（本页会话已换成别的、notice 不认识就不记），之后照常重读
// • 探测 active 但 5 分钟内已重新载入过：让出同步主页（leader.close）、onSyncPaused 出“同步暂停”横幅
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions, type BootResult } from '../../core/boot.ts';
import { clearAllCollections } from '../../core/store.ts';
import type { Sync, SyncOptions } from '../../core/sync/engine.ts';
import { fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import type { AccountProbe } from '../../platform/account-status.ts';
import type { SyncMessage, TabLeader, TabLeaderOptions } from '../../platform/tab-leader.ts';
import { ACTIVE_RELOAD_KEY, wireSync } from '../sync-wiring.ts';

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

/** 假的选主：记下发出的消息、close；onMessage 由用例调 */
function fakeLeader(isLeader = true) {
  const posts: SyncMessage[] = [];
  let o: TabLeaderOptions | null = null;
  const leader: TabLeader = {
    isLeader: () => isLeader,
    post: (m) => void posts.push(m),
    close: vi.fn(async () => undefined),
  };
  /** 当主页时像真的一样马上 lead()（建引擎，onRemoved 才接得上） */
  const make = (x: TabLeaderOptions): TabLeader => {
    o = x;
    if (isLeader) x.lead();
    return leader;
  };
  return { leader, posts, make, receive: (m: SyncMessage) => o?.onMessage(m) };
}

function setup(boot: BootResult, answer: () => Promise<AccountProbe>, session = { sid: 's1' as string | null, token: 'tok-1' }) {
  let onRemoved: SyncOptions['onRemoved'] = () => undefined;
  const sync = { start: vi.fn(), stop: vi.fn(), drain: vi.fn(() => Promise.resolve()), subscribe: () => () => undefined, onEvent: () => () => undefined } as unknown as Sync;
  const order: string[] = [];
  const fl = fakeLeader();
  const marks = new Map<string, string>();
  const d = {
    transport: fakeTransport(),
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    clearLocalSessionIf: vi.fn((sid: string | null) => void order.push(`session:${sid ?? 'null'}`)),
    goToAuth: vi.fn(),
    setExitNotice: vi.fn((_n: string, _sid?: string | null) => undefined),
    create: (_b: BootResult, o: SyncOptions) => ((onRemoved = o.onRemoved), sync),
    leader: fl.make,
    probeAccount: vi.fn((_t: string) => answer()),
    readSession: vi.fn(() => session),
    reload: vi.fn(),
    reloadMarks: () => ({ getItem: (k: string) => marks.get(k) ?? null, setItem: (k: string, v: string) => void marks.set(k, v) }),
    now: () => 1_000_000,
    log: vi.fn(),
    onSyncPaused: vi.fn(),
  };
  const origPost = fl.leader.post;
  fl.leader.post = (m) => {
    order.push(`post:${m.type}`);
    origPost(m);
  };
  wireSync(boot, d);
  return { d, fl, order, marks, removed: (code: string, sid: string | null = 's1') => onRemoved(code, sid) };
}

beforeEach(() => clearAllCollections());
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('本页退出：广播带退出原因的 reset', () => {
  it('探测出冷静期：删会话之前先发 reset {notice: pending_deletion, sid: s1}', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'pending_deletion', purgeAfter: null }));
    s.removed('account_disabled', 's1');
    await vi.waitFor(() => expect(s.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(s.fl.posts[0]).toEqual({ type: 'reset', notice: 'pending_deletion', sid: 's1' });
    expect(s.order.indexOf('post:reset')).toBeLessThan(s.order.indexOf('session:s1'));
  });

  it('session_revoked（不探测）：同样带 removed；事件没带 sid 时带本机会话的 sid', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }));
    s.removed('session_revoked', undefined as unknown as null);
    await vi.waitFor(() => expect(s.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(s.fl.posts[0]).toEqual({ type: 'reset', notice: 'removed', sid: 's1' });
  });
});

describe('别的标签页发来的带原因的 reset', () => {
  it('sid 对得上（或本页已没有会话）：记下同一条退出原因', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }));
    s.fl.receive({ type: 'reset', notice: 'pending_deletion', sid: 's1' });
    expect(s.d.setExitNotice).toHaveBeenCalledWith('pending_deletion', 's1');
  });

  it('本页会话已换成 s2：不记；notice 不认识、不带 notice：不记', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }), { sid: 's2', token: 'tok-2' });
    s.fl.receive({ type: 'reset', notice: 'disabled', sid: 's1' });
    s.fl.receive({ type: 'reset', notice: 'whatever' as never, sid: 's2' });
    s.fl.receive({ type: 'reset' });
    expect(s.d.setExitNotice).not.toHaveBeenCalled();
  });
});

describe('reset 不带 sid（第六轮审查建议 ①）', () => {
  it('本页还有会话：不记（可能是别的账号 A 的标签页发的，B 的标签页不能记下 A 的原因）', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }), { sid: 's-b', token: 'tok-b' });
    s.fl.receive({ type: 'reset', notice: 'disabled' });
    s.fl.receive({ type: 'reset', notice: 'removed', sid: null });
    expect(s.d.setExitNotice).not.toHaveBeenCalled();
  });

  it('本页也没有会话了：记下，sid 记 null', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }), { sid: null, token: null } as never);
    s.fl.receive({ type: 'reset', notice: 'pending_deletion' });
    expect(s.d.setExitNotice).toHaveBeenCalledWith('pending_deletion', null);
  });

  it('带 sid、本页会话已删（null）：照样记', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }), { sid: null, token: null } as never);
    s.fl.receive({ type: 'reset', notice: 'disabled', sid: 's1' });
    expect(s.d.setExitNotice).toHaveBeenCalledWith('disabled', 's1');
  });
});

describe('限次触发：让出同步主页、提示同步暂停', () => {
  it('5 分钟内第二次 active：leader.close()、onSyncPaused；不清本机、不跳转', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }));
    s.marks.set(ACTIVE_RELOAD_KEY, String(1_000_000 - 1000));
    s.removed('account_disabled', 's1');
    await vi.waitFor(() => expect(s.d.onSyncPaused).toHaveBeenCalledTimes(1));
    expect(s.fl.leader.close).toHaveBeenCalled();
    expect(s.d.log).toHaveBeenCalledWith('disabled_probe_active_loop');
    expect(s.d.reload).not.toHaveBeenCalled();
    expect(s.d.goToAuth).not.toHaveBeenCalled();
    expect(s.fl.posts).toEqual([]);
  });

  it('头一次 active：重新载入，不让出、不提示', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = setup(boot, async () => ({ kind: 'active' }));
    s.removed('account_disabled', 's1');
    await vi.waitFor(() => expect(s.d.reload).toHaveBeenCalledTimes(1));
    expect(s.fl.leader.close).not.toHaveBeenCalled();
    expect(s.d.onSyncPaused).not.toHaveBeenCalled();
  });
});
