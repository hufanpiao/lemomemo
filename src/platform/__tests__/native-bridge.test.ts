// 网页版和 exe 分开实现的四个 platform 函数（src/platform/native-bridge.ts；B2 架构审 D4 第 2 点，第一天派工表第 10 行）
// 网页版：openReminder 改 hash / 跳转，requestAppUpdate 走 SW 更新，showLocalReminder、closeLocalReminder 空操作；
// exe：desktop.ts 调 setNativeBridge 后四个函数全部转给它
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeAllLocalReminders,
  openExternal,
  openSitePage,
  sitePageUrl,
  closeLocalReminder,
  openAuth,
  openReminder,
  reminderHash,
  reminderPath,
  reminderTag,
  requestAppUpdate,
  resetNativeBridgeForTest,
  setNativeBridge,
  showLocalReminder,
  webBridge,
  type LocalReminder,
  type LocationLike,
  type NativeBridge,
} from '../native-bridge.ts';

const ID = '33333333-3333-4333-8333-333333333333';
const DUE = 1_800_000_000_000;
const rem: LocalReminder = { tag: reminderTag('event', ID, DUE), kind: 'event', id: ID, dueAt: DUE, title: '周会', body: '10:00' };

afterEach(() => {
  resetNativeBridgeForTest();
});

function fakeLoc(pathname: string): LocationLike & { assigned: string[]; replaced: string[] } {
  const assigned: string[] = [];
  const replaced: string[] = [];
  return { pathname, hash: '', assign: (u) => void assigned.push(u), replace: (u) => void replaced.push(u), assigned, replaced };
}

describe('地址和 tag', () => {
  it('hash、完整路径、tag 的格式', () => {
    expect(reminderHash('todo', ID, DUE)).toBe(`#/remind/todo/${ID}?due=${DUE}`);
    expect(reminderPath('anniv', ID, DUE)).toBe(`/app/#/remind/anniv/${ID}?due=${DUE}`);
    expect(reminderTag('event', ID, DUE)).toBe(`event:${ID}:${DUE}`);
  });
});

describe('网页版', () => {
  it('openReminder：已在 /app/ 里只改 hash，不重新载入', async () => {
    for (const p of ['/app/', '/app/index.html']) {
      const loc = fakeLoc(p);
      await webBridge({ location: () => loc }).openReminder('event', ID, DUE);
      expect(loc.hash).toBe(`#/remind/event/${ID}?due=${DUE}`);
      expect(loc.assigned).toEqual([]);
    }
  });

  it('openReminder：不在 /app/（例如登录页）就整页跳过去', async () => {
    const loc = fakeLoc('/app/auth/');
    await webBridge({ location: () => loc }).openReminder('todo', ID, DUE);
    expect(loc.assigned).toEqual([`/app/#/remind/todo/${ID}?due=${DUE}`]);
    expect(loc.hash).toBe('');
  });

  it('openAuth：整页换成登录页（replace，“返回”不回到主 App）（exe 代码审查 S8）', async () => {
    const loc = fakeLoc('/app/');
    await webBridge({ location: () => loc }).openAuth();
    expect(loc.replaced).toEqual(['/app/auth/']);
    expect(loc.assigned).toEqual([]);
  });

  it('requestAppUpdate：走 SW 更新，结果原样交回', async () => {
    const update = vi.fn(async () => 'no_update' as const);
    expect(await webBridge({ update }).requestAppUpdate()).toBe('no_update');
    expect(update).toHaveBeenCalledOnce();
  });

  it('showLocalReminder、closeLocalReminder：空操作，不碰 location、不抛', async () => {
    const loc = fakeLoc('/app/');
    const b = webBridge({ location: () => loc });
    await expect(b.showLocalReminder(rem)).resolves.toBeUndefined();
    await expect(b.closeLocalReminder(rem.tag)).resolves.toBeUndefined();
    expect(loc.hash).toBe('');
  });

  it('没装 exe 版时，导出的函数走网页版（openReminder 改 window.location.hash）', async () => {
    window.history.replaceState(null, '', '/app/');
    await openReminder('event', ID, DUE);
    expect(window.location.hash).toBe(`#/remind/event/${ID}?due=${DUE}`);
    await expect(showLocalReminder(rem)).resolves.toBeUndefined();
    await expect(closeLocalReminder(rem.tag)).resolves.toBeUndefined();
    await expect(closeAllLocalReminders()).resolves.toBeUndefined();
  });
});

