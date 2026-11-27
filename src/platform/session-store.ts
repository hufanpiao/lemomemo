// 本机会话存在哪：网页版是 localStorage；exe 是 Rust 的凭据管理器（desktop.ts），会话不落 WebView2 的 localStorage。
// • session.ts 的同步读、同步删都经 sessionStore()：exe 里删时先在本页记“删除中”（同步读马上读不到）、同时调 Rust 真删，
//   回来再撤记号；删失败时会话照旧读得到（没删掉就不假装删掉）
// • supabase-js 的 auth.storage 在 exe 里用 authBackendStorage()：直通凭据管理器，删键前问 removalAllowed，并记“删除中”
// • installDesktopSession() 必须在建 supabase 客户端、第一次同步读会话之前 await 完；它动态 import desktop.ts，网页版不带 Tauri 代码
// • 后端对象只放在本模块作用域，不挂到 window / globalThis；不导出 peek
// • 删不掉：exe 主窗口每一轮显式退出的删除开始前，在 localStorage 记“待删除”标记（DROP_MARK_KEY，只是 "1"，不含令牌、session_id），
//   都成功才撤。supabase-js 自己删键不写标记，成败只记在本页状态里；登录小窗口一律不写（enableDropMark 只有主窗口入口调），
//   否则小窗口删失败又登录成功后，主窗口重新载入会把刚登录的会话当“待删除”删掉。
//   有失败：标记留着、状态 failed，goToAuth 改显示“退出没完成，点重试”；下次启动有标记先删会话，删不掉不画账号界面
// • 本页内存状态和标记分开记，两个已知边角：
//   ① supabase-js 删键失败后若没有新的显式删除，lastRoundFailed 停在旧失败上，可能误显示“退出没完成”，点重试即恢复；
//      自己退出一般碰不到：sign-out.ts 会兜底调 clearLocalSessionIf(sid) 再删一轮。sid 为 null 时它照删三个不存在的键，
//      Rust 删不存在的凭据按成功处理，标记会撤掉
//   ② 内存状态随进程消失；跨重启靠标记，没有标记的残留会话在下次刷新令牌失败时走“被移除”流程删掉
// • 关着失败：exe 里没装上时同步读一律读不到、supabase-js 用本页内存，宁可登录不上也不退回 localStorage
import { createSignal } from '../../shared/core/signal.ts';
import type * as Desktop from './desktop.ts';
import { isTauri } from './env.ts';
import { withTimeout } from './exit-basics.ts';
import { removalAllowed } from './supabase/auth-storage.ts';

/** desktop.ts 存储里本文件用到的部分（不 import 它的类型，免得网页版依赖图里出现它） */
export interface SessionBackendStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface Backend {
  store: SessionBackendStore;
  view: Storage;
}

let backend: Backend | null = null;
/** collectRemovals 收集中：这一段同步代码里发出的删除 */
let collecting: Promise<void>[] | null = null;
/** 正在删的键 → 还没回来的删除次数 */
const removing = new Map<string, number>();
const pending = new Set<Promise<void>>();

/** “待删除”标记（见文件头）：只是一个记号，不含令牌、不含 session_id */
export const DROP_MARK_KEY = 'lemo.session-drop-pending';
/** 这一轮删除里有没有失败的 */
let roundFailed = false;
/** 上一轮删除失败了（标记还留着） */
let lastRoundFailed = false;
const dropListeners = createSignal();
/** 显式退出里还没回来的删除（标记的一轮）、其中有没有失败的 */
const dropping = new Set<Promise<void>>();
let dropFailed = false;
/** 这个窗口记不记“待删除”标记：只有主窗口入口打开 */
let markEnabled = false;

/** 主窗口入口在 installDesktopSession 之后调：之后显式退出的删除才记标记、算轮次（见文件头） */
export function enableDropMark(): void {
  markEnabled = true;
}

function writeMark(on: boolean): void {
  try {
    if (on) globalThis.localStorage.setItem(DROP_MARK_KEY, '1');
    else globalThis.localStorage.removeItem(DROP_MARK_KEY);
  } catch {
    // 存不了：下次启动就没有这一层兜底，本次的状态照旧
  }
}

/**
 * localStorage 里有没有“待删除”标记；不可用时返回 false（那时也写不进标记）。
 * 本次运行里删失败照样靠 lastRoundFailed 报 failed，不会因读不到标记就当成删干净
 */
export function hasDropMark(): boolean {
  try {
    return globalThis.localStorage.getItem(DROP_MARK_KEY) !== null;
  } catch {
    return false;
  }
}

