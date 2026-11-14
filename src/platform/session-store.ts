// 本机会话存在哪（B6-exe 安全审查 F5-2、复核 N1；B2 安全审查 FA2-3）：网页版是 localStorage；exe 是 Rust 的凭据管理器（desktop.ts 的
// desktopSessionStorage），会话不落 WebView2 的 localStorage。
// • session.ts 的同步读（readSessionUserId、readSessionId…）和同步删（clearAnyLocalSession、clearLocalSessionIf）都经 sessionStore()：
//   网页版原样是 localStorage；exe 是 sessionStorageView（peek 的镜像）外面再包一层——删的时候先在本页记“删除中”（同步读马上读不到），
//   同时调 Rust 真删，删完（成功或失败）再撤掉记号；删失败时会话照旧读得到（没删掉就不假装删掉了）
// • supabase-js 的 auth.storage（client.ts）在 exe 里用 authBackendStorage()：读写直通凭据管理器（异步），删键前同样问退出期间的保护
//   （auth-storage.ts 的 removalAllowed，K6-signout-lib），并记“删除中”
// • 接线顺序（desktop.ts 的审查 S3）：installDesktopSession() 在建 supabase 客户端、第一次同步读会话之前 await 完（main 入口、登录小窗口入口）；
//   它动态 import desktop.ts，网页版打包里不带 Tauri 的代码
// • 后端对象只放在本模块作用域，不挂到 window / globalThis（安全审查建议 6）；不导出 peek
// • 删不掉（安全审查 A-1、代码审查 A-M1）：exe 主窗口里每一轮**显式退出**的删除（clearAnyLocalSession 经 collectRemovals 发出的；
//   从没有在跑到有）开始前，在 localStorage 记一个“待删除”标记（DROP_MARK_KEY，值只是 "1"，不含令牌、不含 session_id）；
//   这一轮的显式删除都成功才撤掉。supabase-js 自己删键（authBackendStorage）不写标记——成败只记在本页的删除状态里（goToAuth 照样看得到）；
//   登录小窗口一律不写（enableDropMark 只有主窗口入口调）——
//   否则登录小窗口里删失败、随后又登录成功，主窗口重新载入时会把刚登录的会话当成“待删除”删掉（安全复审建议 ①）。
//   有一个失败：标记留着、状态变成 failed——
//   goToAuth 不重新载入回已登录界面，改显示“退出没完成，点重试”（session.ts 的 retryDropSession）；下次启动有标记就先删会话（settleDropAtStartup），
//   删不掉不画账号界面。网页版的 localStorage 同步删，没有这一层
// • 本页内存状态（roundFailed / lastRoundFailed，含 supabase-js 自己删键的成败）和标记分开记，有两个已知的边角（外壳代码复审）：
//   ① supabase-js 删键失败以后，如果之后没有新的显式删除，lastRoundFailed 会停在那个旧的失败上，goToAuth 可能误显示“退出没完成”；
//      点“重试”（clearAnyLocalSession 删干净后 clearDropMark）就恢复。自己退出这一路一般碰不到：exe 里服务器退成了以后，
//      sign-out.ts 也会兜底调一次 clearLocalSessionIf(sid)——supabase-js 没删掉时会话还是 sid，它就再删一次（显式删除，开新的一轮、
//      结束时刷新 lastRoundFailed）；已经删掉了（本机会话读出来不再是 sid）就不删。
//      例外：sid 为 null（退出开始时就读不出会话）且本机仍读不出会话时，clearLocalSessionIf 会照删一遍——对三个本来就不在的键
//      （会话键、-code-verifier、-user）发删除，exe 里这是一轮显式删除：先写标记；Rust 删不存在的凭据按成功处理（ERROR_NOT_FOUND），这种情况发出的删除都算成功，标记会撤掉
//   ② 内存状态随进程消失。跨重启靠两样：显式删除写的“待删除”标记（上面那条兜底删除失败也会留下标记，下次启动先删）；
//      没有标记的残留会话（只有 supabase-js 删失败、又没有兜底删）在下次启动刷新令牌失败时，走“被移除”流程删掉
// • 关着失败（fail closed）：exe 里没装上（分包加载失败、Rust 不在）时，同步读一律读不到、supabase-js 用本页内存——宁可登录不上，
//   也不退回 localStorage（F5-2：exe 的会话不落 WebView2 的 localStorage）
import type * as Desktop from './desktop.ts';
import { isTauri } from './env.ts';
import { withTimeout } from './exit-basics.ts';
import { removalAllowed } from './supabase/auth-storage.ts';

/** desktop.ts 的 DesktopSessionStorage 里本文件用到的部分（不 import desktop.ts 的类型，免得网页版的依赖图里出现它） */
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
const dropListeners = new Set<() => void>();
/** 显式退出里还没回来的删除（标记的一轮）、其中有没有失败的 */
const dropping = new Set<Promise<void>>();
let dropFailed = false;
/** 这个窗口记不记“待删除”标记：只有主窗口入口（app/main.tsx）打开；登录小窗口、网页版不开 */
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
 * localStorage 里有没有“待删除”标记。
 * localStorage 不可用（读写抛错）时返回 false：那时 writeMark 也写不进去，启动时不会先删会话（没有跨重启的这一层兜底）；
 * 本次运行里删失败照样靠 lastRoundFailed 报 failed、显示“退出没完成”，不会因为读不到标记就当成删干净了
 */
export function hasDropMark(): boolean {
  try {
    return globalThis.localStorage.getItem(DROP_MARK_KEY) !== null;
  } catch {
    return false;
  }
}