describe('exe 版（setNativeBridge）', () => {
  it('装上以后六个函数全部转给它，参数原样', async () => {
    const b: NativeBridge = {
      openReminder: vi.fn(async () => undefined),
      openAuth: vi.fn(async () => undefined),
      requestAppUpdate: vi.fn(async () => 'reloading' as const),
      showLocalReminder: vi.fn(async () => undefined),
      closeLocalReminder: vi.fn(async () => undefined),
      closeAllLocalReminders: vi.fn(async () => undefined),
    };
    setNativeBridge(b);
    await openReminder('anniv', ID, DUE);
    expect(await requestAppUpdate()).toBe('reloading');
    await showLocalReminder(rem);
    await closeLocalReminder(rem.tag);
    expect(b.openReminder).toHaveBeenCalledWith('anniv', ID, DUE);
    await openAuth();
    expect(b.openAuth).toHaveBeenCalledOnce();
    expect(b.showLocalReminder).toHaveBeenCalledWith(rem);
    expect(b.closeLocalReminder).toHaveBeenCalledWith(rem.tag);
    await closeAllLocalReminders();
    expect(b.closeAllLocalReminders).toHaveBeenCalledOnce();
  });

  it('resetNativeBridgeForTest 后回到网页版', async () => {
    const b: NativeBridge = {
      openReminder: vi.fn(async () => undefined),
      openAuth: vi.fn(async () => undefined),
      requestAppUpdate: vi.fn(async () => 'reloading' as const),
      showLocalReminder: vi.fn(async () => undefined),
      closeLocalReminder: vi.fn(async () => undefined),
      closeAllLocalReminders: vi.fn(async () => undefined),
    };
    setNativeBridge(b);
    resetNativeBridgeForTest();
    window.history.replaceState(null, '', '/app/');
    await openReminder('todo', ID, DUE);
    expect(b.openReminder).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/remind/todo/${ID}?due=${DUE}`);
  });
});

describe('goToAuth 经 openAuth 去登录（exe 代码审查 S8）', () => {
  it('exe 版装上后：goToAuth 调 openAuth，不整页跳转', async () => {
    const { goToAuth } = await import('../session.ts');
    const b: NativeBridge = {
      openReminder: vi.fn(async () => undefined),
      openAuth: vi.fn(async () => undefined),
      requestAppUpdate: vi.fn(async () => 'no_update' as const),
      showLocalReminder: vi.fn(async () => undefined),
      closeLocalReminder: vi.fn(async () => undefined),
      closeAllLocalReminders: vi.fn(async () => undefined),
    };
    setNativeBridge(b);
    window.history.replaceState(null, '', '/app/');
    goToAuth();
    expect(b.openAuth).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/app/');
  });
});

describe('openExternal（R-301；B6-exe 安全审查 F5-5）', () => {
  afterEach(() => resetNativeBridgeForTest());

  it('网页版：返回 false（照浏览器默认走），不调任何东西', () => {
    expect(openExternal('https://example.com/', {})).toBe(false);
  });

  it('exe、桥里实现了 openExternal：用桥里的', () => {
    const own = vi.fn(async () => undefined);
    setNativeBridge({
      openReminder: vi.fn(async () => undefined), openAuth: vi.fn(async () => undefined),
      requestAppUpdate: vi.fn(async () => 'no_update' as const), showLocalReminder: vi.fn(async () => undefined),
      closeLocalReminder: vi.fn(async () => undefined), closeAllLocalReminders: vi.fn(async () => undefined), openExternal: own,
    });
    const invoke = vi.fn();
    expect(openExternal('mailto:a@b.test', { __TAURI_INTERNALS__: { invoke } })).toBe(true);
    expect(own).toHaveBeenCalledExactlyOnceWith('mailto:a@b.test');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exe、桥里没实现：直接 invoke open_external；同步抛也返回 true', () => {
    const invoke = vi.fn(async () => undefined);
    expect(openExternal('tel:+821012345678', { __TAURI_INTERNALS__: { invoke } })).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_external', { url: 'tel:+821012345678' });
    expect(openExternal('https://x/', { __TAURI_INTERNALS__: { invoke: () => { throw new Error('x'); } } })).toBe(true);
  });
});

describe('sitePageUrl、openSitePage（ConsentPage 的隐私说明、条款链接）', () => {
  afterEach(() => resetNativeBridgeForTest());

  it('取数据接口地址的来源拼上 path；只认 https、只认以单个 / 开头的站内地址', () => {
    expect(sitePageUrl('/ko/terms', 'https://lemomemo.com/sb')).toBe('https://lemomemo.com/ko/terms');
    expect(sitePageUrl('/zh/privacy', 'https://preview.lemomemo.com/sb/')).toBe('https://preview.lemomemo.com/zh/privacy');
    for (const [p, base] of [['zh/privacy', 'https://a.test/sb'], ['//evil.test/x', 'https://a.test/sb'], ['/zh/privacy', 'http://a.test/sb'], ['/zh/privacy', ''], ['/zh/privacy', '/sb']]) {
      expect(sitePageUrl(p as string, base)).toBeNull();
    }
  });

  it('拼不出别的主机：反斜杠、制表符换行、编码过的反斜杠、问号井号都拒', () => {
    for (const p of ['/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/%5Cevil.com', '/zh/privacy?x=1', '/zh/privacy#a', '/zh/../x', '/ zh']) {
      expect(sitePageUrl(p, 'https://lemomemo.com/sb')).toBeNull();
    }
  });

  it('网页版返回 false；exe 里交给 open_external 并返回 true；拼不出地址也返回 true、不调', () => {
    expect(openSitePage('/zh/privacy', {}, 'https://lemomemo.com/sb')).toBe(false);
    const invoke = vi.fn(async () => undefined);
    expect(openSitePage('/zh/privacy', { __TAURI_INTERNALS__: { invoke } }, 'https://lemomemo.com/sb')).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_external', { url: 'https://lemomemo.com/zh/privacy' });
    expect(openSitePage('/zh/privacy', { __TAURI_INTERNALS__: { invoke } }, '')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