/** 撤掉标记、状态回到 ok（没有键要删时不会有“这一轮”，要它来撤） */
export function clearDropMark(): void {
  writeMark(false);
  lastRoundFailed = false;
  notifyDrop();
}

function notifyDrop(): void {
  dropListeners.emit();
}

/** 删会话的状态：pending 正在删；failed 上一轮有失败（或带着标记还没删掉）；ok 没有要删的。只有 exe 会出现前两种 */
export function sessionDropState(): 'ok' | 'pending' | 'failed' {
  if (pending.size > 0) return 'pending';
  return lastRoundFailed || (backend !== null && hasDropMark()) ? 'failed' : 'ok';
}

let incompleteShown = false;

/** exe 里删会话没成：显示“退出没完成，点重试”（ExitIncompleteScreen.tsx 订阅） */
export function showExitIncomplete(): void {
  incompleteShown = true;
  notifyDrop();
}

/** 现在要不要显示“退出没完成” */
export function exitIncompleteShown(): boolean {
  return incompleteShown;
}

/** 订阅 sessionDropState 的变化（每轮删除结束、撤掉标记时通知），返回退订 */
export const subscribeSessionDrop = dropListeners.subscribe;

/** exe：换上凭据管理器那一份 */
export function setSessionBackend(store: SessionBackendStore, view: Storage): void {
  backend = { store, view };
}

/** 测试用 */
export function resetSessionBackendForTest(): void {
  backend = null;
  memory.clear();
  removing.clear();
  pending.clear();
  dropping.clear();
  dropFailed = false;
  markEnabled = false;
  roundFailed = false;
  lastRoundFailed = false;
  dropListeners.clear();
  installError = null;
  incompleteShown = false;
}

function removeVia(b: Backend, key: string): Promise<void> {
  if (pending.size === 0) roundFailed = false;
  // 显式退出（经 collectRemovals 发出）且本窗口开了标记，才写标记
  const explicit = markEnabled && collecting !== null;
  if (explicit && dropping.size === 0) {
    // 先记标记再发删除（删到一半 exe 被关，下次启动也知道要删）
    dropFailed = false;
    writeMark(true);
  }
  removing.set(key, (removing.get(key) ?? 0) + 1);
  const p = b.store.removeItem(key).then(
    () => settle(true),
    (e: unknown) => {
      settle(false);
      throw e;
    },
  );
  function settle(ok: boolean): void {
    if (!ok) roundFailed = true;
    const n = (removing.get(key) ?? 1) - 1;
    if (n <= 0) removing.delete(key);
    else removing.set(key, n);
    pending.delete(p);
    if (explicit) {
      if (!ok) dropFailed = true;
      dropping.delete(p);
      // 显式删除都成功才撤标记
      if (dropping.size === 0 && !dropFailed) writeMark(false);
    }
    if (pending.size > 0) return;
    // 这一轮结束（本页状态，含 supabase-js 自己删的）
    lastRoundFailed = roundFailed;
    notifyDrop();
  }
  pending.add(p);
  if (explicit) dropping.add(p);
  collecting?.push(p);
  return p;
}

/**
 * 跑一段同步删除，返回这一段发出的删除是不是都成功（exe 里删失败要让调用方知道）。
 * 网页版马上 resolve；ok 为 false 时 fn 自己同步出过错
 */
export function collectRemovals(fn: () => boolean): Promise<boolean> {
  const prev = collecting;
  const mine: Promise<void>[] = [];
  collecting = mine;
  let ok: boolean;
  try {
    ok = fn();
  } finally {
    collecting = prev;
  }
  if (mine.length === 0) return Promise.resolve(ok);
  return Promise.allSettled(mine).then((rs) => ok && rs.every((r) => r.status === 'fulfilled'));
}

const readOnly = (): never => {
  throw new Error('session_store_read_only');
};

/** exe 的同步视图：删除中的键读不到 */
function overlay(b: Backend): Storage {
  const keys = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < b.view.length; i++) {
      const k = b.view.key(i);
      if (k !== null && !removing.has(k)) out.push(k);
    }
    return out;
  };
  return {
    get length() {
      return keys().length;
    },
    key: (i: number) => keys()[i] ?? null,
    getItem: (k: string) => (removing.has(k) ? null : b.view.getItem(k)),
    removeItem: (k: string) => {
      void removeVia(b, k).catch(() => undefined);
    },
    setItem: readOnly,
    clear: readOnly,
  };
}

