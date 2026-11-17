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
  localUnsentCount: vi.fn(async (): Promise<number | null> => null),
  /** core/account.ts 的 bootWipeSteps 交回的两步 */
  wipe: vi.fn(async () => undefined),
  deleteDb: vi.fn(async (): Promise<unknown> => 'deleted'),
  stepsOf: [] as unknown[],
}));

vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => boot.current,
  applyFreshConfig: boot.applyFreshConfig,
  localUnsentCount: boot.localUnsentCount,
}));
vi.mock('../../../core/account.ts', () => ({
  bootWipeSteps: (b: unknown) => (boot.stepsOf.push(b), { wipe: boot.wipe, deleteDb: boot.deleteDb }),
}));

const { defaultSignOutHereDeps, updateCachedLocale, writeLocalLocale } = await import('../data/local.ts');
// 写进去的语言由入口按 platform/doc-locale.ts 的 bootLocale 读回来（读 pv-locale 只有那一份）
const { bootLocale } = await import('../../../platform/doc-locale.ts');

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
  boot.localUnsentCount.mockClear();
  boot.wipe.mockReset();
  boot.deleteDb.mockClear();
  boot.stepsOf = [];
  vi.unstubAllGlobals();
});

describe('语言记在本机', () => {
  it('写 pv-locale 和 cookie lemo_lang（Path=/、一年、SameSite=Lax；http 不带 Secure）', () => {
    const doc = { cookie: '' };
    writeLocalLocale('ko', localStorage, doc);
    expect(localStorage.getItem('pv-locale')).toBe('ko');
    expect(doc.cookie).toBe('lemo_lang=ko; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(bootLocale()).toBe('ko-KR');
  });

  it('读到不认识的值当没选过（按设备语言）；存储不能用（隐私模式）时写也不报错', () => {
    localStorage.setItem('pv-locale', 'ko-KR');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
    expect(bootLocale()).toBe('zh-CN');
    vi.restoreAllMocks();
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
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

describe('defaultSignOutHereDeps（本人退出给 platform/exit-basics.ts 的 wipeThisDevice 的两步，和别的出口同一份 bootWipeSteps）', () => {
  it('wipe 先占住“忙”（holdBusy，不释放），再走本页 boot 的 bootWipeSteps().wipe；没启动什么也不做', async () => {
    const seq: string[] = [];
    const release = vi.fn();
    const b = { status: 'ready', profile: null, cache: {}, upgrade: { holdBusy: vi.fn((reason: string) => (seq.push(`busy:${reason}`), release)) } };
    boot.current = b;
    boot.wipe.mockImplementationOnce(async () => void seq.push('wipe'));
    await defaultSignOutHereDeps.wipe?.();
    expect(seq).toEqual(['busy:sign_out', 'wipe']);
    expect(boot.stepsOf).toEqual([b]);
    expect(release).not.toHaveBeenCalled();
    boot.current = null;
    await defaultSignOutHereDeps.wipe?.();
    expect(boot.wipe).toHaveBeenCalledTimes(1);
  });

  it('清库出错不吞掉：wipe 照样拒绝，由 wipeThisDevice 往下按库名删', async () => {
    boot.current = { status: 'ready', profile: null, cache: {}, upgrade: up() };
    boot.wipe.mockRejectedValueOnce(new Error('quota'));
    await expect(defaultSignOutHereDeps.wipe?.()).rejects.toThrow('quota');
  });

  it('pendingCount 交给 core/boot 的 localUnsentCount（当前的 boot）', async () => {
    const b = { status: 'ready', profile: null, cache: null, upgrade: up() };
    boot.current = b;
    boot.localUnsentCount.mockResolvedValueOnce(7);
    expect(await defaultSignOutHereDeps.pendingCount()).toBe(7);
    expect(boot.localUnsentCount).toHaveBeenCalledWith(b);
  });
});

describe('defaultSignOutHereDeps.clearLocalSessionIf（本机会话兜底，用 platform 的 clearLocalSessionIf）', () => {
  it('只删 sb-*-auth-token 和它的 code-verifier、-user 两个附属键；pv-locale、install_id 不动', () => {
    localStorage.setItem('sb-127-auth-token', '{"user":{"id":"x"}}');
    localStorage.setItem('sb-127-auth-token-code-verifier', 'v');
    localStorage.setItem('sb-127-auth-token-user', '{"user":{"id":"x"}}');
    localStorage.setItem('pv-locale', 'ko');
    localStorage.setItem('install_id', 'i');
    defaultSignOutHereDeps.clearLocalSessionIf(null);   // 令牌里没有 session_id：按 null 比，对得上
    expect(localStorage.getItem('sb-127-auth-token-user')).toBeNull();
    expect(localStorage.getItem('sb-127-auth-token')).toBeNull();
    expect(localStorage.getItem('sb-127-auth-token-code-verifier')).toBeNull();
    expect(localStorage.getItem('pv-locale')).toBe('ko');
    expect(localStorage.getItem('install_id')).toBe('i');
  });
});

describe('defaultSignOutHereDeps.deleteDb（按库名删库）', () => {
  it('启动过：走 bootWipeSteps().deleteDb（先关本页连接再删）；没启动：直接按库名删 planner-v4', async () => {
    const deleted = fakeIdb();
    const b = { status: 'ready', profile: null, cache: {}, upgrade: up() };
    boot.current = b;
    await defaultSignOutHereDeps.deleteDb();
    expect(boot.deleteDb).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual([]);
    boot.current = null;
    await defaultSignOutHereDeps.deleteDb();
    expect(deleted).toEqual(['planner-v4']);
  });
});

describe('defaultSignOutHereDeps.releaseHold', () => {
  it('放的是 wipe 里 holdBusy 返回的那个函数，只放一次；没占过时什么也不做', async () => {
    const release = vi.fn();
    fakeIdb();
    boot.current = { status: 'ready', profile: null, cache: null, upgrade: { holdBusy: () => release } };
    await defaultSignOutHereDeps.wipe?.();
    expect(release).not.toHaveBeenCalled();
    defaultSignOutHereDeps.releaseHold?.();
    defaultSignOutHereDeps.releaseHold?.();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
