// 网页版和 exe 分开实现的 platform 函数
// • openReminder：打开某条的整页提醒；地址只在 shared/logic/remind-route.ts 拼一份（SW 不能引 platform，也用它）
// • requestAppUpdate：网页版拉新 SW、接管后重新载入；exe 交 Rust 端检查。返回值同 updateServiceWorker 的 SwUpdateResult
// • openAuth：网页版 location.replace('/app/auth/')；exe 主窗口不许导航到 /app/auth/（会停在空白页），改开登录小窗口
// • showLocalReminder / closeLocalReminder / closeAllLocalReminders：exe 靠 App 内每分钟检查弹本机通知；网页版空操作（靠 Web Push）。
//   closeAllLocalReminders 只拦得住退出前已开始的那次弹出：提醒调度的计时器必须挂在账号生命周期上、退出时清掉，不能只靠这里
// • openExternal：用户亲手点了链接，exe 在点击处理里交给 Rust 的 open_external（Rust 再校验，只放行 http、https、mailto、tel），
//   不靠 target=_blank、不靠页面跳转；返回 true 时调用方 preventDefault。网页版返回 false，照浏览器默认走
// exe 实现在 desktop.ts，启动时 setNativeBridge 换掉；这里不 import desktop.ts，网页版打包不带 Tauri 代码。没装 bridge 时走网页版
import { reminderHash, reminderTag, reminderUrl, type ReminderKind } from '../../shared/logic/remind-route.ts';
import { tauriInvoke } from './desktop-invoke.ts';
import { buildInfo, isTauri } from './env.ts';
import { updateServiceWorkerLazy, type SwUpdateResult } from './sw-register.ts';

// 拼法在 shared/logic/remind-route.ts，这里转出给 desktop.ts
export { reminderHash, reminderTag, type ReminderKind };

/** exe 每分钟检查后要弹的一条本机通知 */
export interface LocalReminder {
  /** 通知的 tag：和 Web Push 同一个规则 "<kind>:<id>:<dueAt>"（reminderTag），撤回时按它找 */
  readonly tag: string;
  readonly kind: ReminderKind;
  readonly id: string;
  /** 这一次到点的时刻（epoch ms） */
  readonly dueAt: number;
  /** 这一次提醒的 occurrenceKey：放进通知的 data，只比较、不显示 */
  readonly occurrenceKey?: string;
  /** 通知标题、正文：提醒功能生成好再传进来，platform 不碰语言包 */
  readonly title: string;
  readonly body: string;
}

/** exe 里“发一条测试通知”的结果：已弹出 / 权限没开 / 失败（含没实现 showLocalTest） */
export type LocalTestResult = 'shown' | 'denied' | 'failed';

/** exe 一侧要实现的函数（desktop.ts） */
export interface NativeBridge {
  openReminder(kind: ReminderKind, id: string, dueAt: number): Promise<void>;
  /** 去登录：网页版整页跳 /app/auth/；exe 版打开登录小窗口（auth_window_open），主窗口不导航 */
  openAuth(): Promise<void>;
  requestAppUpdate(): Promise<SwUpdateResult>;
  showLocalReminder(reminder: LocalReminder): Promise<void>;
  closeLocalReminder(tag: string): Promise<void>;
  /** 退出、被移除、换账号时关掉已弹出的全部本机通知（网页版空操作，网页的由 disconnectBrowserPush 关） */
  closeAllLocalReminders(): Promise<void>;
  /** 用户点了链接：交给系统浏览器。不实现时 openExternal 在 exe 里直接 invoke open_external */
  openExternal?(url: string): Promise<void>;
  /**
   * exe 里弹一条本机测试通知（desktop.ts 实现）：和 showLocalReminder 同一路；tag 固定 'lemo-local-test'（不和提醒的 tag 撞）；
   * 权限 default 时在这次点按里请求，拒了回 'denied'，弹出回 'shown'，其余 'failed'。点通知只把主窗口拉到前台。
   * 网页版不实现（走 push-test）
   */
  showLocalTest?(n: { readonly title: string; readonly body: string }): Promise<LocalTestResult>;
}

/** 整页提醒的完整路径（= shared 的 reminderUrl，和 SW 打开的同一个） */
export const reminderPath = reminderUrl;

/** 登录页（单独的入口，src/auth/main.tsx） */
export const AUTH_PATH = '/app/auth/';

/** 网页版用到的 location 部分（测试时传假的） */
export interface LocationLike {
  readonly pathname: string;
  hash: string;
  assign(url: string): void;
  replace(url: string): void;
}

