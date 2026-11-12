// 构建信息（架构 8.1、8.5；0.31 第 3 条从 app/build-info.ts 挪来）：取代 v3 的 App.BUILD
// 版本号来自 VERSION 文件（vite define 注入）；其余只读 VITE_PUBLIC_ 开头的变量（A14）
import { errName } from './err-tag.ts';

export type AppEnv = 'production' | 'preview' | 'development' | 'test';

function envOf(v: string | undefined, mode: string): AppEnv {
  const x = v ?? mode;
  return x === 'production' || x === 'preview' || x === 'test' ? x : 'development';
}

export const buildInfo = {
  version: __APP_VERSION__,
  builtAt: __BUILD_TIME__,
  /** 构建用的提交号前 7 位（设置 › 关于的诊断信息显示）；e2e 等别的打包方式没定义时是 unknown */
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
  env: envOf(import.meta.env.VITE_PUBLIC_ENV, import.meta.env.MODE),
  /** 数据接口经自有域名转发：正式 https://lemomemo.com/sb，预览 https://preview.lemomemo.com/sb */
  supabaseUrl: import.meta.env.VITE_PUBLIC_SUPABASE_URL ?? '',
  anonKey: import.meta.env.VITE_PUBLIC_ANON_KEY ?? '',
  vapidKey: import.meta.env.VITE_PUBLIC_VAPID_KEY ?? '',
  turnstileSiteKey: import.meta.env.VITE_PUBLIC_TURNSTILE_SITE_KEY ?? '',
} as const;

// ───────── 运行环境（架构 5.10、5.3“exe”；B2 架构审 D4 第 1 点，B6-exe 约定 3）─────────

/** 网页（浏览器、iPhone 主屏幕版）还是 exe（Tauri 窗口，WebView2） */
export type Runtime = 'web' | 'tauri';

/**
 * 现在跑在哪：window 上有 Tauri 注入的 __TAURI_INTERNALS__（v2）或 __TAURI__（开了 withGlobalTauri）就是 exe。
 * 只在这里判断一次，device-info（devices.platform）、sw-register（exe 不注册 SW）、以后的推送订阅都读它，不各写一份。
 * win 默认 globalThis，测试时传假的进来
 */
export function runtimeOf(win: object = globalThis): Runtime {
  return '__TAURI_INTERNALS__' in win || '__TAURI__' in win ? 'tauri' : 'web';
}

/** 是不是 exe（Tauri 窗口） */
export function isTauri(win: object = globalThis): boolean {
  return runtimeOf(win) === 'tauri';
}

// ───────── 设备判断（架构 5.9“首次引导”、TC-B1-17；R-225 起 iPhone / iPad 上不分浏览器；这类判断只在这里）─────────

/** 判断要用到的 navigator 字段（测试时传假的进来） */
export interface NavLike {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** iOS Safari 专有：从主屏幕图标打开时为 true */
  readonly standalone?: boolean | undefined;
}

/**
 * iPhone、iPad、iPod 上的任何浏览器（Safari、Chrome、App 内置浏览器……）。
 * iPadOS 默认伪装成 Mac：UA 里是 Macintosh，要再看 maxTouchPoints > 1（Mac 没有触屏，是 0）。
 * 电脑（Windows、Mac）和安卓一律 false（第七轮：电脑浏览器照常登录）。
 */
export function isAppleMobile(nav: NavLike = navigator): boolean {
  const ua = nav.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
}

