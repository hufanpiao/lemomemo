// FA2-3（B2 安全审查）：exe 里退出、被移除以后，主窗口不能还停在原来的界面上（编辑页保留的输入、内存里的集合都还看得见）。
// 账号的界面画出来过以后，goToAuth 先等会话真删掉、再整页重新载入（重新启动时没有会话，只开登录小窗口）；网页版照旧 openAuth
// A-1（安全审查）/ A-M1（代码审查）：Rust 删失败时不重新载入、显示“退出没完成”，localStorage 只记一个标记；重试、下次启动先删
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reloadPage = vi.fn();
const openAuth = vi.fn(async () => undefined);
vi.mock('../sw-register.ts', () => ({ reloadPage: () => reloadPage() }));
vi.mock('../native-bridge.ts', () => ({ openAuth: () => openAuth() }));

const { clearAnyLocalSession, goToAuth, markAccountUiShown, resetAccountUiShownForTest, sessionStorageKey } = await import('../session.ts');
const {
  DROP_MARK_KEY, authBackendStorage, desktopSessionError, enableDropMark, exitIncompleteShown, hasDropMark, installDesktopSession, resetSessionBackendForTest,
  sessionDropState, sessionStore, setSessionBackend,
} = await import('../session-store.ts');
const { retryDropSession, settleDropAtStartup } = await import('../session-drop.ts');

const w = window as unknown as Record<string, unknown>;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  reloadPage.mockClear();
  openAuth.mockClear();
  resetAccountUiShownForTest();
  resetSessionBackendForTest();
  localStorage.clear();
});
afterEach(() => {
  delete w['__TAURI_INTERNALS__'];
  resetSessionBackendForTest();
});

