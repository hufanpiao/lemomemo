// 登录页要不要拦下来、只教“添加到主屏幕”（架构 5.9“首次引导”、TC-B1-17、R-225）：只有登录页（features/auth 的 AuthPage）用。
// 从 env.ts 挪出来（11-12 首屏瘦身）：env.ts 主 App 和登录页共用，放在那里会跟着进主 App 的首屏块；iPhone / iPad 判断、主屏幕版判断照旧在 env.ts
import { isAppleMobile, isStandalone, type NavLike } from './env.ts';

/** iOS 上别家浏览器、App 内置浏览器的 UA 标记（它们都不是 Safari） */
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|GSA\/|DuckDuckGo|KAKAOTALK|NAVER|Line\/|FBAN|FBAV|Instagram|MicroMessenger|DaumApps|Whale\//;

/**
 * iOS / iPadOS 的 Safari 本身（不管是不是主屏幕版）。只有它能“添加到主屏幕”；
 * 别家浏览器和 App 内置浏览器（UA 里带 CriOS、KAKAOTALK、MicroMessenger 等，或者没有 Version/…Safari/）都不算。
 */
export function isIOSSafari(nav: NavLike = navigator): boolean {
  if (!isAppleMobile(nav)) return false;
  const ua = nav.userAgent;
  return /Safari\//.test(ua) && /Version\//.test(ua) && !NOT_SAFARI.test(ua);
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