/** exe 里没装上后端时用的空存储：什么都读不到，写、删都不落地 */
const memory = new Map<string, string>();
const EMPTY: Storage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  removeItem: () => undefined,
  setItem: readOnly,
  clear: readOnly,
};
const MEMORY_STORE: SessionBackendStore = {
  getItem: (k) => Promise.resolve(memory.get(k) ?? null),
  setItem: (k, v) => {
    memory.set(k, v);
    return Promise.resolve();
  },
  removeItem: (k) => {
    memory.delete(k);
    return Promise.resolve();
  },
};

/** 同步读、删会话用的 Storage：网页版 localStorage，exe 是凭据管理器的镜像，没装上时是空的 */
export function sessionStore(inTauri: () => boolean = () => isTauri()): Storage {
  if (backend) return overlay(backend);
  return inTauri() ? EMPTY : globalThis.localStorage;
}

/** client.ts 的 auth.storage：exe 里直通凭据管理器（没装上时是本页内存），网页版 undefined（用 authStorage()） */
export function authBackendStorage(inTauri: () => boolean = () => isTauri()): SessionBackendStore | undefined {
  const b = backend;
  if (!b) return inTauri() ? MEMORY_STORE : undefined;
  return {
    getItem: (k) => (removing.has(k) ? Promise.resolve(null) : b.store.getItem(k)),
    setItem: (k, v) => b.store.setItem(k, v),
    removeItem: (k) => (removalAllowed(k) ? removeVia(b, k) : Promise.resolve()),
  };
}

/** 等已发出的删除都回来（最多 ms）：重新载入前用，免得删除没到 Rust 页面就没了。不抛错 */
export async function sessionRemovalsSettled(ms = 3000): Promise<void> {
  if (pending.size === 0) return;
  await withTimeout<unknown>(() => Promise.allSettled([...pending]), ms, () => undefined);
}

/** installDesktopSession 没装上的原因（只是错误码，不含令牌）：main 入口据此提示“重新打开” */
export type DesktopSessionError = 'load_failed' | 'no_store' | 'preload_failed' | 'subscribe_failed';
let installError: DesktopSessionError | null = null;

/** exe 里 installDesktopSession 没装上的原因；装上了、或不在 exe 里为 null */
export function desktopSessionError(): DesktopSessionError | null {
  return installError;
}

/** supabase 会话键和它的附属键（`sb-*-auth-token`、`…-code-verifier`、`…-user`）：只在这里定义，platform/session.ts 也用它 */
export const SESSION_KEY_FAMILY_RE = /^sb-.+-auth-token(-.*)?$/;

/** 装上以后删掉 localStorage 里旧版留下的 supabase 会话键。不抛错 */
function dropOldLocalSessionKeys(): void {
  try {
    const ls = globalThis.localStorage;
    const old: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k !== null && SESSION_KEY_FAMILY_RE.test(k)) old.push(k);
    }
    for (const k of old) ls.removeItem(k);
  } catch {
    // 拿不到 localStorage：没有可删的
  }
}

/** installDesktopSession 用到的 desktop.ts 的几个函数（测试换掉） */
export type DesktopSessionModule = Pick<typeof Desktop, 'createDesktopSessionStorage' | 'desktopSessionKeys' | 'sessionStorageView' | 'onAuthDone'>;

/**
 * exe 里换上凭据管理器的会话存储：建存储 → preload 会话键 → 注册；给了 onAuthDone 就订阅 auth:done
 * （主窗口传 reloadPage：登录后整页重新载入，不在原界面树上刷新）。
 * 不在 exe 或没装上返回 false，原因见 desktopSessionError()。不抛错
 */
export async function installDesktopSession(
  onAuthDone?: () => void,
  load: () => Promise<DesktopSessionModule> = () => import('./desktop.ts'),
  inTauri: () => boolean = () => isTauri(),
): Promise<boolean> {
  if (!inTauri()) return false;
  installError = null;
  let step: DesktopSessionError = 'load_failed';
  try {
    const d = await load();
    const s = d.createDesktopSessionStorage();
    step = 'no_store';
    if (!s) throw new Error(step);
    step = 'preload_failed';
    await s.preload(d.desktopSessionKeys());
    setSessionBackend(s, d.sessionStorageView(s));
    dropOldLocalSessionKeys();
    step = 'subscribe_failed';
    if (onAuthDone) await d.onAuthDone(s, onAuthDone);
    return true;
  } catch {
    installError = step;
    return false;
  }
}
