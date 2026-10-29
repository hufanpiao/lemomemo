// 设置页的本机部分：语言记在哪、缓存的 profile 跟着改、退出时清空本机（架构 2.4 第 4 条、16.4、4.1）
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeBoot {
  status?: string;
  profile: Record<string, unknown> | null;
  cache: unknown;
  upgrade?: { holdBusy(reason: string): () => void };
}

/** 假升级中心：只记 holdBusy */
const up = () => ({ holdBusy: vi.fn((_reason: string) => () => undefined) });

const boot = vi.hoisted(() => ({
  current: null as null | FakeBoot,
  applyFreshConfig: vi.fn(async () => null),
  wipeLocal: vi.fn(async () => undefined),
  localUnsentCount: vi.fn(async (): Promise<number | null> => null),
  seal: vi.fn(),
}));

vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => boot.current,
  applyFreshConfig: boot.applyFreshConfig,
  wipeLocal: boot.wipeLocal,
  localUnsentCount: boot.localUnsentCount,
}));
vi.mock('../../../core/account.ts', () => ({ sealForExit: boot.seal }));

const { defaultExitDeps, readLocalLocale, updateCachedLocale, writeLocalLocale } = await import('../data/local.ts');
const { wipeThisDevice } = await import('../../../platform/sign-out.ts');

/** 假 IndexedDB：只记 deleteDatabase 删了哪个库，马上成功 */
function fakeIdb() {
  const deleted: string[] = [];
  const factory = {
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const req = {} as IDBOpenDBRequest;
      setTimeout(() => (req.onsuccess as (() => void) | null)?.(), 0);
      return req;
    },
  };
  vi.stubGlobal('indexedDB', factory);
  return deleted;
}

beforeEach(() => {
  localStorage.clear();
  boot.current = null;
  boot.applyFreshConfig.mockClear();
  boot.wipeLocal.mockClear();
  boot.localUnsentCount.mockClear();
  boot.seal.mockReset();
  vi.unstubAllGlobals();
});

