// 网页版和 exe 分开实现的五个 platform 函数（架构 5.3“exe”、0.49 第 8 条；B2 架构审 D4 第 2 点、B6-exe 约定 4；第一天派工表第 10 行）
// • openReminder(kind, id, dueAt)：打开某条的整页提醒（exe 的通知点击、App 内跳转都走它；SW 的 notificationclick 不能引 platform（A19），
//   用 shared/logic/remind-route.ts 的 reminderUrl——地址只写在那一份，架构 0.53）
// • requestAppUpdate()：426 横幅、“有新版本”的“更新”。网页版 = 拉新 SW、接管后重新载入（updateServiceWorker）；exe 交 Rust 端检查（F7）。
//   返回值和 updateServiceWorker 同一个 SwUpdateResult，core/upgrade.ts 的 swUpdate 依赖可以直接换成它
// • openAuth()：没登录、退出、被移除后去登录（session.ts 的 goToAuth 走它；exe 代码审查 S8）。网页版 location.replace('/app/auth/')；
//   exe 的主窗口不许导航到 /app/auth/（会停在空白页），exe 版调 Rust 的 auth_window_open 打开登录小窗口
// • showLocalReminder(reminder) / closeLocalReminder(tag) / closeAllLocalReminders()（退出时全关，安全审查 X-5）：exe 靠 App 内每分钟检查（逻辑在提醒功能里，按 notified_for 判断）弹本机通知、
//   Realtime 收到“已处理”后撤回。网页版空操作（网页靠 Web Push）
//   退出登录、被移除、换账号时，提醒调度（每分钟检查的计时器）也要停（B6-exe 代码审查 S9）：closeAllLocalReminders 的 epoch 只拦得住
//   退出前已经开始、还在等权限的那一次弹出；上一个账号的计时器要是还在跑，照样会调 showLocalReminder。提醒功能接调度时，计时器挂在
//   账号的生命周期上（退出时清掉），不要只靠这里。exe 退出后主窗口整页重新载入（session.ts 的 goToAuth，FA2-3），计时器随页面一起没了
// • openExternal(url)：用户亲手点了链接（R-301；B6-exe 安全审查 F5-5）。exe 里在点击处理里调 Rust 的 open_external 交给系统浏览器
//   （Rust 再校验一遍，只放行 http、https、mailto、tel），不靠 target=_blank、不靠页面跳转；返回 true = 已经交出去，调用方 preventDefault。
//   网页版返回 false，照浏览器默认走（http、https 新窗口，mailto、tel 顶层导航）
// exe 实现由前端 B 写在 src/platform/desktop.ts：启动时调 setNativeBridge({...}) 把五个函数换成 exe 版；这里不 import desktop.ts，
// 网页版打包里不带 Tauri 的代码。没装 bridge 时一律走网页版
import { reminderHash, reminderTag, reminderUrl, type ReminderKind } from '../../shared/logic/remind-route.ts';
import { buildInfo, isTauri } from './env.ts';
import { updateServiceWorkerLazy, type SwUpdateResult } from './sw-register.ts';

// 地址、hash、tag 的拼法只留一份（shared/logic/remind-route.ts，架构 0.53）；照旧从这里转出，desktop.ts 不用改
export { reminderHash, reminderTag, type ReminderKind };

/** exe 每分钟检查后要弹的一条本机通知 */
export interface LocalReminder {
  /** 通知的 tag：和 Web Push 同一个规则 "<kind>:<id>:<dueAt>"（reminderTag），撤回时按它找 */
  readonly tag: string;
  readonly kind: ReminderKind;
  readonly id: string;
  /** 这一次到点的时刻（epoch ms） */
  readonly dueAt: number;
  /** 这一次提醒的 occurrenceKey（shared/logic/remind-route.ts；REMIND-close-occkey）：放进通知的 data，只比较、不显示 */
  readonly occurrenceKey?: string;
  /** 通知标题、正文：提醒功能按界面语言和“锁屏只显示‘有 1 项日程’”设置生成好再传进来，platform 不碰语言包 */
  readonly title: string;
  readonly body: string;
}

/** 设置 › 提醒“发一条测试通知”在 exe 里的结果（R-330）：已弹出 / 系统通知权限没开 / 失败（含 exe 还没实现 showLocalTest） */
export type LocalTestResult = 'shown' | 'denied' | 'failed';

