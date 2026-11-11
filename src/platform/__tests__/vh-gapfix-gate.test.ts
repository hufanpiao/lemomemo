// R-371 Gap fix 默认开（platform/vh-gapfix-gate.ts，11-11）：冷启动时要不要下载 vh-gapfix.ts。
// 默认开；只在 iOS（iPhone、iPad）主屏幕版做；iOS 上在浏览器里打开、电脑、安卓（哪怕是装到主屏幕的）都不做；诊断页关掉（OFF_KEY）就不做
import { describe, expect, it } from 'vitest';
import { gapFixWanted, OFF_KEY } from '../vh-gapfix-gate.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const store = (v: string | null): Storage => ({ getItem: (k: string) => (k === OFF_KEY ? v : null) }) as unknown as Storage;
const empty = store(null);
const noMedia = (): boolean => false;
const standaloneMedia = (q: string): boolean => q === '(display-mode: standalone)';
const ios = { userAgent: IPHONE, maxTouchPoints: 5, standalone: true };

describe('gapFixWanted（R-371 Gap fix 默认开）', () => {
  it('默认开：iPhone 主屏幕版、诊断页没关过（本机没存）就做', () => {
    expect(gapFixWanted(ios, noMedia, empty)).toBe(true);
  });

  it('iPad（UA 伪装成 Mac、有触屏）主屏幕版也做', () => {
    expect(gapFixWanted({ userAgent: IPAD, maxTouchPoints: 5, standalone: true }, noMedia, empty)).toBe(true);
  });

  it('standalone 才开：iPhone 上在 Safari 里直接打开（不是主屏幕版）不做', () => {
    expect(gapFixWanted({ userAgent: IPHONE, maxTouchPoints: 5, standalone: false }, noMedia, empty)).toBe(false);
    expect(gapFixWanted({ userAgent: IPHONE, maxTouchPoints: 5 }, noMedia, empty)).toBe(false);
  });

  it('非 iOS 不开：安卓、电脑哪怕是装到主屏幕 / 桌面的（display-mode: standalone）也不做；Mac（没有触屏）不做', () => {
    expect(gapFixWanted({ userAgent: ANDROID, maxTouchPoints: 5 }, standaloneMedia, empty)).toBe(false);
    expect(gapFixWanted({ userAgent: WIN, maxTouchPoints: 0 }, standaloneMedia, empty)).toBe(false);
    expect(gapFixWanted({ userAgent: IPAD, maxTouchPoints: 0 }, standaloneMedia, empty)).toBe(false);
  });

  it('诊断页关掉（OFF_KEY = 1）就不做；别的值照默认做', () => {
    expect(gapFixWanted(ios, noMedia, store('1'))).toBe(false);
    expect(gapFixWanted(ios, noMedia, store('0'))).toBe(true);
  });

  it('读不到本机存储（抛错）时照默认做、不抛', () => {
    const bad = {
      getItem: () => {
        throw new Error('x');
      },
    } as unknown as Storage;
    expect(gapFixWanted(ios, noMedia, bad)).toBe(true);
  });
});
