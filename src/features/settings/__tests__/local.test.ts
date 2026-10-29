// 设置页的本机部分：语言记在哪、缓存的 profile 跟着改、退出时清空本机（架构 2.4 第 4 条、16.4、4.1）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeBoot {
  status?: string;
  profile: Record<string, unknown> | null;
  cache: unknown;
}

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

const { defaultExitDeps, readLocalLocale, updateCachedLocale, wipeThisDevice, writeLocalLocale } = await import('../data/local.ts');

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

describe('wipeThisDevice', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('先清本机库，再清 Cache Storage；库清不掉就直接删库，也照样清缓存', async () => {
    const deleted = fakeIdb();
    const order: string[] = [];
    await wipeThisDevice({
      wipe: async () => {
        order.push('wipe');
        throw new Error('closed');
      },
      clearCacheStorage: async () => void order.push('caches'),
    });
    expect(order).toEqual(['wipe', 'caches']);
    expect(deleted).toEqual(['planner-v4']);
  });

  it('清库卡住（别的标签页挡着）、清缓存卡住：各自到上限就往下走，不会一直等', async () => {
    vi.useFakeTimers();
    const deleted = fakeIdb();
    const hang = () => new Promise<void>(() => undefined);
    let done = false;
    void wipeThisDevice({ wipe: hang, clearCacheStorage: hang }, 3000, 2000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(deleted).toEqual(['planner-v4']);
    expect(done).toBe(false);
    // 删库在 3 秒那一刻才放行，清缓存从那时起再等 2 秒
    await vi.advanceTimersByTimeAsync(2100);
    expect(done).toBe(true);
  });
});

describe('defaultExitDeps', () => {
  it('库能用：走 core/boot 的 wipeLocal，不删整个库', async () => {
    const deleted = fakeIdb();
    const cache = { isClosed: () => false };
    boot.current = { status: 'ready', profile: null, cache };
    await defaultExitDeps.wipe();
    expect(boot.wipeLocal).toHaveBeenCalledWith(cache);
    expect(deleted).toEqual([]);
  });

  it('库已关闭：直接 indexedDB.deleteDatabase("planner-v4") 兜底', async () => {
    const deleted = fakeIdb();
    boot.current = { status: 'ready', profile: null, cache: { isClosed: () => true } };
    await defaultExitDeps.wipe();
    expect(boot.wipeLocal).not.toHaveBeenCalled();
    expect(deleted).toEqual(['planner-v4']);
  });

  it('打不开、来自更新的版本（version_too_new）、没启动：同样删整个库', async () => {
    for (const b of [{ status: 'unavailable', profile: null, cache: null }, { status: 'version_too_new', profile: null, cache: null }, null]) {
      const deleted = fakeIdb();
      boot.current = b;
      await defaultExitDeps.wipe();
      expect(deleted).toEqual(['planner-v4']);
    }
  });

  it('pendingCount 交给 core/boot 的 localUnsentCount（当前的 boot）', async () => {
    const b = { status: 'ready', profile: null, cache: null };
    boot.current = b;
    boot.localUnsentCount.mockResolvedValueOnce(7);
    expect(await defaultExitDeps.pendingCount()).toBe(7);
    expect(boot.localUnsentCount).toHaveBeenCalledWith(b);
  });

  it('wipe 先同步设闸（sealForExit），再清库；库不能用时也先设闸再删库', async () => {
    const seq: string[] = [];
    fakeIdb();
    const cache = { isClosed: () => false };
    const b = { status: 'ready', profile: null, cache };
    boot.current = b;
    boot.seal.mockImplementation(() => void seq.push('seal'));
    boot.wipeLocal.mockImplementationOnce(async () => void seq.push('clear'));
    await defaultExitDeps.wipe();
    expect(boot.seal).toHaveBeenCalledWith(b);
    expect(seq).toEqual(['seal', 'clear']);
    boot.seal.mockClear();
    boot.current = { status: 'version_too_new', profile: null, cache: null };
    await defaultExitDeps.wipe();
    expect(boot.seal).toHaveBeenCalledTimes(1);
  });
});

describe('defaultExitDeps.clearLocalSession（本机会话兜底，用 platform 的 clearLocalSession）', () => {
  it('只删 sb-*-auth-token 和 sb-*-auth-token-code-verifier；pv-locale、install_id 不动', () => {
    localStorage.setItem('sb-127-auth-token', '{"user":{"id":"x"}}');
    localStorage.setItem('sb-127-auth-token-code-verifier', 'v');
    localStorage.setItem('pv-locale', 'ko');
    localStorage.setItem('install_id', 'i');
    defaultExitDeps.clearLocalSession();
    expect(localStorage.getItem('sb-127-auth-token')).toBeNull();
    expect(localStorage.getItem('sb-127-auth-token-code-verifier')).toBeNull();
    expect(localStorage.getItem('pv-locale')).toBe('ko');
    expect(localStorage.getItem('install_id')).toBe('i');
  });
});