/** 撤掉标记、状态回到 ok（session.ts 删干净以后调：一个键都没有要删时不会有“这一轮”，要它来撤） */
export function clearDropMark(): void {
  writeMark(false);
  lastRoundFailed = false;
  notifyDrop();
}

function notifyDrop(): void {
  for (const f of [...dropListeners]) f();
}

/**
 * 删会话的状态：pending 正在删；failed 上一轮有删失败的（或启动时就带着标记、还没删掉）；ok 没有要删的。
 * 只有 exe 会出现 pending、failed
 */
export function sessionDropState(): 'ok' | 'pending' | 'failed' {
  if (pending.size > 0) return 'pending';
  return lastRoundFailed || (backend !== null && hasDropMark()) ? 'failed' : 'ok';
}

let incompleteShown = false;

/** goToAuth 在 exe 里删会话没成：显示“退出没完成，点重试”（app/ExitIncompleteScreen.tsx 订阅它） */
export function showExitIncomplete(): void {
  incompleteShown = true;
  notifyDrop();
}

/** 现在要不要显示“退出没完成” */
export function exitIncompleteShown(): boolean {
  return incompleteShown;
}

/** 订阅 sessionDropState 的变化（每轮删除结束、撤掉标记时通知），返回退订 */
export function subscribeSessionDrop(fn: () => void): () => void {
  dropListeners.add(fn);
  return () => dropListeners.delete(fn);
}

/** exe：换上凭据管理器那一份（view 是 desktop.ts 的 sessionStorageView(store)） */
export function setSessionBackend(store: SessionBackendStore, view: Storage): void {
  backend = { store, view };
}

/** 现在是不是 exe 的会话存储 */
export function hasSessionBackend(): boolean {
  return backend !== null;
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
  // 显式退出（clearAnyLocalSession 经 collectRemovals 发出的）且这个窗口开了标记，才写“待删除”标记
  const explicit = markEnabled && collecting !== null;
  if (explicit && dropping.size === 0) {
    // 标记的新一轮：先记标记再发删除（删到一半 exe 被关掉，下次启动也知道要删）
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
 * 跑一段同步删除（session.ts 的 clearAnyLocalSession），返回这一段发出的删除是不是都成功了（F5-2 ③：exe 里删凭据管理器失败要让调用方知道）。
 * 网页版（localStorage 同步删）马上 resolve；ok 为 false 时 fn 自己同步出过错
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

/** 同步读、同步删会话用的 Storage：网页版 localStorage，exe 是凭据管理器的镜像（见文件头）；exe 没装上时是空的 */
export function sessionStore(inTauri: () => boolean = () => isTauri()): Storage {
  if (backend) return overlay(backend);
  return inTauri() ? EMPTY : globalThis.localStorage;
}

/** client.ts 的 auth.storage：exe 里返回直通凭据管理器的异步存储（没装上时是本页内存），网页版 undefined（照旧用 authStorage()） */
export function authBackendStorage(inTauri: () => boolean = () => isTauri()): SessionBackendStore | undefined {
  const b = backend;
  if (!b) return inTauri() ? MEMORY_STORE : undefined;
  return {
    getItem: (k) => (removing.has(k) ? Promise.resolve(null) : b.store.getItem(k)),
    setItem: (k, v) => b.store.setItem(k, v),
    removeItem: (k) => (removalAllowed(k) ? removeVia(b, k) : Promise.resolve()),
  };
}

/** 等已经发出的删除都回来（最多 ms）：exe 里重新载入页面之前用，免得删除还没到 Rust 页面就没了。不抛错 */
export async function sessionRemovalsSettled(ms = 3000): Promise<void> {
  if (pending.size === 0) return;
  await withTimeout<unknown>(() => Promise.allSettled([...pending]), ms, () => undefined);
}

/** installDesktopSession 在 exe 里没装上的原因（只是错误码，不含令牌；代码审查建议 4）：main 入口据此提示“重新打开” */
export type DesktopSessionError = 'load_failed' | 'no_store' | 'preload_failed' | 'subscribe_failed';
let installError: DesktopSessionError | null = null;

/** exe 里 installDesktopSession 没装上的原因；装上了、或不在 exe 里为 null */
export function desktopSessionError(): DesktopSessionError | null {
  return installError;
}

const OLD_SESSION_KEY = /^sb-.+-auth-token(-.*)?$/;

/** 装上以后删掉 localStorage 里以前（会话还存在 WebView2 的 localStorage 时）留下的 supabase 会话键（安全审查建议 ②）。不抛错 */
function dropOldLocalSessionKeys(): void {
  try {
    const ls = globalThis.localStorage;
    const old: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k !== null && OLD_SESSION_KEY.test(k)) old.push(k);
    }
    for (const k of old) ls.removeItem(k);
  } catch {
    // 拿不到 localStorage：没有可删的
  }
}

/** installDesktopSession 用到的 desktop.ts 的几个函数（测试换掉） */
export type DesktopSessionModule = Pick<typeof Desktop, 'createDesktopSessionStorage' | 'desktopSessionKeys' | 'sessionStorageView' | 'onAuthDone'>;

/**
 * exe 里换上凭据管理器的会话存储：建存储 → preload 会话键 → 注册；onAuthDone 给了就订阅 auth:done（main 窗口传 reloadPage：
 * 登录小窗口写好会话后整页重新载入，不在原来的界面树上刷新，FA2-3）。装上以后删掉 localStorage 里的旧会话键。
 * 不在 exe 返回 false；exe 里没装上返回 false，原因见 desktopSessionError()。不抛错
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