describe('goToAuth 在 exe 里（FA2-3）', () => {
  it('启动时没登录（界面还没画）：只开登录小窗口，不重新载入', async () => {
    w['__TAURI_INTERNALS__'] = {};
    goToAuth();
    await flush();
    expect(openAuth).toHaveBeenCalledOnce();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('账号界面画过以后被移除：先删会话、等 Rust 删完，再整页重新载入；不在原来的窗口上开小窗口', async () => {
    w['__TAURI_INTERNALS__'] = {};
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const removeItem = vi.fn(() => gate);
    // 本机有一个会话键（读不出 session_id，按“还是那一个”删）
    const k = sessionStorageKey() ?? 'sb-x-auth-token';
    const view = { length: 1, key: (i: number) => (i === 0 ? k : null), getItem: (x: string) => (x === k ? '{}' : null) } as unknown as Storage;
    setSessionBackend({ getItem: async () => null, setItem: async () => undefined, removeItem }, view);
    markAccountUiShown();
    goToAuth('removed', null);
    await flush();
    expect(removeItem).toHaveBeenCalled();
    expect(reloadPage).not.toHaveBeenCalled();
    open();
    await flush();
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(openAuth).not.toHaveBeenCalled();
  });

  it('自己退出（不带原因）：同样重新载入', async () => {
    w['__TAURI_INTERNALS__'] = {};
    markAccountUiShown();
    goToAuth();
    await flush();
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(openAuth).not.toHaveBeenCalled();
  });

  it('网页版：照旧 openAuth（location.replace 本来就整页卸载）', async () => {
    markAccountUiShown();
    goToAuth();
    await flush();
    expect(openAuth).toHaveBeenCalledOnce();
    expect(reloadPage).not.toHaveBeenCalled();
  });
});

/** 装一个有会话键的假后端；removeItem 由调用方给。main = 主窗口（开了“待删除”标记），false = 登录小窗口 */
function backendWithSession(removeItem: (k: string) => Promise<void>, main = true, keys0?: Set<string>) {
  const k = sessionStorageKey() ?? 'sb-x-auth-token';
  const keys = keys0 ?? new Set([k]);
  const view = {
    get length() {
      return keys.size;
    },
    key: (i: number) => [...keys][i] ?? null,
    getItem: (x: string) => (keys.has(x) ? '{"access_token":"secret-token"}' : null),
  } as unknown as Storage;
  const rm = vi.fn(async (x: string) => {
    await removeItem(x);
    keys.delete(x);
  });
  setSessionBackend({ getItem: async () => null, setItem: async () => undefined, removeItem: rm }, view);
  if (main) enableDropMark();
  return { rm, keys, k };
}

describe('Rust 删会话失败（A-1、A-M1）', () => {
  it('被移除时删失败：不调 reloadPage，显示“退出没完成”；localStorage 只有一个标记，不含令牌；状态 failed', async () => {
    w['__TAURI_INTERNALS__'] = {};
    backendWithSession(async () => {
      throw new Error('session_remove_failed');
    });
    markAccountUiShown();
    goToAuth('removed', null);
    await flush();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(openAuth).not.toHaveBeenCalled();
    expect(exitIncompleteShown()).toBe(true);
    expect(sessionDropState()).toBe('failed');
    expect(localStorage.getItem(DROP_MARK_KEY)).toBe('1');
    expect(Object.keys(localStorage)).toEqual([DROP_MARK_KEY]);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('secret-token');
  });

  it('“重试”：再删一次，删成了撤掉标记、重新载入；还是失败就返回 false、不重新载入', async () => {
    w['__TAURI_INTERNALS__'] = {};
    let fail = true;
    const { keys } = backendWithSession(async () => {
      if (fail) throw new Error('x');
    });
    markAccountUiShown();
    goToAuth();
    await expect(retryDropSession()).resolves.toBe(false);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(hasDropMark()).toBe(true);
    fail = false;
    await expect(retryDropSession()).resolves.toBe(true);
    expect(keys.size).toBe(0);
    expect(hasDropMark()).toBe(false);
    expect(sessionDropState()).toBe('ok');
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('删成功的一轮：先记标记、删完撤掉；goToAuth 重新载入', async () => {
    w['__TAURI_INTERNALS__'] = {};
    let marked: string | null = null;
    backendWithSession(async () => {
      marked = localStorage.getItem(DROP_MARK_KEY);
    });
    markAccountUiShown();
    goToAuth('removed', null);
    await flush();
    expect(marked).toBe('1');
    expect(hasDropMark()).toBe(false);
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(exitIncompleteShown()).toBe(false);
  });

  it('下次启动带着标记：先删会话；删成了撤标记返回 true，删不掉返回 false（不画账号界面）；网页版、没有标记直接 true', async () => {
    await expect(settleDropAtStartup()).resolves.toBe(true);
    w['__TAURI_INTERNALS__'] = {};
    await expect(settleDropAtStartup()).resolves.toBe(true);
    localStorage.setItem(DROP_MARK_KEY, '1');
    const bad = backendWithSession(async () => {
      throw new Error('x');
    });
    await expect(settleDropAtStartup()).resolves.toBe(false);
    expect(bad.rm).toHaveBeenCalled();
    expect(hasDropMark()).toBe(true);
    resetSessionBackendForTest();
    const good = backendWithSession(async () => undefined);
    await expect(settleDropAtStartup()).resolves.toBe(true);
    expect(good.keys.size).toBe(0);
    expect(hasDropMark()).toBe(false);
  });
});

describe('“待删除”标记只记主窗口的显式退出（安全复审建议 ①）', () => {
  it('登录小窗口删失败、随后登录成功：不记标记；主窗口重新载入后会话还在、不被删', async () => {
    w['__TAURI_INTERNALS__'] = {};
    // 登录小窗口：useAccountGate 那条显式删除、supabase-js 自己删键，都失败
    const popup = backendWithSession(async () => {
      throw new Error('session_remove_failed');
    }, false);
    await expect(clearAnyLocalSession()).resolves.toBe(false);
    await authBackendStorage()?.removeItem(popup.k).catch(() => undefined);
    await flush();
    expect(hasDropMark()).toBe(false);
    // 随后登录成功：凭据管理器里是新会话
    const saved = new Set(popup.keys);
    saved.add(popup.k);
    // 主窗口整页重新载入
    resetSessionBackendForTest();
    const main = backendWithSession(async () => undefined, true, saved);
    await expect(settleDropAtStartup()).resolves.toBe(true);
    expect(main.rm).not.toHaveBeenCalled();
    expect(sessionStore().getItem(main.k)).not.toBeNull();
    expect(sessionDropState()).toBe('ok');
  });

  it('主窗口里 supabase-js 自己删键失败：不写标记（下次启动不会删），但本页状态照样是 failed（goToAuth 不重新载入）', async () => {
    w['__TAURI_INTERNALS__'] = {};
    const b = backendWithSession(async () => {
      throw new Error('x');
    });
    await authBackendStorage()?.removeItem(b.k).catch(() => undefined);
    await flush();
    expect(hasDropMark()).toBe(false);
    expect(sessionDropState()).toBe('failed');
  });
});

describe('installDesktopSession 的两条建议', () => {
  const mod = (over: Record<string, unknown> = {}) => ({
    createDesktopSessionStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, preload: async () => undefined }),
    desktopSessionKeys: () => [],
    sessionStorageView: () => ({ length: 0, key: () => null, getItem: () => null }) as unknown as Storage,
    onAuthDone: async () => () => undefined,
    ...over,
  });

  it('装上以后删掉 localStorage 里以前的 sb-*-auth-token 键（连附属键），别的键不动', async () => {
    localStorage.setItem('sb-abc-auth-token', '{"access_token":"old"}');
    localStorage.setItem('sb-abc-auth-token-user', '{}');
    localStorage.setItem('pv-locale', 'zh');
    const ok = await installDesktopSession(undefined, async () => mod() as never, () => true);
    expect(ok).toBe(true);
    expect(Object.keys(localStorage).sort()).toEqual(['pv-locale']);
    expect(desktopSessionError()).toBeNull();
  });

  it('没装上：记下错误码（只是码，不含令牌）；旧键不动', async () => {
    localStorage.setItem('sb-abc-auth-token', '{}');
    expect(await installDesktopSession(undefined, async () => { throw new Error('chunk'); }, () => true)).toBe(false);
    expect(desktopSessionError()).toBe('load_failed');
    expect(await installDesktopSession(undefined, async () => mod({ createDesktopSessionStorage: () => null }) as never, () => true)).toBe(false);
    expect(desktopSessionError()).toBe('no_store');
    const failPreload = mod({ createDesktopSessionStorage: () => ({ preload: async () => { throw new Error('rust'); } }) });
    expect(await installDesktopSession(undefined, async () => failPreload as never, () => true)).toBe(false);
    expect(desktopSessionError()).toBe('preload_failed');
    expect(localStorage.getItem('sb-abc-auth-token')).toBe('{}');
  });
});