/** 只认 iPhone、iPod（iPad 不算，视口几何的 squeeze 按它：iPad 台前调度、分屏、接实体键盘时窗口本来就比整屏矮；冷启动高度校正 iPhone、iPad 都做，用 isAppleMobile） */
export const isIPhone = (ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean => /iPhone|iPod/.test(ua);

const NO_KB_INPUT = /^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/i;

/**
 * 焦点在这个元素上会不会弹键盘（“能打字的地方”，这类判断只在这里）：可编辑区域、select（iOS 弹选择轮，和键盘一样压可视区；电脑上按字母键是选选项）、
 * 没只读、没禁用的 textarea 和文字类 input。视口监听、冷启动高度校正、窗口快捷键、日历翻页键、运行日志都用它
 */
export function opensKeyboard(el: unknown): el is HTMLElement {
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return el instanceof HTMLInputElement && !el.readOnly && !el.disabled && !NO_KB_INPUT.test(el.type);
}

/** 是不是从主屏幕图标打开的（iOS 看 navigator.standalone，其他按 display-mode 媒体查询） */
export function isStandalone(
  nav: NavLike = navigator,
  media: (q: string) => boolean = (q) => typeof matchMedia === 'function' && matchMedia(q).matches,
): boolean {
  if (nav.standalone === true) return true;
  return media('(display-mode: standalone)') || media('(display-mode: fullscreen)');
}

// 登录页要不要只教“添加到主屏幕”（isIOSSafari、mustInstallFirst、installGate，R-225）在 install-gate.ts：只有登录页用，
// 放这里会因为和主 App 共用 env.ts 进首屏块（11-12 首屏瘦身）

// ───────── 客户端错误日志（架构 6.1“客户端错误”、ADR-010；TC-B1-68）─────────
// • window 的 error 和 unhandledrejection 用 addEventListener 注册（不占 window.onerror 属性，CSP 下也不需要内联脚本）
// • 写一条 logs：act = js_error，code 只有“错误类型@文件名:行号”（例如 TypeError@sync.js:120）；
//   不记错误消息原文、不记 stack 原文，也不记 URL 的路径、query、hash 和域名（消息、URL 里可能带用户内容）
//   - 错误类型：error.name 在白名单 JS_ERROR_NAMES 里才用（标准 Error 类型、常见 DOMException 名、本项目自定义的错误名），
//     否则记 Error（驼峰名里也可能拼进用户内容，审查 S1）；被 reject 的不是 Error 对象时记 NonError
//   - 文件名：只取同源、路径是 /app/assets/<文件名>、/app/index.html 或 /app/（入口页本身，hash 路由下地址就是它，
//     JSERR-sugg ⑧）的文件名（去掉 query 和 hash；/app/ 记 index.html），
//     且只能是字母数字和 . _ -、以 .js / .mjs / .html 等结尾；同源的其他路径记 unknown（审查 S3），
//     别的来源（浏览器扩展、第三方脚本）记 ext，取不到记 unknown
//   - 行号、列号：ErrorEvent.lineno / colno；没有时取 stack 第一帧的行号和列号（打包产物几乎只有 1 行，靠列号定位，JSERR-sugg ⑦）。
//     V8 格式的 stack（有 “at ” 开头的行）开头必须正好是“名字: 当前消息”（消息为空时只有名字），对上了才按消息行数跳过开头、
//     只看 “at ” 开头的行；对不上（先读了 stack 再改 message、stack 被整个换掉、name 为空时开头直接是消息）就不用 stack，
//     行号、列号记 0（JSERR-sugg ⑤：消息里伪造的同源帧不会被当成出错位置）。
//     Safari / Firefox 格式（fn@url:行:列）不带消息，一行都不跳（函数名里碰巧有“: 消息”也不跳，JSERR-sugg ⑥）
//   - code 格式（10-30 起）：“错误类型@文件名:行号:列号”，取不到的记 0，最长 64 字；每天 5 条、50 个不同 code 都按这整串计。
//     超长时（FE-1030-sugg ①）先截文件名：留扩展名，截掉扩展名前那段的末尾、补一个 ~ 标出截过（~ 不会出现在真文件名里）；
//     还超就行号、列号都记 0。绝不截行号、列号本身（截掉末位的列号像个合法的小数字，会指错位置）
// • 同一个 code 每台设备每天（本机日期）最多 JS_ERROR_DAILY_MAX 条，计数放 localStorage 的 JS_ERROR_KEY；
//   一天里最多记 JS_ERROR_MAX_CODES 个不同的 code，再多的不记（防止一页错误刷满每人每天 2,000 条的日志额度）；
//   50 个用完以后头一回有新 code 被挡下时，记一条 act = js_error_codes_full（code = 50，FE-1030-sugg ②），每台设备每天最多一条：
//   记过没有存在同一份计数里（字段 f），跨页面、重新载入都只记一次；存储读写失败时同样退回这一页内存
//   localStorage 读写失败时退回只在这一页内存里计数
// • 记日志本身出错一律吞掉，不再触发新的 error 事件

export const JS_ERROR_ACT = 'js_error';
/** 今天 50 个不同的 code 用完了、又有新的被挡下（FE-1030-sugg ②） */
export const JS_ERROR_FULL_ACT = 'js_error_codes_full';
/** code 最长几个字 */
export const JS_ERROR_CODE_MAX = 64;
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
const FRAME_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s()@]+?):(\d{1,7})(?::(\d{1,7}))?\)?\s*$/i;
/** V8 格式的帧行 */
const V8_FRAME_RE = /^\s*at\s/;
/** V8 stack 开头的名字（标识符）；name 为空时 V8 开头直接是消息，这里就对不上 */
const V8_NAME_RE = /^[A-Za-z_$][\w$]{0,99}/;
/** 同源里只认这个目录下的文件（vite base '/app/'，打包产物都在 assets 下，不分子目录）和入口页（审查 S3） */
const ASSETS_DIR = '/app/assets/';
const INDEX_PAGE = '/app/index.html';
/** 入口页本身的地址（hash 路由：#/notes 之类都在这个路径下） */
const APP_ROOT = '/app/';

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
  if (p === INDEX_PAGE || p === APP_ROOT) return 'index.html';
  if (!p.startsWith(ASSETS_DIR)) return 'unknown';
  const name = p.slice(ASSETS_DIR.length);
  return FILE_RE.test(name) ? name : 'unknown';
}

