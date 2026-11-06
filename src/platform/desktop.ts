// exe 版的四个 platform 函数（B2 第一天派工表第 10 行、B6-exe 约定 4；签名在 ./native-bridge.ts）
// exe 启动时调一次 installDesktopBridge()，把 native-bridge 换成这里的实现；网页版打包不 import 本文件。
// • openAuth：调 Rust 的 auth_window_open 打开登录小窗口（主窗口不导航；代码审查 S8）；
// • openReminder：先让 Rust 把主窗口拉到前台（main_show，藏在托盘里的也显示），再像网页版一样改 hash；
// • requestAppUpdate：交 Rust 端（app_update，F7 接入点），结果折算成网页版同一套 SwUpdateResult，升级横幅文案不用改；
// • showLocalReminder / closeLocalReminder：用 main 页里 WebView2 自带的网页通知（Rust 只给 main 的本地页面放行通知权限）。
//   tauri 的通知插件在 Windows 上收不到点击，满足不了“点通知打开整页提醒”，所以不用它。
//   同一个 tag 再弹一次会替换旧的；点通知 → 拉到前台并打开这一条的整页提醒；按 tag 撤回。
// • desktopSessionStorage / onAuthDone：supabase-js 的会话存储接到 Rust 的 session_get / session_set / session_remove（F4，存凭据管理器，
//   不落 WebView2 的 localStorage）；登录小窗口写好会话后 Rust 给 main 发 auth:done，main 重新读会话（复核 N1）。接口说明见 desktopSessionStorage
// 不依赖 @tauri-apps/api（不改 package.json）：直接用 Tauri 2 一定注入的 window.__TAURI_INTERNALS__.invoke（R13）。
import type { SwUpdateResult } from './sw-register.ts';
import { buildInfo } from './env.ts';
import { reminderHash, setNativeBridge, type LocalReminder, type NativeBridge, type ReminderKind } from './native-bridge.ts';

/** Rust 端 updater::UpdateOutcome（desktop/src-tauri/src/updater.rs） */
export type UpdateOutcome = 'installing' | 'up_to_date' | 'error' | 'timeout' | 'not_configured';

