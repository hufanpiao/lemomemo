// 构建信息（架构 8.1、8.5；0.31 第 3 条从 app/build-info.ts 挪来）：取代 v3 的 App.BUILD
// 版本号来自 VERSION 文件（vite define 注入）；其余只读 VITE_PUBLIC_ 开头的变量（A14）

export type AppEnv = 'production' | 'preview' | 'development' | 'test';

function envOf(v: string | undefined, mode: string): AppEnv {
  const x = v ?? mode;
  return x === 'production' || x === 'preview' || x === 'test' ? x : 'development';
}

export const buildInfo = {
  version: __APP_VERSION__,
  builtAt: __BUILD_TIME__,
  env: envOf(import.meta.env.VITE_PUBLIC_ENV, import.meta.env.MODE),
  /** 数据接口经自有域名转发：正式 https://lemomemo.com/sb，预览 https://preview.lemomemo.com/sb */
  supabaseUrl: import.meta.env.VITE_PUBLIC_SUPABASE_URL ?? '',
  anonKey: import.meta.env.VITE_PUBLIC_ANON_KEY ?? '',
  vapidKey: import.meta.env.VITE_PUBLIC_VAPID_KEY ?? '',
  turnstileSiteKey: import.meta.env.VITE_PUBLIC_TURNSTILE_SITE_KEY ?? '',
} as const;

/** 开发和验证用的页面（例如 CSP 试验页）只在非正式版里挂 */
export const isProduction = buildInfo.env === 'production';

// ───────── 设备判断（架构 5.9“首次引导”、TC-B1-17；R-225 起 iPhone / iPad 上不分浏览器）─────────

/** 判断要用到的 navigator 字段（测试时传假的进来） */
export interface NavLike {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** iOS Safari 专有：从主屏幕图标打开时为 true */
  readonly standalone?: boolean | undefined;
}

/** iOS 上别家浏览器、App 内置浏览器的 UA 标记（它们都不是 Safari） */
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|GSA\/|DuckDuckGo|KAKAOTALK|NAVER|Line\/|FBAN|FBAV|Instagram|MicroMessenger|DaumApps|Whale\//;

/**
 * iPhone、iPad、iPod 上的任何浏览器（Safari、Chrome、App 内置浏览器……）。
 * iPadOS 默认伪装成 Mac：UA 里是 Macintosh，要再看 maxTouchPoints > 1（Mac 没有触屏，是 0）。
 * 电脑（Windows、Mac）和安卓一律 false（第七轮：电脑浏览器照常登录）。
 */
export function isAppleMobile(nav: NavLike = navigator): boolean {
  const ua = nav.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
}

/**
 * iOS / iPadOS 的 Safari 本身（不管是不是主屏幕版）。只有它能“添加到主屏幕”；
 * 别家浏览器和 App 内置浏览器（UA 里带 CriOS、KAKAOTALK、MicroMessenger 等，或者没有 Version/…Safari/）都不算。
 */
export function isIOSSafari(nav: NavLike = navigator): boolean {
  if (!isAppleMobile(nav)) return false;
  const ua = nav.userAgent;
  return /Safari\//.test(ua) && /Version\//.test(ua) && !NOT_SAFARI.test(ua);
}

/** 是不是从主屏幕图标打开的（iOS 看 navigator.standalone，其他按 display-mode 媒体查询） */
export function isStandalone(
  nav: NavLike = navigator,
  media: (q: string) => boolean = (q) => typeof matchMedia === 'function' && matchMedia(q).matches,
): boolean {
  if (nav.standalone === true) return true;
  return media('(display-mode: standalone)') || media('(display-mode: fullscreen)');
}

/**
 * 登录页要不要拦下来、只教“添加到主屏幕”（R-225）：iPhone、iPad 上凡是不在主屏幕模式运行的一律拦，
 * 包括 iOS 上的 Chrome、KakaoTalk、微信等 App 内置浏览器（它们的存储和主屏幕版都是隔开的，在里面登录了主屏幕版还得再登一次）。
 * 电脑浏览器、安卓照常登录。
 */
export function mustInstallFirst(
  nav: NavLike = navigator,
  media?: (q: string) => boolean,
): boolean {
  return isAppleMobile(nav) && !isStandalone(nav, media);
}

/**
 * 登录页显示什么（R-225）：
 * - login：照常登录
 * - install：只给“添加到主屏幕”教程（当前就是 Safari）
 * - install-safari：教程之外多一句“请在 Safari 里打开本页”（只有 Safari 能添加到主屏幕）
 */
export type InstallGate = 'login' | 'install' | 'install-safari';
export function installGate(nav: NavLike = navigator, media?: (q: string) => boolean): InstallGate {
  if (!mustInstallFirst(nav, media)) return 'login';
  return isIOSSafari(nav) ? 'install' : 'install-safari';
}