/**
 * V8 stack 去掉开头的“名字: 消息”后剩下的帧（审查 S2、JSERR-sugg ⑤）：开头必须正好是“标识符: 当前消息”（消息为空时只有标识符），
 * 后面紧跟换行或结束；对不上返回 null（不用这个 stack）。名字只要是标识符：自定义错误类在 super() 之后才改 name，开头还是 “Error”
 */
function v8Body(stack: string, message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const name = V8_NAME_RE.exec(stack)?.[0];
  if (!name) return null;
  const header = message === '' ? name : `${name}: ${message}`;
  if (!stack.startsWith(header)) return null;
  const rest = stack.slice(header.length);
  if (rest === '') return '';
  return rest.startsWith('\n') ? rest.slice(1) : null;
}

interface Frame {
  url: string;
  line: number;
  col: number;
}

/** stack 第一帧的 URL、行号、列号（不返回消息和函数名）；message 是错误消息，用来核对、跳过 V8 stack 开头的消息行 */
function firstFrame(stack: unknown, message?: unknown): Frame | null {
  if (typeof stack !== 'string') return null;
  // 最多看 50 行、每行 500 字：FRAME_RE 遇到超长单行很慢（审查 S4）
  const head = (t: string): string[] => t.split('\n', 50).map((l) => l.slice(0, 500));
  const isV8 = head(stack).some((l) => V8_FRAME_RE.test(l));
  let lines: string[];
  if (isV8) {
    const body = v8Body(stack, message);
    if (body === null) return null;
    lines = head(body).filter((l) => V8_FRAME_RE.test(l));
  } else {
    lines = head(stack);
  }
  for (const l of lines) {
    const m = FRAME_RE.exec(l);
    if (m?.[1] && m[2]) return { url: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : 0 };
  }
  return null;
}

/** 正整数原样，其他（0、负数、小数、不是数）记 0，最大 9,999,999 */
function posInt(n: unknown): number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? Math.min(n, 9_999_999) : 0;
}