/** Rust 的更新结果折算成网页版的 SwUpdateResult；认不出的一律当失败 */
export function toSwUpdateResult(o: unknown): SwUpdateResult {
  switch (o) {
    case 'installing':
      return 'reloading';
    case 'up_to_date':
      return 'no_update';
    case 'timeout':
      return 'takeover_timeout';
    default:
      // 'error'、'not_configured'（updater 还没接入）和意外的值
      return 'failed';
  }
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 网页通知里用到的部分（测试时传假的） */
export interface NotificationLike {
  onclick: ((this: unknown, ev: unknown) => unknown) | null;
  onclose: ((this: unknown, ev: unknown) => unknown) | null;
  close(): void;
}
export interface NotificationCtor {
  new (title: string, options: { body: string; tag: string }): NotificationLike;
  readonly permission: 'default' | 'granted' | 'denied';
  requestPermission(): Promise<'default' | 'granted' | 'denied'>;
}

export interface DesktopDeps {
  readonly invoke: Invoke;
  readonly location: () => { hash: string };
  readonly Notification: NotificationCtor | undefined;
}

function defaultDeps(): DesktopDeps {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  if (typeof invoke !== 'function') throw new Error('not_tauri');
  return {
    invoke: (cmd, args) => invoke(cmd, args),
    location: () => window.location,
    Notification: typeof Notification === 'function' ? (Notification as unknown as NotificationCtor) : undefined,
  };
}

/** exe 版实现 */
export function desktopBridge(deps: DesktopDeps = defaultDeps()): NativeBridge {
  /** 还在通知中心里的本机通知，按 tag 找（撤回、替换用） */
  const shown = new Map<string, NotificationLike>();
  /** closeAllLocalReminders 每调一次加 1：在它之前开始、还在等权限的 showLocalReminder 回来以后不再弹（X-5，退出后不冒出上一个账号的通知） */
  let epoch = 0;

  async function openReminder(kind: ReminderKind, id: string, dueAt: number): Promise<void> {
    try {
      await deps.invoke('main_show');
    } catch {
      // 拉不到前台也照样切到整页提醒（窗口本来就在前台时 main_show 失败不影响）
    }
    // exe 的主窗口固定是 /app/index.html，只改 hash，路由自己切页
    deps.location().hash = reminderHash(kind, id, dueAt);
  }

  return {
    openReminder,
    async openAuth() {
      // exe 的主窗口不许导航到 /app/auth/（policy.rs），改由 Rust 打开登录小窗口；打开失败照样抛给调用方
      await deps.invoke('auth_window_open');
    },
    async requestAppUpdate() {
      try {
        return toSwUpdateResult(await deps.invoke('app_update'));
      } catch {
        return 'failed';
      }
    },
    async showLocalReminder(r: LocalReminder) {
      const N = deps.Notification;
      if (!N) return;
      const at = epoch;
      // 新装、或清过 WebView2 数据时还没问过：exe 里 Rust 对 main 的本地页面自动放行，不会弹询问框（实测）
      if (N.permission === 'default' && (await N.requestPermission()) !== 'granted') return;
      if (N.permission === 'denied') return;
      if (at !== epoch) return;
      shown.get(r.tag)?.close();
      // data 里带 occurrenceKey（REMIND-close-occkey）：只比较、不显示
      const n = new N(r.title, { body: r.body, tag: r.tag, ...(r.occurrenceKey ? { data: { occurrence_key: r.occurrenceKey } } : {}) });
      shown.set(r.tag, n);
      n.onclick = () => {
        n.close();
        void openReminder(r.kind, r.id, r.dueAt);
      };
      n.onclose = () => {
        if (shown.get(r.tag) === n) shown.delete(r.tag);
      };
    },
    async closeLocalReminder(tag: string) {
      const n = shown.get(tag);
      if (!n) return;
      shown.delete(tag);
      n.close();
    },
    async closeAllLocalReminders() {
      // 退出、被移除、换账号时调（安全审查 X-5）：本 App 弹出的 WebView2 网页通知都记在 shown 里，逐个关掉。
      // 页面重新加载以后，旧页面弹的通知对象就拿不到了；Chromium 的非持久通知跟着文档关闭，WebView2 是否一样待真机验收核对
      epoch += 1;
      const all = [...shown.values()];
      shown.clear();
      for (const n of all) {
        try {
          n.close();
        } catch {
          // 某一条关不掉不影响别的
        }
      }
    },
  };
}

/** quick-add 交上来的文字最长多少字符（和 Rust 的 QUICK_ADD_MAX_CHARS 一致） */
export const QUICK_ADD_MAX_CHARS = 2000;

/**
 * Rust 转来的 quick-add:submit 事件 → 交给 cb 的纯文本（安全审查 X-S6）。
 * 只认 { text: string }，超长、类型不对的丢掉。拿到的文字只交给解析器，不当 HTML、不当 Markdown 渲染。
 */
export function quickAddText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const text = (payload as { text?: unknown }).text;
  if (typeof text !== 'string' || [...text].length > QUICK_ADD_MAX_CHARS) return null;
  return text;
}

export interface TauriInternalsEvents {
  invoke: Invoke;
  transformCallback: (cb: (ev: { payload: unknown }) => void, once?: boolean) => number;
}

function tauriEvents(): TauriInternalsEvents {
  const t = (globalThis as { __TAURI_INTERNALS__?: TauriInternalsEvents }).__TAURI_INTERNALS__;
  if (!t || typeof t.invoke !== 'function' || typeof t.transformCallback !== 'function') throw new Error('not_tauri');
  return t;
}

/** 订阅 Rust 发来的事件（main 的 capability 只给了 listen / unlisten）；返回取消订阅的函数 */
async function listenEvent(t: TauriInternalsEvents, event: string, cb: (payload: unknown) => void): Promise<() => void> {
  const handler = t.transformCallback((ev) => cb(ev.payload));
  const eventId = await t.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler });
  return () => {
    void t.invoke('plugin:event|unlisten', { event, eventId });
  };
}

/** main 页订阅快速记录框交上来的文字（页面接 quick-add 时用）；返回取消订阅的函数 */
export async function onQuickAddText(cb: (text: string) => void, t: TauriInternalsEvents = tauriEvents()): Promise<() => void> {
  return listenEvent(t, 'quick-add:submit', (payload) => {
    const text = quickAddText(payload);
    if (text !== null) cb(text);
  });
}

