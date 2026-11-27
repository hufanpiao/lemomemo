// exe 版的 platform 函数（签名在 ./native-bridge.ts），启动时 installDesktopBridge() 装上；网页版打包不 import 本文件。
// • 本机提醒用 WebView2 自带的网页通知，不用 tauri 通知插件：它在 Windows 上收不到点击
// • 会话存进凭据管理器，不落 WebView2 的 localStorage
// 调 Rust 命令、订阅事件都经 ./desktop-invoke.ts（不依赖 @tauri-apps/api）。
import type { SwUpdateResult } from './sw-register.ts';
import { tauriEvents, tauriInvoke, tauriWindowLabel, type JsonInvoke, type TauriInternalsEvents } from './desktop-invoke.ts';
import { QUICK_ADD_MAX_CHARS } from './desktop-quick-add.ts';
import { buildInfo } from './env.ts';
import { withTimeout } from './exit-basics.ts';
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

export type { TauriInternalsEvents };

/** 网页通知里用到的部分 */
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
  readonly invoke: JsonInvoke;
  /** 打开整页提醒：走路由把原页压进返回栈，关掉时退一步回原页 */
  readonly go: (hash: string) => unknown;
  readonly Notification: NotificationCtor | undefined;
}

function defaultDeps(go: (hash: string) => unknown = (h) => (window.location.hash = h)): DesktopDeps {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('not_tauri');
  return {
    invoke,
    go,
    Notification: typeof Notification === 'function' ? (Notification as unknown as NotificationCtor) : undefined,
  };
}

export function desktopBridge(deps: DesktopDeps = defaultDeps()): NativeBridge {
  /** 还在通知中心里的本机通知，按 tag 找 */
  const shown = new Map<string, NotificationLike>();
  /** closeAllLocalReminders 每次加 1：之前还在等权限的 showLocalReminder 回来后不再弹 */
  let epoch = 0;

  async function openReminder(kind: ReminderKind, id: string, dueAt: number): Promise<void> {
    try {
      await deps.invoke('main_show');
    } catch {
      // 拉不到前台也照样切到整页提醒
    }
    // 走路由换 hash，不直接改 location.hash：那样返回栈会丢
    deps.go(reminderHash(kind, id, dueAt));
  }

  return {
    openReminder,
    async openAuth() {
      // 主窗口不许导航到 /app/auth/（policy.rs），改由 Rust 开登录小窗口；失败照样抛
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
      // 还没问过权限时：Rust 对 main 的本地页面自动放行，不会弹询问框
      if (N.permission === 'default' && (await N.requestPermission()) !== 'granted') return;
      if (N.permission === 'denied') return;
      if (at !== epoch) return;
      shown.get(r.tag)?.close();
      // data 里带 occurrenceKey：只比较、不显示
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
      // 页面重新加载后旧页面的通知对象拿不到（WebView2 是否跟着文档关闭待真机核对）
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

/**
 * quick_add_take 取回的一项：只认不超长的字符串。只交给解析器，不当 HTML、Markdown 渲染。
 */
export function quickAddText(item: unknown): string | null {
  if (typeof item !== 'string' || [...item].length > QUICK_ADD_MAX_CHARS) return null;
  return item;
}

/** 订阅 Rust 事件（main 的 capability 只给了 listen / unlisten）；返回取消订阅的函数 */
async function listenEvent(t: TauriInternalsEvents, event: string, cb: (payload: unknown) => void): Promise<() => void> {
  const handler = t.transformCallback((ev) => cb(ev.payload));
  const eventId = await t.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler });
  return () => {
    void t.invoke('plugin:event|unlisten', { event, eventId });
  };
}

/**
 * main 页接快速记录框的文字：句子排在 Rust 队列（quick_add.rs），收到 quick-add:pending 一次取走全部；订阅好先取一次，接上没在听时交的。
 * userId 换了 Rust 先清队列（不把上一个账号的字记进来）。取失败的留在队列里。返回取消订阅的函数
 */
export async function onQuickAddText(cb: (text: string) => void, userId: string, t: TauriInternalsEvents = tauriEvents()): Promise<() => void> {
  const take = async (): Promise<void> => {
    let items: unknown;
    try {
      items = await t.invoke('quick_add_take', { userId });
    } catch {
      return;
    }
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const text = quickAddText(item);
      if (text === null) continue;
      try {
        cb(text);
      } catch {
        // 一句处理出错不影响同一批后面的
      }
    }
  };
  const off = await listenEvent(t, 'quick-add:pending', () => void take());
  await take();
  return off;
}

/**
 * 允许存进凭据管理器的会话键，和 Rust env.rs 的 session_keys 同一份（测试核对）。不 import session.ts，免得把 supabase 客户端拉进来。
 * 解析不出主机名返回空名单：宁可登录不了也不乱写
 */