/**
 * 拼 code 并保证不超过 JS_ERROR_CODE_MAX（FE-1030-sugg ①）：先截文件名（留扩展名，扩展名前那段截掉末尾、补 ~），
 * 还超就行号、列号记 0；绝不截行号、列号的数字。按现在的白名单类型（最长 24 字）和文件名（≤ 46 字）第二步碰不到，留作兜底。
 */
export function fitJsErrorCode(type: string, file: string, line: number, col: number): string {
  const whole = `${type}@${file}:${line}:${col}`;
  if (whole.length <= JS_ERROR_CODE_MAX) return whole;
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot) : '';
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const cut = (tail: string): string | null => {
    // 扩展名前那段至少留 1 个字，再加 ~
    const keep = JS_ERROR_CODE_MAX - type.length - 1 - tail.length - ext.length - 1;
    return keep >= 1 ? `${type}@${stem.slice(0, keep)}~${ext}${tail}` : null;
  };
  const withPos = cut(`:${line}:${col}`);
  if (withPos) return withPos;
  const zero = cut(':0:0');
  if (zero) return zero;
  // 类型名本身就长到放不下：文件名也不要了
  return `${type.slice(0, JS_ERROR_CODE_MAX - 6)}@~:0:0`;
}

/**
 * 一个错误 → js_error 的 code：“错误类型@文件名:行号:列号”，最长 64 字（超长见 fitJsErrorCode）。
 * at 是 ErrorEvent 给的位置（filename、lineno、colno）；没有时看 stack。不含错误消息、URL 的路径和 query。
 */
export function jsErrorCode(err: unknown, at: { filename?: string; lineno?: number; colno?: number } = {}, origin = ''): string {
  const isErr = typeof err === 'object' && err !== null && 'name' in err;
  const name = errName(err);
  const type = !isErr ? 'NonError' : JS_ERROR_NAMES.has(name) ? name : 'Error';
  let url = at.filename || undefined;
  let line = posInt(at.lineno);
  // 列号跟着行号走：行号是 ErrorEvent 给的，列号也用它的
  let col = line > 0 ? posInt(at.colno) : 0;
  if (!url || line === 0) {
    const e = err as { stack?: unknown; message?: unknown };
    const f = isErr ? firstFrame(e.stack, e.message) : null;
    if (f && (!url || f.url === url)) {
      url = f.url;
      if (line === 0) {
        line = posInt(f.line);
        col = posInt(f.col);
      }
    }
  }
  return fitJsErrorCode(type, errorFile(url, origin), line, col);
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
  /** 今天记过 js_error_codes_full 了（FE-1030-sugg ②） */
  f?: 1;
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

/** js_error、js_error_codes_full 只交 act 和 code（和 app/log-channel.ts 的 log 兼容） */
export type JsErrorLog = (act: typeof JS_ERROR_ACT | typeof JS_ERROR_FULL_ACT, f: { code: string }) => void;

/**
 * 注册客户端错误日志（main.tsx 接好日志总线 setLogSink 后调一次，传 logEvent）。返回注销函数（测试用）。
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
        if (o && typeof o.d === 'string' && typeof o.c === 'object' && o.c !== null) {
          st = o.f === 1 ? { d: o.d, c: { ...o.c }, f: 1 } : { d: o.d, c: { ...o.c } };
        }
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

  const record = (err: unknown, at?: { filename?: string; lineno?: number; colno?: number }): void => {
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
        // 头一回挡下新 code：记一条“今天额度满了”，标记和计数存在一起，每天只记一次
        if (st.f !== 1) {
          st.f = 1;
          save(st);
          log(JS_ERROR_FULL_ACT, { code: String(JS_ERROR_MAX_CODES) });
        }
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
    record(ev.error ?? { name: 'Error' }, { filename: ev.filename ?? '', lineno: ev.lineno ?? 0, colno: ev.colno ?? 0 });
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