/**
 * 本 exe 允许存进凭据管理器的会话键：supabase-js 默认的 storageKey（sb-<接口主机名第一段>-auth-token）和它的 -user。
 * 和 Rust env.rs 的 session_keys 是同一份（正式 sb-lemomemo-…，预览 sb-preview-…；desktop-session.test.ts 直接读 env.rs 核对两边相等）。
 * 取法和 session.ts 的 sessionStorageKey 一样（同一个测试核对），这里不 import session.ts，免得 exe 的会话存储把 supabase 客户端一起拉进来。
 * 地址解析不出主机名时返回空名单——什么都存不进去，宁可登录不了也不乱写
 */
export function desktopSessionKeys(supabaseUrl: string = buildInfo.supabaseUrl): readonly string[] {
  try {
    const first = new URL(supabaseUrl).hostname.split('.')[0];
    return first ? [`sb-${first}-auth-token`, `sb-${first}-auth-token-user`] : [];
  } catch {
    return [];
  }
}

/** 每次 invoke 最多等这么久，超过按失败处理（审查 S2：Rust 一直不返回时，同一个键后面的读写不能永远排着） */
export const SESSION_INVOKE_TIMEOUT_MS = 10_000;

/**
 * exe 版 supabase-js 会话存储（F4；复核 N1；B6-exe 代码审查 M1、S2，安全审查 F5-1）。形状是 auth-js 的 SupportedStorage 异步写法，
 * 直接传给 createClient 的 auth.storage。只认 allowedKeys（就是 desktopSessionKeys，和 Rust 白名单同一份）：
 * • getItem(key)：名单外的键不调 Rust，直接 null；名单里的调 session_get。凭据管理器里没有、段坏了、本窗口不许读（auth 小窗口只许写）、
 *   出错、超时都按“没有”返回 null，不抛错——auth-js 当作没登录，走登录流程；
 * • removeItem(key)：名单外的键不调 Rust，直接算成功——本来就存不进去，也就没有要删的。auth-js 的 _removeSession 不管用不用 PKCE
 *   都会删 <key>-code-verifier、<key>-flows-code-verifier，以前这里抛 key_not_allowed，signOut 直接抛错、-user 留下、SIGNED_OUT 不发（M1）。
 *   名单里的键删失败照样抛给 auth-js；
 * • setItem(key, value)：名单外的键照样抛 key_not_allowed（不调 Rust）：写不进去要让 auth-js 知道。现在 flowType 是 implicit，不写 PKCE 键；
 *   以后改 PKCE 时 Rust 白名单和 desktopSessionKeys 要一起加，这里会马上报出来；
 * • peek(key)：同步读内存镜像。从没读到过返回 undefined（“不知道”），Rust 确实回了“没有”是 null，有值是字符串。
 *   读出错、超时时不改镜像（保持 undefined 或上一次读到的值，审查 S2）：凭据管理器偶尔出错时，同步读的一侧不会把“没读到”当成“没登录”；
 * • preload(keys)：把这些键从凭据管理器读进镜像（启动时在建 supabase 客户端之前调一次；onAuthDone 收到事件后对同一批键再调一次）；
 *   名单外的键忽略；
 * • 同一个键的读写按调用顺序排队（Rust 每个命令各自加锁，但两次 invoke 到达的先后不保证），镜像不会被慢回来的旧读覆盖。
 * 同步读的一侧（前端 A 的 readSessionUserId 这类要 Storage 的函数）用 sessionStorageView(本存储)，不要把本存储直接当 Storage 传。
 * 接线顺序（审查 S3）：createDesktopSessionStorage() → await preload(desktopSessionKeys()) → 建 supabase 客户端 → 同步读。
 * 本存储对象只放在模块作用域，不挂到 window / globalThis 上（安全审查建议 6）
 */
export interface DesktopSessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  peek(key: string): string | null | undefined;
  preload(keys: readonly string[]): Promise<void>;
  /** preload 过的键（onAuthDone 重读用） */
  readonly preloaded: readonly string[];
  /** 本存储认的键（和 Rust 白名单同一份） */
  readonly allowedKeys: readonly string[];
}