export function desktopSessionKeys(supabaseUrl: string = buildInfo.supabaseUrl): readonly string[] {
  try {
    const first = new URL(supabaseUrl).hostname.split('.')[0];
    return first ? [`sb-${first}-auth-token`, `sb-${first}-auth-token-user`] : [];
  } catch {
    return [];
  }
}

/** 每次 invoke 最多等这么久，超过按失败处理：Rust 一直不返回时，同一个键后面的读写不能永远排着 */
export const SESSION_INVOKE_TIMEOUT_MS = 10_000;

/**
 * exe 版 supabase-js 会话存储（传给 createClient 的 auth.storage），只认 allowedKeys：
 * • getItem：读不到一律 null 不抛错（auth-js 当没登录）；readsOwnWrites 时读失败返回本页刚写的值
 * • removeItem：名单外直接算成功（auth-js 总会删 code-verifier 键，抛错会让 signOut 失败）
 * • setItem：名单外抛 key_not_allowed。将来改 PKCE 时 Rust 白名单和 desktopSessionKeys 要一起加
 * • peek：同步读镜像（没读到过 undefined，确实没有 null）；读出错不改镜像，免得把“没读到”当成“没登录”
 * • 同一个键的读写按调用顺序排队（invoke 到达先后不保证）
 * 接线顺序：createDesktopSessionStorage() → await preload(desktopSessionKeys()) → 建 supabase 客户端 → 同步读（用 sessionStorageView）。
 * 本存储对象只放在模块作用域，不挂到 window / globalThis 上
 */
export interface DesktopSessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  peek(key: string): string | null | undefined;
  preload(keys: readonly string[]): Promise<void>;
  readonly preloaded: readonly string[];
  readonly allowedKeys: readonly string[];
}

/** 读到了（含 Rust 回的 null）、没读到（出错、超时） */
type ReadResult = { ok: true; value: string | null } | { ok: false };


export function desktopSessionStorage(
  invoke: JsonInvoke,
  allowedKeys: readonly string[],
  opts: { timeoutMs?: number; readsOwnWrites?: boolean } = {},
): DesktopSessionStorage {
  const allowed = new Set(allowedKeys);
  const readsOwnWrites = opts.readsOwnWrites === true;
  const timeoutMs = opts.timeoutMs ?? SESSION_INVOKE_TIMEOUT_MS;
  // 超时抛 session_timeout，invoke 的错原样抛（withTimeout 给退路值不抛，这里包一层再拆）
  const call = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    const r = await withTimeout(
      () => invoke(cmd, args).then((value) => ({ value }), (error: unknown) => ({ error })),
      timeoutMs,
      (): { error: unknown } => ({ error: new Error('session_timeout') }),
    );
    if ('error' in r) throw r.error;
    return r.value;
  };
  const mirror = new Map<string, string | null>();
  /**
   * 只在 readsOwnWrites 时用：登录小窗口没有 session_get。主窗口不用：凭据管理器出错时不拿本页内存冒充“已登录”
   */
  const written = new Map<string, string>();
  const tails = new Map<string, Promise<unknown>>();
  const loaded = new Set<string>();
  /** 同一个键的操作串起来 */
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
      return { ok: false }; // 镜像不动
    }
  }
  return {
    async getItem(key) {
      if (!allowed.has(key)) return null;
      const r = await queue(key, () => read(key));
      if (r.ok) return r.value;
      return readsOwnWrites ? (written.get(key) ?? null) : null;
    },
    setItem(key, value) {
      if (!allowed.has(key)) return Promise.reject('key_not_allowed');
      return queue(key, async () => {
        await call('session_set', { key, value });
        mirror.set(key, value);
        if (readsOwnWrites) written.set(key, value);
      });
    },
    removeItem(key) {
      if (!allowed.has(key)) return Promise.resolve();
      return queue(key, async () => {
        await call('session_remove', { key });
        mirror.set(key, null);
        written.delete(key);
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
 * 给同步读取用的只读 Storage（内容是 peek 镜像）。写和删一律抛错：要走异步方法，让 Rust 真的改凭据管理器
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

/**
 * 不在 Tauri 里返回 undefined（照旧用 authStorage()）。只有登录小窗口（label 是 auth）读得回本页刚写的值
 */
export function createDesktopSessionStorage(allowedKeys: readonly string[] = desktopSessionKeys()): DesktopSessionStorage | undefined {
  const invoke = tauriInvoke();
  return invoke ? desktopSessionStorage(invoke, allowedKeys, { readsOwnWrites: tauriWindowLabel() === 'auth' }) : undefined;
}

/**
 * main 页订阅 auth:done：先重读 storage.preloaded 进镜像，再调 cb（重读失败也照样调）。返回取消订阅的函数
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

/**
 * exe 启动时调一次。go：路由的 goHref，platform 不许引用 app，所以由调用方注入；不传时直接改 hash
 */
export function installDesktopBridge(go?: (hash: string) => unknown): boolean {
  let deps: DesktopDeps;
  try {
    deps = defaultDeps(go);
  } catch {
    return false;
  }
  setNativeBridge(desktopBridge(deps));
  return true;
}