/** 网页版实现 */
export function webBridge(deps: { location?: () => LocationLike; update?: () => Promise<SwUpdateResult> } = {}): NativeBridge {
  const loc = deps.location ?? (() => window.location);
  return {
    async openReminder(kind, id, dueAt) {
      const l = loc();
      // 已经在 /app/ 里：只改 hash，路由收到 hashchange 自己切页（不重新载入，不丢正在编辑的内容）
      if (l.pathname === '/app/' || l.pathname === '/app/index.html') l.hash = reminderHash(kind, id, dueAt);
      else l.assign(reminderPath(kind, id, dueAt));
    },
    async openAuth() {
      // replace：登录页“返回”不回到已退出的主 App
      loc().replace(AUTH_PATH);
    },
    // “更新”的代码按需下载：下载失败、超时回 failed
    requestAppUpdate: deps.update ?? (() => updateServiceWorkerLazy()),
    async showLocalReminder() {
      // 网页靠 Web Push（SW 显示通知），这里不做事
    },
    async closeLocalReminder() {
      // 同上：网页的通知由 SW 按 tag 替换、关闭
    },
    async closeAllLocalReminders() {
      // 网页没有本机通知：SW 显示的那些由 platform/push.ts 的 disconnectBrowserPush 用 getNotifications 关
    },
  };
}

let bridge: NativeBridge | null = null;
let web: NativeBridge | null = null;
const current = (): NativeBridge => bridge ?? (web ??= webBridge());

/** exe 启动时由 desktop.ts 调一次，换成 exe 版；网页版从不调用 */
export function setNativeBridge(b: NativeBridge): void {
  bridge = b;
}

/** 测试用：回到网页版 */
export function resetNativeBridgeForTest(): void {
  bridge = null;
  web = null;
}

/** 打开某条的整页提醒 */
export function openReminder(kind: ReminderKind, id: string, dueAt: number): Promise<void> {
  return current().openReminder(kind, id, dueAt);
}

/** 去登录：网页版跳 /app/auth/，exe 打开登录小窗口。session.ts 的 goToAuth 记下退出原因后调它 */
export function openAuth(): Promise<void> {
  return current().openAuth();
}

/** “更新”按钮：网页版拉新 SW 后重新载入，exe 交 Rust 端 */
export function requestAppUpdate(): Promise<SwUpdateResult> {
  return current().requestAppUpdate();
}

/** 弹一条本机通知（只有 exe 做事） */
export function showLocalReminder(reminder: LocalReminder): Promise<void> {
  return current().showLocalReminder(reminder);
}

/** 撤回本机通知（只有 exe 做事） */
export function closeLocalReminder(tag: string): Promise<void> {
  return current().closeLocalReminder(tag);
}

/** 弹一条本机测试通知（只有 exe）。没实现或抛错回 'failed' */
export async function showLocalTestNotification(n: { readonly title: string; readonly body: string }): Promise<LocalTestResult> {
  const b = current();
  if (typeof b.showLocalTest !== 'function') return 'failed';
  try {
    const r = await b.showLocalTest(n);
    return r === 'shown' || r === 'denied' ? r : 'failed';
  } catch {
    return 'failed';
  }
}

/** 关掉已弹出的全部本机通知（只有 exe 做事；退出流程经 push.ts 的 disconnectBrowserPush 调它） */
export function closeAllLocalReminders(): Promise<void> {
  return current().closeAllLocalReminders();
}

/**
 * 本站相对地址（如 /zh/privacy）在 exe 里的绝对地址：数据接口地址的来源拼上 path（exe 页面来源是 tauri.localhost，相对地址对系统浏览器没用）。
 * 只认 https；拼不出返回 null。防拼出别的主机（URL 解析会把 \ 当 /，/\evil.com 变成 https://evil.com/）：
 * path 只许 / 开头的字母、数字、/、_、-（不许 //），拼好后来源必须和数据接口地址一致
 */
const SITE_PATH = /^\/[A-Za-z0-9/_-]*$/;

export function sitePageUrl(path: string, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  if (!SITE_PATH.test(path) || path.startsWith('//')) return null;
  try {
    const base = new URL(supabaseUrl);
    if (base.protocol !== 'https:') return null;
    const url = new URL(path, base.origin);
    return url.origin === base.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 用户亲手点了本站页面链接：exe 里换成绝对地址交给系统浏览器、返回 true（调用方 preventDefault；相对地址加 target=_blank 在 exe 打不开）。
 * 拼不出地址也返回 true（不在 exe 里跳走丢掉当前页面）。网页版返回 false，照原来新窗口打开
 */
export function openSitePage(path: string, win: object = globalThis, supabaseUrl?: string): boolean {
  if (!isTauri(win)) return false;
  const url = sitePageUrl(path, supabaseUrl);
  if (url !== null) openExternal(url, win);
  return true;
}

/**
 * 用户亲手点了已过 safeHref 的链接：exe 里交给系统浏览器、返回 true；网页版返回 false（照默认走）。
 * 只在点击处理里调；不抛错，交不出去也返回 true：exe 里宁可不打开，也不退回页面内导航
 */
export function openExternal(url: string, win: object = globalThis): boolean {
  const b = bridge;
  if (b?.openExternal) {
    void b.openExternal(url).catch(() => undefined);
    return true;
  }
  if (!isTauri(win)) return false;
  const invoke = tauriInvoke(win);
  if (invoke) {
    try {
      void Promise.resolve(invoke('open_external', { url })).catch(() => undefined);
    } catch {
      // 同步抛：不打开
    }
  }
  return true;
}

