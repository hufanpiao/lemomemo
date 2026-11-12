// 设备判断（架构 5.9、TC-B1-17、R-225）：iPhone、iPad 上凡是不在主屏幕模式运行的，一律只给“添加到主屏幕”教程；
// 不是 Safari 时另提示“请在 Safari 里打开本页”；电脑浏览器、安卓照常登录。
// 另有 isIPhone（只认 iPhone，视口几何的 squeeze 用）、opensKeyboard（焦点在哪会弹键盘，原来视口、快捷键、日历、运行日志各写一份，11-12 收进 env.ts）
import { afterEach, describe, expect, it } from 'vitest';
import { isAppleMobile, isIPhone, isStandalone, isTauri, opensKeyboard, runtimeOf, type NavLike } from '../env.ts';
import { installGate, isIOSSafari, mustInstallFirst } from '../install-gate.ts';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  // iPadOS 默认“请求桌面网站”：UA 和 Mac 的 Safari 一模一样，只能靠触点数分
  ipadDesktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  ipadChrome:
    'Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneKakao:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 25.9.0',
  iphoneWeChat:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c2f) NetType/WIFI Language/zh_CN',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  winChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

const nav = (userAgent: string, maxTouchPoints = 0, standalone?: boolean): NavLike => ({ userAgent, maxTouchPoints, standalone });
const noMedia = () => false;
const standaloneMedia = (q: string) => q === '(display-mode: standalone)';

describe('isAppleMobile', () => {
  it('iPhone、iPad 上的任何浏览器都算；iPadOS 伪装成 Mac 时靠触点数', () => {
    for (const ua of [UA.iphoneSafari, UA.iphoneChrome, UA.ipadChrome, UA.iphoneKakao, UA.iphoneWeChat]) {
      expect(isAppleMobile(nav(ua, 5)), ua).toBe(true);
    }
    expect(isAppleMobile(nav(UA.ipadDesktopSafari, 5))).toBe(true);
  });

  it('电脑、安卓不算（Mac 没有触屏，Windows 触屏本不是 Mac UA）', () => {
    expect(isAppleMobile(nav(UA.macSafari, 0))).toBe(false);
    expect(isAppleMobile(nav(UA.winChrome, 10))).toBe(false);
    expect(isAppleMobile(nav(UA.android, 5))).toBe(false);
  });
});

describe('isIOSSafari', () => {
  it('iPhone 的 Safari、iPadOS 的 Safari（Mac UA + 触屏）算', () => {
    expect(isIOSSafari(nav(UA.iphoneSafari, 5))).toBe(true);
    expect(isIOSSafari(nav(UA.ipadDesktopSafari, 5))).toBe(true);
  });

  it('iOS 上的 Chrome（CriOS）、KakaoTalk、微信（MicroMessenger）不是 Safari', () => {
    expect(isIOSSafari(nav(UA.iphoneChrome, 5))).toBe(false);
    expect(isIOSSafari(nav(UA.ipadChrome, 5))).toBe(false);
    expect(isIOSSafari(nav(UA.iphoneKakao, 5))).toBe(false);
    expect(isIOSSafari(nav(UA.iphoneWeChat, 5))).toBe(false);
  });

  it('电脑浏览器一律不算', () => {
    expect(isIOSSafari(nav(UA.macSafari, 0))).toBe(false);
    expect(isIOSSafari(nav(UA.winEdge, 0))).toBe(false);
  });
});

describe('isStandalone', () => {
  it('iOS 看 navigator.standalone，其他看 display-mode', () => {
    expect(isStandalone(nav(UA.iphoneSafari, 5, true), noMedia)).toBe(true);
    expect(isStandalone(nav(UA.iphoneSafari, 5, false), noMedia)).toBe(false);
    expect(isStandalone(nav(UA.winEdge), standaloneMedia)).toBe(true);
  });
});

