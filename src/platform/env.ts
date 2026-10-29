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

// ───────── 客户端错误日志（架构 6.1“客户端错误”、ADR-010；TC-B1-68）─────────
// • window 的 error 和 unhandledrejection 用 addEventListener 注册（不占 window.onerror 属性，CSP 下也不需要内联脚本）
// • 写一条 logs：act = js_error，code 只有“错误类型@文件名:行号”（例如 TypeError@sync.js:120）；
//   不记错误消息原文、不记 stack 原文，也不记 URL 的路径、query、hash 和域名（消息、URL 里可能带用户内容）
//   - 错误类型：error.name 在白名单 JS_ERROR_NAMES 里才用（标准 Error 类型、常见 DOMException 名、本项目自定义的错误名），
//     否则记 Error（驼峰名里也可能拼进用户内容，审查 S1）；被 reject 的不是 Error 对象时记 NonError
//   - 文件名：只取同源、路径是 /app/assets/<文件名> 或 /app/index.html 的文件名（去掉 query 和 hash），
//     且只能是字母数字和 . _ -、以 .js / .mjs / .html 等结尾；同源的其他路径记 unknown（审查 S3），
//     别的来源（浏览器扩展、第三方脚本）记 ext，取不到记 unknown
//   - 行号：ErrorEvent.lineno；没有时取 stack 第一帧的行号。V8 的 stack 开头是“类型: 消息”，消息有几行就先跳过几行
//     （消息里带换行和 “at URL” 时不会被当成帧，审查 S2），再只看 “at ” 开头的行
// • 同一个 code 每台设备每天（本机日期）最多 JS_ERROR_DAILY_MAX 条，计数放 localStorage 的 JS_ERROR_KEY；
//   一天里最多记 JS_ERROR_MAX_CODES 个不同的 code，再多的不记（防止一页错误刷满每人每天 2,000 条的日志额度）；
//   localStorage 读写失败时退回只在这一页内存里计数
// • 记日志本身出错一律吞掉，不再触发新的 error 事件

export const JS_ERROR_ACT = 'js_error';
export const JS_ERROR_DAILY_MAX = 5;
export const JS_ERROR_MAX_CODES = 50;
export const JS_ERROR_KEY = 'lemo.jserr';

/**
 * js_error 认的错误类型（审查 S1）。不在这里的 name 一律记 Error。
 * 本项目自定义的错误名：按 `class X extends Error` 和 `.name =` 赋值查 src、shared 得出，新增自定义错误时补在这里。
 */
export const JS_ERROR_NAMES: ReadonlySet<string> = new Set([
  // 标准 Error 类型
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError',
  // 常见的 DOMException 名
  'QuotaExceededError', 'NotAllowedError', 'AbortError', 'NotFoundError', 'InvalidStateError', 'SecurityError',
  'NetworkError', 'DataError', 'TimeoutError', 'NotSupportedError', 'VersionError', 'UnknownError', 'ConstraintError',
  'TransactionInactiveError', 'ReadOnlyError', 'DataCloneError',
  // 本项目自定义（core/cache.ts、core/outbox-logic.ts、shared/objstore-net.ts）
  'CacheClosedError', 'OutboxRejectError', 'ObjStoreError',
]);
const FILE_RE = /^[A-Za-z0-9._-]{1,40}\.(?:m?js|cjs|jsx?|tsx?|html?)$/;
const FRAME_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s()@]+?):(\d{1,7})(?::\d{1,7})?\)?\s*$/i;
/** 同源里只认这个目录下的文件（vite base '/app/'，打包产物都在 assets 下，不分子目录）和入口页（审查 S3） */
const ASSETS_DIR = '/app/assets/';
const INDEX_PAGE = '/app/index.html';

/** 出错位置里的文件名：只认同源 /app/assets/ 下、名字干净的脚本文件和 /app/index.html */
function errorFile(url: string | undefined, origin: string): string {
  if (!url) return 'unknown';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unknown';
  }
  if (u.origin !== origin) return 'ext';
  const p = u.pathname;
  if (p === INDEX_PAGE) return 'index.html';
  if (!p.startsWith(ASSETS_DIR)) return 'unknown';
  const name = p.slice(ASSETS_DIR.length);
  return FILE_RE.test(name) ? name : 'unknown';
}

/**
 * 去掉 V8 stack 开头的“类型: 消息”：消息从第一行开始、有几行就跳过几行（审查 S2）。
 * Safari / Firefox 的 stack 不带消息（第一行里找不到消息），原样返回。
 */
function dropHeader(stack: string, message: unknown): string {
  if (typeof message !== 'string' || message === '') return stack;
  const firstNl = stack.indexOf('\n');
  const at = stack.indexOf(`: ${message}`);
  if (at < 0 || (firstNl >= 0 && at > firstNl)) return stack;
  const nl = stack.indexOf('\n', at + 2 + message.length);
  return nl < 0 ? '' : stack.slice(nl + 1);
}