/** 读的三种结果：读到了（含 Rust 回的 null）、没读到（出错、超时） */
type ReadResult = { ok: true; value: string | null } | { ok: false };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('session_timeout')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export function desktopSessionStorage(
  invoke: Invoke,
  allowedKeys: readonly string[],
  opts: { timeoutMs?: number } = {},
): DesktopSessionStorage {
  const allowed = new Set(allowedKeys);
  const timeoutMs = opts.timeoutMs ?? SESSION_INVOKE_TIMEOUT_MS;
  const call = (cmd: string, args: Record<string, unknown>) => withTimeout(invoke(cmd, args), timeoutMs);
  const mirror = new Map<string, string | null>();
  const tails = new Map<string, Promise<unknown>>();
  const loaded = new Set<string>();
  /** 同一个键的操作串起来：前一个结束（成功或失败）才开始下一个 */
  function queue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  }
  async function read(key: string): Promise<ReadResult> {
    try {
      const r = await call('session_get', { key });
      const value = typeof r === 'string' ? r : null;
      mirror.set(key, value);
      return { ok: true, value };
    } catch {
      return { ok: false }; // 镜像不动（S2）
    }
  }
  return {
    async getItem(key) {
      if (!allowed.has(key)) return null;
      const r = await queue(key, () => read(key));
      return r.ok ? r.value : null;
    },
    setItem(key, value) {
      if (!allowed.has(key)) return Promise.reject('key_not_allowed');
      return queue(key, async () => {
        await call('session_set', { key, value });
        mirror.set(key, value);
      });
    },
    removeItem(key) {
      if (!allowed.has(key)) return Promise.resolve();
      return queue(key, async () => {
        await call('session_remove', { key });
        mirror.set(key, null);
      });
    },
    peek: (key) => mirror.get(key),
    async preload(keys) {
      const ks = keys.filter((k) => allowed.has(k));
      for (const k of ks) loaded.add(k);
      await Promise.all(ks.map((k) => queue(k, () => read(k))));
    },
    get preloaded() {
      return [...loaded];
    },
    allowedKeys: [...allowedKeys],
  };
}

/**
 * 给同步读取用的只读 Storage 形状（审查 S3）：readSessionUserId(view)、readSessionId(view) 这类函数要的是 Storage（会用 getItem、
 * length、key(i)）。内容就是 peek 的镜像里有值的键；镜像随本存储的读写实时变化。只读：setItem、removeItem、clear 一律抛错——
 * 写和删要走 desktopSessionStorage 的异步方法（让 Rust 真的写进、删掉凭据管理器）
 */
export function sessionStorageView(storage: DesktopSessionStorage): Storage {
  const present = () => storage.allowedKeys.filter((k) => typeof storage.peek(k) === 'string');
  const readOnly = () => {
    throw new Error('desktop_session_view_read_only');
  };
  return {
    get length() {
      return present().length;
    },
    key: (i: number) => present()[i] ?? null,
    getItem: (k: string) => {
      const v = storage.peek(k);
      return typeof v === 'string' ? v : null;
    },
    setItem: readOnly,
    removeItem: readOnly,
    clear: readOnly,
  };
}

/** 在 Tauri 里返回接好 invoke 的会话存储，不在 Tauri 里（网页版、测试）返回 undefined——clientOptions 照旧用 authStorage() */
export function createDesktopSessionStorage(allowedKeys: readonly string[] = desktopSessionKeys()): DesktopSessionStorage | undefined {
  try {
    return desktopSessionStorage(defaultDeps().invoke, allowedKeys);
  } catch {
    return undefined;
  }
}

/**
 * main 页订阅 auth:done（登录小窗口写好会话、Rust 关掉小窗口之前发的，无载荷）：先把 storage.preloaded 里的键重新读进镜像，
 * 再调 cb——cb 里由前端 A 让 supabase-js 重新读会话（例如 await db.auth.getSession()，auth-js 每次从 storage 读）并刷新界面。
 * 重读失败也照样调 cb（读不到就是没登录，界面留在登录提示）。返回取消订阅的函数
 */
export async function onAuthDone(
  storage: DesktopSessionStorage,
  cb: () => void | Promise<void>,
  t: TauriInternalsEvents = tauriEvents(),
): Promise<() => void> {
  return listenEvent(t, 'auth:done', () => {
    void storage
      .preload(storage.preloaded)
      .catch(() => undefined)
      .then(() => cb())
      .catch(() => undefined);
  });
}

/** exe 启动时调一次（在哪里调由前端 A 和协调员定，见回报）；不在 Tauri 里时什么也不做 */
export function installDesktopBridge(): boolean {
  let deps: DesktopDeps;
  try {
    deps = defaultDeps();
  } catch {
    return false;
  }
  setNativeBridge(desktopBridge(deps));
  return true;
}