describe('语言记在本机', () => {
  it('写 pv-locale 和 cookie lemo_lang（Path=/、一年、SameSite=Lax；http 不带 Secure）', () => {
    const doc = { cookie: '' };
    writeLocalLocale('ko', localStorage, doc);
    expect(localStorage.getItem('pv-locale')).toBe('ko');
    expect(doc.cookie).toBe('lemo_lang=ko; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(readLocalLocale()).toBe('ko');
  });

  it('读到不认识的值当没选过；存储不能用（隐私模式）时不报错', () => {
    localStorage.setItem('pv-locale', 'ko-KR');
    expect(readLocalLocale()).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    expect(readLocalLocale(broken)).toBeNull();
    expect(() => writeLocalLocale('zh', broken, { cookie: '' })).not.toThrow();
  });
});

describe('updateCachedLocale', () => {
  it('缓存过 profile：ui_locale 改成新值写回本机库（免得刷新后被旧值盖回去）', async () => {
    boot.current = { profile: { id: 'u1', ui_locale: 'zh-CN', beta_features: [] }, cache: {} };
    await updateCachedLocale('ko-KR');
    expect(boot.applyFreshConfig).toHaveBeenCalledWith(boot.current, { profile: { id: 'u1', ui_locale: 'ko-KR', beta_features: [] } });
  });

  it('没启动、没缓存过 profile：什么也不做', async () => {
    await updateCachedLocale('ko-KR');
    boot.current = { profile: null, cache: {} };
    await updateCachedLocale('ko-KR');
    expect(boot.applyFreshConfig).not.toHaveBeenCalled();
  });
});

describe('defaultExitDeps', () => {
  it('库能用：走 core/boot 的 wipeLocal，经 platform 清理时不再按库名删库', async () => {
    const deleted = fakeIdb();
    const cache = { isClosed: () => false };
    boot.current = { status: 'ready', profile: null, cache, upgrade: up() };
    expect(await defaultExitDeps.wipe?.()).toBe(true);
    expect(boot.wipeLocal).toHaveBeenCalledWith(cache);
    await wipeThisDevice({ ...defaultExitDeps, clearCacheStorage: async () => undefined });
    expect(deleted).toEqual([]);
  });

  it('库已关闭、打不开、来自更新的版本（version_too_new）、没启动：wipe 说不能用，经 platform 按库名删 planner-v4', async () => {
    const all = [
      { status: 'ready', profile: null, cache: { isClosed: () => true }, upgrade: up() },
      { status: 'unavailable', profile: null, cache: null, upgrade: up() },
      { status: 'version_too_new', profile: null, cache: null, upgrade: up() },
      null,
    ];
    for (const b of all) {
      const deleted = fakeIdb();
      boot.current = b;
      boot.wipeLocal.mockClear();
      expect(await defaultExitDeps.wipe?.()).toBe(false);
      await wipeThisDevice({ ...defaultExitDeps, clearCacheStorage: async () => undefined });
      expect(boot.wipeLocal).not.toHaveBeenCalled();
      expect(deleted).toEqual(['planner-v4']);
    }
  });

  it('pendingCount 交给 core/boot 的 localUnsentCount（当前的 boot）', async () => {
    const b = { status: 'ready', profile: null, cache: null, upgrade: up() };
    boot.current = b;
    boot.localUnsentCount.mockResolvedValueOnce(7);
    expect(await defaultExitDeps.pendingCount()).toBe(7);
    expect(boot.localUnsentCount).toHaveBeenCalledWith(b);
  });

  it('wipe 先占住“忙”（holdBusy，不释放）、同步设闸（sealForExit），再清库；库不能用时也先设闸再删库', async () => {
    const seq: string[] = [];
    fakeIdb();
    const cache = { isClosed: () => false };
    const release = vi.fn();
    const upgrade = { holdBusy: vi.fn((reason: string) => (seq.push(`busy:${reason}`), release)) };
    const b = { status: 'ready', profile: null, cache, upgrade };
    boot.current = b;
    boot.seal.mockImplementation(() => void seq.push('seal'));
    boot.wipeLocal.mockImplementationOnce(async () => void seq.push('clear'));
    await defaultExitDeps.wipe?.();
    expect(boot.seal).toHaveBeenCalledWith(b);
    expect(seq).toEqual(['busy:sign_out', 'seal', 'clear']);
    expect(release).not.toHaveBeenCalled();
    boot.seal.mockClear();
    boot.current = { status: 'version_too_new', profile: null, cache: null, upgrade: up() };
    await defaultExitDeps.wipe?.();
    expect(boot.seal).toHaveBeenCalledTimes(1);
  });
});

describe('defaultExitDeps.clearLocalSessionIf（本机会话兜底，用 platform 的 clearLocalSessionIf）', () => {
  it('只删 sb-*-auth-token 和它的 code-verifier、-user 两个附属键；pv-locale、install_id 不动', () => {
    localStorage.setItem('sb-127-auth-token', '{"user":{"id":"x"}}');
    localStorage.setItem('sb-127-auth-token-code-verifier', 'v');
    localStorage.setItem('sb-127-auth-token-user', '{"user":{"id":"x"}}');
    localStorage.setItem('pv-locale', 'ko');
    localStorage.setItem('install_id', 'i');
    defaultExitDeps.clearLocalSessionIf(null);   // 令牌里没有 session_id：按 null 比，对得上
    expect(localStorage.getItem('sb-127-auth-token-user')).toBeNull();
    expect(localStorage.getItem('sb-127-auth-token')).toBeNull();
    expect(localStorage.getItem('sb-127-auth-token-code-verifier')).toBeNull();
    expect(localStorage.getItem('pv-locale')).toBe('ko');
    expect(localStorage.getItem('install_id')).toBe('i');
  });
});

describe('defaultExitDeps.deleteDb（按库名删库）', () => {
  it('先关本页的库连接（原因 closed，不触发升级中心 reload），再删 planner-v4', async () => {
    const seq: string[] = [];
    const deleted = fakeIdb();
    boot.current = { status: 'ready', profile: null, cache: { isClosed: () => false, close: () => void seq.push('close') }, upgrade: up() };
    await defaultExitDeps.deleteDb();
    expect(seq).toEqual(['close']);
    expect(deleted).toEqual(['planner-v4']);
    boot.current = { status: 'ready', profile: null, cache: { close: () => { throw new Error('closed'); } }, upgrade: up() };
    await defaultExitDeps.deleteDb();
    expect(deleted).toEqual(['planner-v4', 'planner-v4']);
  });
});

describe('defaultExitDeps.releaseHold', () => {
  it('放的是 wipe 里 holdBusy 返回的那个函数，只放一次；没占过时什么也不做', async () => {
    const release = vi.fn();
    fakeIdb();
    boot.current = { status: 'ready', profile: null, cache: null, upgrade: { holdBusy: () => release } };
    await defaultExitDeps.wipe?.();
    expect(release).not.toHaveBeenCalled();
    defaultExitDeps.releaseHold?.();
    defaultExitDeps.releaseHold?.();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