/** stack 第一帧的 URL 和行号（不返回消息和函数名）；message 是错误消息，用来跳过 stack 开头的消息行 */
function firstFrame(stack: unknown, message?: unknown): { url: string; line: number } | null {
  if (typeof stack !== 'string') return null;
  const rest = dropHeader(stack, message);
  // 最多看 50 行、每行 500 字：FRAME_RE 遇到超长单行很慢（审查 S4）
  const lines = rest.split('\n', 50).map((l) => l.slice(0, 500));
  const v8 = lines.filter((l) => /^\s*at\s/.test(l));
  for (const l of v8.length > 0 ? v8 : lines) {
    const m = FRAME_RE.exec(l);
    if (m?.[1] && m[2]) return { url: m[1], line: Number(m[2]) };
  }
  return null;
}

/**
 * 一个错误 → js_error 的 code：“错误类型@文件名:行号”，最长 64 字。
 * at 是 ErrorEvent 给的位置（filename、lineno）；没有时看 stack。不含错误消息、URL 的路径和 query。
 */
export function jsErrorCode(err: unknown, at: { filename?: string; lineno?: number } = {}, origin = ''): string {
  const isErr = typeof err === 'object' && err !== null && 'name' in err;
  const name = isErr ? (err as { name?: unknown }).name : undefined;
  const type = !isErr ? 'NonError' : typeof name === 'string' && JS_ERROR_NAMES.has(name) ? name : 'Error';
  let url = at.filename || undefined;
  let line = typeof at.lineno === 'number' && Number.isInteger(at.lineno) && at.lineno > 0 ? at.lineno : 0;
  if (!url || line === 0) {
    const e = err as { stack?: unknown; message?: unknown };
    const f = isErr ? firstFrame(e.stack, e.message) : null;
    if (f && (!url || f.url === url)) {
      url = f.url;
      if (line === 0) line = f.line;
    }
  }
  const lineNo = Math.min(line, 9_999_999);
  return `${type}@${errorFile(url, origin)}:${lineNo}`.slice(0, 64);
}

/** 本机日期 YYYY-MM-DD（“每天”按设备的日期算） */
function localDay(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface JsErrorCounts {
  d: string;
  c: Record<string, number>;
}

export interface JsErrorLogOptions {
  /** 挂事件的地方（默认 window） */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** 本页的 origin（默认 location.origin），只认这个来源的脚本文件名 */
  origin?: string;
  now?: () => number;
  /** 计数存哪里（默认 localStorage）；null 只在内存里计 */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/** js_error 只交 act 和 code（和 app/log-channel.ts 的 log 兼容） */
export type JsErrorLog = (act: typeof JS_ERROR_ACT, f: { code: string }) => void;

/**
 * 注册客户端错误日志（main.tsx 建好日志通道后调一次）。返回注销函数（测试用）。
 */
export function registerJsErrorLog(log: JsErrorLog, opts: JsErrorLogOptions = {}): () => void {
  const target = opts.target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!target) return () => undefined;
  const origin = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const now = opts.now ?? (() => Date.now());
  const storage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
    if (opts.storage !== undefined) return opts.storage;
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  };
  let mem: JsErrorCounts = { d: '', c: {} };
  let busy = false;
  // 写失败过一次（存储满了：读得出、写不进）：这一页以后只用内存计数，不再读回写不进的旧值（审查 M1）
  let memOnly = false;
  // 今天 50 个 code 都记满了：直接返回，不再读存储（审查 S5）
  let fullDay = '';

  const load = (day: string): JsErrorCounts => {
    let st = mem;
    if (memOnly) return st.d === day ? st : { d: day, c: {} };
    try {
      const text = storage()?.getItem(JS_ERROR_KEY);
      if (text) {
        const o = JSON.parse(text) as Partial<JsErrorCounts> | null;
        if (o && typeof o.d === 'string' && typeof o.c === 'object' && o.c !== null) st = { d: o.d, c: { ...o.c } };
      }
    } catch {
      // 读不到：用内存里的
    }
    return st.d === day ? st : { d: day, c: {} };
  };
  const save = (st: JsErrorCounts): void => {
    mem = st;
    try {
      storage()?.setItem(JS_ERROR_KEY, JSON.stringify(st));
    } catch {
      // 写不进：mem 就是这一页的计数
      memOnly = true;
    }
  };

  const record = (err: unknown, at?: { filename?: string; lineno?: number }): void => {
    if (busy) return;
    busy = true;
    try {
      const day = localDay(now());
      if (fullDay === day) return;
      const code = jsErrorCode(err, at, origin);
      const st = load(day);
      const n = typeof st.c[code] === 'number' ? (st.c[code] as number) : 0;
      if (n >= JS_ERROR_DAILY_MAX) return;
      if (n === 0 && Object.keys(st.c).length >= JS_ERROR_MAX_CODES) {
        if (Object.values(st.c).every((v) => typeof v === 'number' && v >= JS_ERROR_DAILY_MAX)) fullDay = day;
        return;
      }
      st.c[code] = n + 1;
      save(st);
      log(JS_ERROR_ACT, { code });
    } catch {
      // 日志出错不挡业务，也不再抛
    } finally {
      busy = false;
    }
  };

  const onError = (e: Event): void => {
    const ev = e as Partial<ErrorEvent>;
    // 跨源脚本的错误（“Script error.”）没有 error 对象：只记类型 Error，不新建 Error（它的 stack 会指到这里）
    record(ev.error ?? { name: 'Error' }, { filename: ev.filename ?? '', lineno: ev.lineno ?? 0 });
  };
  const onRejection = (e: Event): void => {
    record((e as Partial<PromiseRejectionEvent>).reason);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
