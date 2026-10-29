// 模拟 UA 和登录页的共用部分（从 b1-login-ua.spec.ts 抽出来，E2E-REAL 第 5 步）：
// 无后端组的 b1-login-ua.spec.ts（判断逻辑、页面上该出教程还是登录表单）和真后端组的 b1-login-ua.real.spec.ts（真的登录一遍）共用。
// 只模拟 JS 能读到的部分（UA、maxTouchPoints、navigator.standalone、matchMedia）；CSS 的 @media (display-mode) 不跟着变。
// App 的判断是 platform/env.installGate()（isAppleMobile、isStandalone、isIOSSafari；iPadOS 加 maxTouchPoints > 1；R-225），按这几个 JS 接口判断时模拟有效。
// 这个文件不连任何后端。
import { devices, type Page } from '@playwright/test';

type Device = (typeof devices)[string];

/** describe 里不能改 defaultBrowserType（会强制换 worker），去掉它 */
export function withoutBrowser(d: Device): Omit<Device, 'defaultBrowserType'> {
  const { defaultBrowserType: _ignored, ...rest } = d;
  return rest;
}

export const IPHONE = withoutBrowser(devices['iPhone 15'] as Device);
export const MAC_SAFARI = withoutBrowser(devices['Desktop Safari'] as Device);
export const DESKTOP_CHROME = withoutBrowser(devices['Desktop Chrome'] as Device);

export type Kind = 'iphone' | 'standalone' | 'ipad' | 'desktop';

/** 在页面脚本之前改掉模拟不到的接口：navigator.standalone、display-mode、maxTouchPoints */
export async function emulate(page: Page, kind: Kind): Promise<void> {
  await page.addInitScript(
    ({ standalone, touchPoints, safari }) => {
      // iOS / iPadOS 的 Safari 一直有 navigator.standalone（主屏幕版 true、Safari 里 false）；桌面不动它
      if (safari) {
        Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => standalone });
      }
      if (touchPoints !== null) {
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => touchPoints });
      }
      if (!standalone) return;
      const orig = window.matchMedia.bind(window);
      window.matchMedia = (query: string): MediaQueryList => {
        const m = /^\s*\(\s*display-mode\s*:\s*([a-z-]+)\s*\)\s*$/i.exec(query);
        const list = orig(query);
        if (!m) return list;
        const matches = m[1]?.toLowerCase() === 'standalone';
        return new Proxy(list, {
          get(target, prop) {
            if (prop === 'matches') return matches;
            const v: unknown = Reflect.get(target, prop, target);
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      };
    },
    {
      standalone: kind === 'standalone',
      touchPoints: kind === 'ipad' ? 5 : null,
      safari: kind !== 'desktop',
    },
  );
}

export interface EnvSeen {
  ua: string;
  maxTouchPoints: number;
  navStandalone: boolean | null;
  displayStandalone: boolean;
}

export async function readEnv(page: Page): Promise<EnvSeen> {
  return page.evaluate(() => {
    const s = (navigator as Navigator & { standalone?: unknown }).standalone;
    return {
      ua: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
      navStandalone: typeof s === 'boolean' ? s : null,
      displayStandalone: window.matchMedia('(display-mode: standalone)').matches,
    };
  });
}

/**
 * 判断式（测试这边的参照，不是 App 的实现；R-225 起不分浏览器）：
 * iPhone、iPad（iPadOS 是 Mac UA ＋ maxTouchPoints > 1）上不在主屏幕模式 → 只给“添加到主屏幕”教程；
 * 其中不是 Safari 的（iOS 的 Chrome、KakaoTalk、微信等）另提示“请在 Safari 里打开本页”；电脑浏览器照常登录
 */
export function expectedGate(e: EnvSeen): 'tutorial' | 'tutorial-safari' | 'login' {
  const appleTouch = /iPhone|iPad|iPod/.test(e.ua) || (/Macintosh/.test(e.ua) && e.maxTouchPoints > 1);
  const safari = /Safari\//.test(e.ua) && /Version\//.test(e.ua) && !/CriOS|FxiOS|EdgiOS|KAKAOTALK|MicroMessenger|Chrome\//.test(e.ua);
  const standalone = e.displayStandalone || e.navStandalone === true;
  if (!appleTouch || standalone) return 'login';
  return safari ? 'tutorial' : 'tutorial-safari';
}

// ───────── 登录页上的操作（按 K4 实际的登录页：src/features/auth/ui/AuthPage.tsx）─────────

/** 教程页：标题“先把它放到主屏幕”，第二步写着“添加到主屏幕” */
export const TUTORIAL = /添加到主屏幕/;

/** 邮箱框（label“邮箱”；验证码框的 label 是“邮箱里的 6 位验证码”，所以要精确匹配） */
export function emailBox(page: Page) {
  return page.getByRole('textbox', { name: '邮箱', exact: true });
}

/** 登录页上用到 Turnstile 的地方一律换成假的（不连 Cloudflare）；只有登录页的 CSP 放行这个地址 */
export async function fakeTurnstile(page: Page): Promise<void> {
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback && o.callback('XXXX.DUMMY.TOKEN.XXXX'), 0); return 'w'; }, reset() {}, remove() {} };`,
    }),
  );
}