describe('mustInstallFirst / installGate（TC-B1-17、R-225）', () => {
  it('iPhone、iPadOS 的 Safari 非主屏幕：拦，只给教程', () => {
    expect(mustInstallFirst(nav(UA.iphoneSafari, 5), noMedia)).toBe(true);
    expect(installGate(nav(UA.iphoneSafari, 5), noMedia)).toBe('install');
    expect(installGate(nav(UA.ipadDesktopSafari, 5), noMedia)).toBe('install');
  });

  it('R-225：iOS 上的 Chrome、KakaoTalk、微信也拦，并提示“请在 Safari 里打开本页”', () => {
    for (const ua of [UA.iphoneChrome, UA.ipadChrome, UA.iphoneKakao, UA.iphoneWeChat]) {
      expect(mustInstallFirst(nav(ua, 5), noMedia), ua).toBe(true);
      expect(installGate(nav(ua, 5), noMedia), ua).toBe('install-safari');
    }
  });

  it('主屏幕版能登录', () => {
    expect(installGate(nav(UA.iphoneSafari, 5, true), noMedia)).toBe('login');
    expect(installGate(nav(UA.ipadDesktopSafari, 5), standaloneMedia)).toBe('login');
  });

  it('电脑浏览器（Edge、Chrome、Mac Safari）、安卓能登录', () => {
    for (const ua of [UA.winEdge, UA.winChrome, UA.macSafari, UA.android]) {
      expect(mustInstallFirst(nav(ua), noMedia), ua).toBe(false);
      expect(installGate(nav(ua), noMedia), ua).toBe('login');
    }
  });
});

// B2 架构审 D4 第 1 点：运行环境的判断只在 env.ts 一处，device-info、sw-register 共用
describe('runtimeOf / isTauri（exe 判断）', () => {
  it('window 上有 __TAURI_INTERNALS__（Tauri v2）或 __TAURI__（withGlobalTauri）是 tauri；都没有是 web', () => {
    expect(runtimeOf({ __TAURI_INTERNALS__: {} })).toBe('tauri');
    expect(runtimeOf({ __TAURI__: {} })).toBe('tauri');
    expect(runtimeOf({})).toBe('web');
    expect(isTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isTauri({})).toBe(false);
    // 默认读 globalThis：jsdom 里没有 Tauri
    expect(runtimeOf()).toBe('web');
  });
});

describe('isIPhone：只认 iPhone、iPod', () => {
  it('iPhone 算；iPad（UA 伪装成 Mac）、Mac、安卓不算', () => {
    expect(isIPhone(UA.iphoneSafari)).toBe(true);
    expect(isIPhone(UA.ipadDesktopSafari)).toBe(false);
    expect(isIPhone('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')).toBe(false);
  });
});

describe('opensKeyboard：焦点在哪会弹键盘', () => {
  afterEach(() => document.body.replaceChildren());
  const mk = (html: string): Element => {
    document.body.innerHTML = html; // eslint-disable-line no-restricted-syntax -- 测试里搭 DOM
    return document.body.firstElementChild as Element;
  };

  it('文字 input、textarea、select 算；按钮、复选框、单选、滑块、只读、禁用的不算', () => {
    expect(opensKeyboard(mk('<input type="text">'))).toBe(true);
    expect(opensKeyboard(mk('<input type="search">'))).toBe(true);
    expect(opensKeyboard(mk('<input>'))).toBe(true);
    expect(opensKeyboard(mk('<textarea></textarea>'))).toBe(true);
    expect(opensKeyboard(mk('<select><option>a</option></select>'))).toBe(true);
    for (const t of ['checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color', 'hidden']) expect(opensKeyboard(mk(`<input type="${t}">`))).toBe(false);
    expect(opensKeyboard(mk('<input type="text" readonly>'))).toBe(false);
    expect(opensKeyboard(mk('<textarea disabled></textarea>'))).toBe(false);
    expect(opensKeyboard(mk('<button>x</button>'))).toBe(false);
  });

  it('没聚焦（activeElement 是 body）、null、不是元素都不算', () => {
    expect(opensKeyboard(document.activeElement)).toBe(false);
    expect(opensKeyboard(null)).toBe(false);
    expect(opensKeyboard(window)).toBe(false);
  });
});
