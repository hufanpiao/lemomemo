// 设备判断（架构 5.9、TC-B1-17、R-225）：iPhone、iPad 上凡是不在主屏幕模式运行的，一律只给“添加到主屏幕”教程；
// 不是 Safari 时另提示“请在 Safari 里打开本页”；电脑浏览器、安卓照常登录
import { describe, expect, it } from 'vitest';
import { installGate, isAppleMobile, isIOSSafari, isStandalone, mustInstallFirst, type NavLike } from '../env.ts';

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