/** exe 一侧要实现的五个函数（前端 B，src/platform/desktop.ts） */
export interface NativeBridge {
  openReminder(kind: ReminderKind, id: string, dueAt: number): Promise<void>;
  /** 去登录：网页版整页跳 /app/auth/；exe 版打开登录小窗口（auth_window_open），主窗口不导航 */
  openAuth(): Promise<void>;
  requestAppUpdate(): Promise<SwUpdateResult>;
  showLocalReminder(reminder: LocalReminder): Promise<void>;
  closeLocalReminder(tag: string): Promise<void>;
  /** 退出、被移除、换账号时关掉本 App 已弹出的全部本机通知（安全审查 X-5；网页版空操作，网页的通知由 disconnectBrowserPush 关） */
  closeAllLocalReminders(): Promise<void>;
  /** 用户点了链接：交给系统浏览器（exe 的 open_external）。不实现时 openExternal 在 exe 里直接 invoke open_external */
  openExternal?(url: string): Promise<void>;
  /**
   * 待接口（B2 FA-4 加，R-330；exe 实现归 B6-exe，写在 desktop.ts）：设置 › 提醒“发一条测试通知”在 exe 里弹一条本机测试通知。
   * 约定：和 showLocalReminder 同一路（WebView2 网页通知）；tag 固定 'lemo-local-test'（再点替换旧的，不和提醒的 tag 撞）；
   * 权限 default 时在这次点按里请求，拒了或 denied 回 'denied'；弹出回 'shown'；其余回 'failed'。点通知只把主窗口拉到前台，不打开整页提醒。
   * 网页版不实现（网页走 push-test）；exe 没实现时 showLocalTestNotification 回 'failed'
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
    // “更新”的代码按需下载（sw-register.ts 的 updateServiceWorkerLazy，11-07 首屏瘦身）：下载失败、超时回 failed（没查成）
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

/** 弹一条本机测试通知（只有 exe；R-330）。bridge 没实现 showLocalTest、或抛错时回 'failed' */
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

/** 关掉已弹出的全部本机通知（只有 exe 做事；退出流程经 platform/push.ts 的 disconnectBrowserPush 调它，X-5） */
export function closeAllLocalReminders(): Promise<void> {
  return current().closeAllLocalReminders();
}

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * 本站的页面（隐私说明、条款这类相对地址，如 /zh/privacy）在 exe 里的绝对地址：取数据接口地址（buildInfo.supabaseUrl，正式 https://lemomemo.com/sb）
 * 的来源拼上 path。exe 的页面来源是本地的（tauri.localhost），相对地址对系统浏览器没用。只认 https；拼不出来返回 null。
 * 两道关防拼出别的主机（URL 解析会把 \ 当 /、丢掉制表符和换行，/\evil.com 会变成 https://evil.com/）：
 * path 只许 / 开头的字母、数字、/、_、-（不许 //），拼好后来源必须和数据接口地址的来源一致
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
 * 用户亲手点了本站的页面链接（ConsentPage 的隐私说明、条款）：exe 里换成绝对地址交给系统浏览器、返回 true（调用方 preventDefault）——
 * exe 的新窗口只放 https，相对地址加 target=_blank 打不开；拼不出地址时也返回 true（不打开，也不在 exe 里跳走、丢掉当前页面）。
 * 网页版返回 false，照原来新窗口打开
 */
export function openSitePage(path: string, win: object = globalThis, supabaseUrl?: string): boolean {
  if (!isTauri(win)) return false;
  const url = sitePageUrl(path, supabaseUrl);
  if (url !== null) openExternal(url, win);
  return true;
}

/**
 * 用户亲手点了一个已经过 safeHref 的链接（R-301）：exe 里交给系统浏览器、返回 true（调用方 preventDefault）；网页版返回 false（照默认走）。
 * 只在点击处理里调；不抛错，交不出去（invoke 不在、Rust 拒了）也返回 true——exe 里宁可不打开，也不退回页面内导航
 */
export function openExternal(url: string, win: object = globalThis): boolean {
  const b = bridge;
  if (b?.openExternal) {
    void b.openExternal(url).catch(() => undefined);
    return true;
  }
  if (!isTauri(win)) return false;
  const invoke = (win as { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } }).__TAURI_INTERNALS__?.invoke;
  if (typeof invoke === 'function') {
    try {
      void Promise.resolve(invoke('open_external', { url })).catch(() => undefined);
    } catch {
      // 同步抛：不打开
    }
  }
  return true;
}

