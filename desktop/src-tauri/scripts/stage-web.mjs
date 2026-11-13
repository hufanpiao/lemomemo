#!/usr/bin/env node
// 把网页产物 dist/web/app 暂存成 exe 要打包的页面（B6-exe F1/F3/F8；架构 5.10、0.48 第 7 条；安全审查外壳 X-1、X-4、X-S5）。
//
// 用法（仓库根目录）：
//   node desktop/src-tauri/scripts/stage-web.mjs --env production
//   node desktop/src-tauri/scripts/stage-web.mjs --env preview
//   本地冒烟：再加 --skip-env-check（产物没带接口地址时也放行）。环境变量 CI 或 GITHUB_ACTIONS 有值时一律拒绝这个参数；
//   流水线文件里出现它也会被 ci-guard.mjs 拦下（安全审查 X-4、代码审查 M4）。跳过时 desktop-env.json 记 envCheck: "skipped"，
//   发布版 exe 见到不是 "passed" 就拒绝启动（只有 debug 版能用跳过核对的页面做本地冒烟）
//
// 做的事：
//   1. 复制 dist/web/app → desktop/src-tauri/target/web-stage/app（目录已被 .gitignore 忽略），
//      不复制 SKIP 里的文件：sw.js（exe 不注册 Service Worker，更新走 updater）、preview.html（架构 5.13 的附件预览沙箱页，
//      不是开发预览页；B4b-1 接进 exe 以前不打包。接上以后要从 SKIP 挪进 PAGES 并单独定 CSP，见 B6-exe 任务单冲突表，复核 N2）；
//      也不复制 SKIP_EXT 里后缀的文件：.wasm（R-402 给 iPhone Safari 补的 webp 编码器，exe 用不到，理由见 SKIP_EXT）；
//   2. 核对产物编进去的接口地址属于这次的环境（两个方向都查：正式包里不能有预览地址，预览包里不能有正式地址）；
//   3. 暂存目录里的每个 .html 都按 PAGES 名单注入按环境区分的严格 meta CSP（和全局 CSP 取交集），
//      名单以外的 .html 直接失败（X-1）；main、auth 两页必须有，quick-add 页有就注入（页面入口加进 vite.config.ts 之前没有）。
//      其余文件按后缀白名单（ASSET_EXT）：名单外的一律失败；png、ico、woff2 核对文件头，json、webmanifest 必须能按 JSON 解析
//      （webmanifest 会被 Tauri 当成 text/html，另外不许出现 <）；.svg 只许白名单写法（checkSvg）（X-S7；B6-exe 代码审查 M4、安全审查 F5-3）；
//   4. 写 app/desktop-env.json（{ env, envCheck: "passed" | "skipped" }），Rust 启动时核对（lib.rs check_env）。
// 页面里有内联 <script> 时直接失败（严格 CSP 下会被拦，宁可构建时报错）。
//
// 测试：node --test desktop/src-tauri/scripts/stage-web.test.mjs —— 必须直接指定这个文件；传目录（node --test desktop/src-tauri/scripts）
// 会把 stage-web.mjs、ci-guard.mjs 也当测试文件跑，报 1 个失败（复核要求写明）。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(HERE, '..');
const REPO = resolve(SRC_TAURI, '..', '..');
const DIST = join(REPO, 'dist', 'web', 'app');
const STAGE_ROOT = join(SRC_TAURI, 'target', 'web-stage');
const STAGE = join(STAGE_ROOT, 'app');

export const SKIP_ENV_CHECK = '--skip-env-check';

/** 两套环境（和 src/env.rs 一一对应）；forbidden = 这套产物里不许出现的东西 */
export const ENVS = {
  production: {
    origin: 'https://lemomemo.com',
    ws: 'wss://lemomemo.com',
    forbidden: [
      { re: /preview\.lemomemo\.com/, why: '预览地址 preview.lemomemo.com' },
      { re: /https:\/\/[a-z0-9-]+\.supabase\.co/, why: 'supabase.co 直连地址' },
    ],
  },
  preview: {
    origin: 'https://preview.lemomemo.com',
    ws: 'wss://preview.lemomemo.com',
    forbidden: [
      // 正式地址：前面紧跟 https://，后面不能再接域名字符（排除 https://lemomemo.com.evil 之类）
      { re: /https:\/\/lemomemo\.com(?![a-z0-9.-])/i, why: '正式地址 https://lemomemo.com' },
      { re: /https:\/\/[a-z0-9-]+\.supabase\.co/, why: 'supabase.co 直连地址' },
    ],
  },
};

/** 不进安装包的文件（相对 app/）。开源许可清单 licenses.txt（R-410）照常进包：exe 里也带着那些 JS 依赖 */
export const SKIP = new Set(['sw.js', 'sw.js.map', 'preview.html']);

/**
 * 不进安装包的后缀：.wasm 是 R-402 给 iPhone Safari 补的 webp 编码器（canvas 导出不了 webp 时才按需加载）。
 * exe 的 WebView2 原生就能导出 webp，用不到它；exe 的 CSP 也没有 'wasm-unsafe-eval'，带进去也编译不了。
 * 万一真走到那条路，载入前的探测会因为 CSP 不让编译报 wasm_unsupported（“这台设备暂时加不了图”，R-407），不会卡住
 */
export const SKIP_EXT = new Set(['.wasm']);

/** 这个文件（相对 app/，分隔符用 /）不进安装包 */
export function skipped(r) {
  return SKIP.has(r) || SKIP_EXT.has(extOf(r));
}

/**
 * 安装包里允许的后缀（白名单，B6-exe 代码审查 M4、安全审查 F5-3 ①）。Tauri 2.12.5 的资源协议只给 .html 注入 CSP；
 * MIME 先按文件头嗅探（tauri-utils mime_type.rs 的 infer::get，.svg 除外），嗅探不出就按后缀，**后缀表里没有的一律当 text/html**——
 * png、ico、woff2、webmanifest 都不在那张表里。所以：
 * • .html 只许 PAGES 名单里的（planPages）；
 * • .js .css .json .svg .txt 在 Tauri 的后缀表里，但嗅探在前：.js、.css、.txt 开头不许是 <（checkTextAsset，F5-6）；
 *   .txt 只有开源许可清单 licenses.txt（R-410，tauri-utils 2.10.2 后缀表 txt → text/plain）；
 *   .svg 另查内容（checkSvg）；.json 也要能解析（checkJsonAsset）；
 * • .png .ico .woff2 靠文件头嗅探才不被当成 HTML：文件头必须对得上（checkMagic）；
 * • .webmanifest 嗅探不出、后缀表里也没有，Tauri 会当 text/html 返回：必须能按 JSON 解析，而且不许出现 <（checkJsonAsset）。
 * 名单外的后缀（含没有后缀的文件）一律失败；以后要加新类型，先查 Tauri 怎么给它定 MIME，再加进来
 */
export const ASSET_EXT = new Set(['.js', '.css', '.txt', '.png', '.ico', '.svg', '.woff2', '.json', '.webmanifest']);

/** 小写后缀（含点）；没有后缀返回 '' */
export function extOf(p) {
  const name = p.split('/').pop() ?? '';
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/** .html（不分大小写）都要过 PAGES 名单 */
export const isPageFile = (p) => extOf(p) === '.html';

/** 暂存目录里的文件（相对 app/）按后缀白名单分拣：返回不许进包的文件和原因 */
export function checkFileTypes(paths) {
  return paths.filter((p) => !isPageFile(p) && !ASSET_EXT.has(extOf(p))).map((p) => `${p}（后缀 ${extOf(p) || '无'} 不在白名单里）`);
}

/** 二进制资源的文件头（和 infer 认的一样）：对不上 Tauri 就按后缀回落成 text/html */
const MAGIC = {
  '.png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  '.ico': [0x00, 0x00, 0x01, 0x00],
  '.woff2': [0x77, 0x4f, 0x46, 0x32], // wOF2
};

/** png、ico、woff2 的文件头对不对：返回原因，对得上返回 null；别的后缀不查 */
export function checkMagic(p, bytes) {
  const want = MAGIC[extOf(p)];
  if (!want) return null;
  const ok = bytes.length >= want.length && want.every((b, i) => bytes[i] === b);
  return ok ? null : `${p}（文件头不是 ${extOf(p)}，Tauri 会当成 text/html 返回）`;
}

/** 严格按 UTF-8 解码：有 BOM、解码失败、含 NUL 都返回 null */
function strictUtf8(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return null;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\0') ? null : text;
}

/** .json、.webmanifest：严格 UTF-8、能按 JSON 解析；.webmanifest 会被当成 text/html，另外不许出现 <（F5-3 ①）。返回原因或 null */
export function checkJsonAsset(p, input) {
  const ext = extOf(p);
  if (ext !== '.json' && ext !== '.webmanifest') return null;
  const text = strictUtf8(input);
  if (text === null) return `${p}（不是合法的 UTF-8，或带 BOM、NUL）`;
  try {
    JSON.parse(text);
  } catch {
    return `${p}（不能按 JSON 解析）`;
  }
  if (ext === '.webmanifest' && text.includes('<')) return `${p}（webmanifest 会被 Tauri 当成 text/html 返回，里面不许出现 <）`;
  return null;
}

/**
 * .js、.css、.txt：去掉开头的空白（含 BOM）以后，第一个字符不许是 <（安全审查 F5-6）。Tauri 先按内容嗅探 MIME（infer::get），
 * 以 <!--、<script、<html 之类开头的文件会被当成 text/html 返回，而且不带 CSP（CSP 只注入进 PAGES 名单里的页面）。返回原因或 null
 */
export function checkTextAsset(p, input) {
  const ext = extOf(p);
  if (ext !== '.js' && ext !== '.css' && ext !== '.txt') return null;
  // 在字节上复刻 infer 0.22 的规则（代码审查 B-M2）：循环去掉空白 09 0A 0C 0D 20 和 BOM（EF BB BF、FE FF、FF FE），
  // 下一个字节是 < 就拒。以前先按非严格 UTF-8 解码，FE FF 变成 U+FFFD 去不掉，`20 FE FF <?xml` 会被放行、被判成 text/xml
  const b = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let i = 0;
  for (;;) {
    if ([0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(b[i])) i += 1;
    else if (b[i] === 0xef && b[i + 1] === 0xbb && b[i + 2] === 0xbf) i += 3;
    else if ((b[i] === 0xfe && b[i + 1] === 0xff) || (b[i] === 0xff && b[i + 1] === 0xfe)) i += 2;
    else break;
  }
  return b[i] === 0x3c ? `${p}（去掉开头空白和 BOM 后第一个字节是 <，Tauri 会按内容嗅探成 text/html 或 text/xml 返回，不带 CSP）` : null;
}

/**
 * SVG 内容检查（安全审查外壳 X-S7；B6-exe 代码审查 M4、安全审查 F5-3 ②，两边取更严的）：只许图标用得到的写法，其余一律拒。
 * 不是完整的 XML 解析器，而是一个只认白名单写法的小分词器：认不出的写法直接拒，宁可误拒。
 * • 编码：不许 BOM、不许 NUL，必须是合法 UTF-8（UTF-16 的文件按 utf8 读进来每个字符夹 NUL，以前的正则全看不见）；
 * • 不许 <!DOCTYPE（含外部 DTD、实体声明）、<![CDATA[、除开头 <?xml …?> 声明以外的处理指令（xml-stylesheet 等）；
 * • 不许任何 &#（数字字符引用：javascript&#58;、&#106;avascript:、java&#9;script: 都靠它），实体只许 5 个预定义的；
 * • 元素只许白名单（SVG_ELEMENTS），不许带前缀（<s:script>、<h:iframe>）；script、foreignObject、iframe、animate、set、use、style 等都不在名单里；
 * • 属性：不许 on*；带前缀的只许 xmlns:xlink（值必须是 xlink 命名空间）和 xlink:href；xmlns 的值必须是 SVG 命名空间；
 *   href、xlink:href 只许 #本文件里的 id；值里的 url(...) 只许 url(#id)；任何值里出现 javascript: 都拒；值必须带引号。
 * 返回命中的原因列表，空表示可以打包
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
export const SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'title', 'desc', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feFlood', 'feComposite', 'feMerge',
  'feMergeNode',
]);
const PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function checkAttr(name, value, why) {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) why.add(`on* 事件属性（${name}）`);
  if (name.includes(':')) {
    if (name === 'xmlns:xlink') {
      if (value !== XLINK_NS) why.add(`xmlns:xlink 的值不是 xlink 命名空间（${value}）`);
    } else if (name !== 'xlink:href') {
      why.add(`带前缀的属性（${name}）`);
    }
  }
  if (name === 'xmlns' && value !== SVG_NS) why.add(`xmlns 不是 SVG 命名空间（${value}）`);
  if ((name === 'href' || name === 'xlink:href') && !/^#[\w-]+$/.test(value)) why.add(`${name} 只许 #id（${value}）`);
  if (/javascript\s*:/i.test(value)) why.add('javascript: 地址');
  for (const m of value.matchAll(/url\(\s*([^)]*)\)/gi)) {
    if (!/^#[\w-]+$/.test(m[1].trim())) why.add(`url(...) 只许 #id（${m[1].trim()}）`);
  }
}

export function checkSvg(input) {
  const text = strictUtf8(input);
  if (text === null) return ['编码不对（不是合法 UTF-8，或带 BOM、NUL）'];
  const why = new Set();
  if (/&#/.test(text)) why.add('数字字符引用 &#');
  for (const m of text.matchAll(/&([^;\s<&]*);?/g)) {
    if (!PREDEFINED_ENTITIES.has(m[1]) || !m[0].endsWith(';')) why.add(`实体 ${m[0]}`);
  }
  let i = 0;
  let first = true;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) {
        why.add('注释没有结束');
        break;
      }
      i = end + 3;
      first = false;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      const pi = end < 0 ? text.slice(i) : text.slice(i, end + 2);
      // 只许文件开头的 <?xml version=… encoding="utf-8"?> 声明
      const decl = /^<\?xml\s+version="1\.[01]"(\s+encoding="utf-8")?(\s+standalone="(yes|no)")?\s*\?>$/i.test(pi);
      if (!(first && text.slice(0, i).trim() === '' && decl)) why.add(`处理指令 ${pi.slice(0, 30)}`);
      if (end < 0) break;
      i = end + 2;
      first = false;
      continue;
    }
    first = false;
    if (text.startsWith('<!', i)) {
      why.add(/^<!doctype/i.test(text.slice(i, i + 9)) ? '<!DOCTYPE' : /^<!\[CDATA\[/.test(text.slice(i, i + 9)) ? 'CDATA' : `<! 写法 ${text.slice(i, i + 12)}`);
      i += 2;
      continue;
    }
    const close = text[i + 1] === '/';
    let j = close ? i + 2 : i + 1;
    const nm = /^[^\s/>]+/.exec(text.slice(j));
    if (!nm) {
      why.add('认不出的 <');
      i += 1;
      continue;
    }
    const name = nm[0];
    j += name.length;
    if (name.includes(':')) why.add(`带前缀的元素（${name}）`);
    else if (!SVG_ELEMENTS.has(name)) why.add(`不在白名单里的元素（${name}）`);
    // 属性：名字 = "值" 或 '值'，值里的 > 不算结束
    for (;;) {
      while (j < n && /\s/.test(text[j])) j++;
      if (text.startsWith('/>', j)) {
        j += 2;
        break;
      }
      if (text[j] === '>') {
        j += 1;
        break;
      }
      if (close || j >= n) {
        why.add(`标签写法不对（${name}）`);
        j = n;
        break;
      }
      const an = /^[^\s=/>]+/.exec(text.slice(j));
      if (!an) {
        why.add(`属性写法不对（${name}）`);
        j = n;
        break;
      }
      j += an[0].length;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== '=') {
        why.add(`属性没有值（${an[0]}）`);
        j = n;
        break;
      }
      j++;
      while (j < n && /\s/.test(text[j])) j++;
      const q = text[j];
      if (q !== '"' && q !== "'") {
        why.add(`属性值没带引号（${an[0]}）`);
        j = n;
        break;
      }
      const endQ = text.indexOf(q, j + 1);
      if (endQ < 0) {
        why.add(`属性值没有结束（${an[0]}）`);
        j = n;
        break;
      }
      checkAttr(an[0], text.slice(j + 1, endQ), why);
      j = endQ + 1;
    }
    i = j;
  }
  return [...why];
}

/** 安装包里允许的页面（相对 app/）→ 用哪套 CSP；required = 必须存在 */
export const PAGES = {
  'index.html': { page: 'main', required: true },
  'auth/index.html': { page: 'auth', required: true },
  'desktop/quick-add.html': { page: 'quick-add', required: false },
};

/** 各页面的 meta CSP */
export function pageCsp(envName, page) {
  const e = ENVS[envName];
  if (!e) throw new Error(`未知环境 ${envName}`);
  if (page === 'quick-add') {
    // 打字框只走 IPC：不连网络、不嵌任何 iframe、不加载外部脚本（X-1）
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self' ipc: http://ipc.localhost",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
  }
  if (page !== 'main' && page !== 'auth') throw new Error(`未知页面 ${page}`);
  // auth 页只放行 Turnstile 这一个第三方脚本来源：它和页面同在一个 JS 环境，能直接调 session_set、auth_done（外壳审查已接受的取舍）。
  // 以后 auth 页不得再加其他第三方脚本来源（B6-exe 安全审查建议 5；stage-web.test.mjs 钉住）
  const turnstile = page === 'auth';
  return [
    "default-src 'self'",
    turnstile ? "script-src 'self' https://challenges.cloudflare.com" : "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self' blob: data:",
    "worker-src 'self' blob:",
    `connect-src 'self' ipc: http://ipc.localhost ${e.origin} ${e.ws}`,
    turnstile ? "frame-src 'self' https://challenges.cloudflare.com" : "frame-src 'self' https://view.officeapps.live.com",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** 把 meta CSP 插到 <meta charset> 后面（必须在任何脚本、样式之前） */
export function injectCsp(html, csp) {
  if (/http-equiv=["']?Content-Security-Policy/i.test(html)) throw new Error('页面里已经有 meta CSP，不重复注入');
  const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  const bad = inline.filter((s) => !/type=["']?(application\/(ld\+)?json|importmap)/i.test(s) && s.replace(/<\/?script[^>]*>/gi, '').trim());
  if (bad.length) throw new Error(`页面里有 ${bad.length} 段内联脚本，严格 CSP 下会被拦`);
  const m = html.match(/<meta\s+charset=[^>]*>/i);
  if (!m) throw new Error('页面里找不到 <meta charset>');
  const tag = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
  return html.replace(m[0], `${m[0]}\n    ${tag}`);
}

/**
 * 给暂存目录里的页面定 CSP：htmlPaths 是相对 app/ 的 .html 路径（分隔符用 /）。
 * 返回 [路径, 页面名] 列表；名单以外的页面、缺了必须有的页面都抛错（X-1）
 */
export function planPages(htmlPaths) {
  const unknown = htmlPaths.filter((p) => !Object.hasOwn(PAGES, p));
  if (unknown.length) throw new Error(`名单以外的页面不能进安装包：${unknown.join('、')}（要么加进 PAGES 并定 CSP，要么加进 SKIP）`);
  const missing = Object.entries(PAGES)
    .filter(([p, v]) => v.required && !htmlPaths.includes(p))
    .map(([p]) => p);
  if (missing.length) throw new Error(`缺必须有的页面：${missing.join('、')}`);
  return htmlPaths.map((p) => [p, PAGES[p].page]);
}

/** --skip-env-check 能不能用：CI 或 GITHUB_ACTIONS 有值（不论什么值，空串除外）就不行（X-4、M4） */
export function skipAllowed(env) {
  return ['CI', 'GITHUB_ACTIONS'].every((k) => env[k] === undefined || env[k] === '');
}

/** desktop-env.json 的内容 */
export function envMarker(envName, skipped) {
  return { env: envName, envCheck: skipped ? 'skipped' : 'passed' };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (root, p) => relative(root, p).replaceAll('\\', '/');

/** 核对产物里编进去的接口地址：返回 null 表示对得上，否则返回原因 */
export function checkBundleEnv(envName, texts) {
  const e = ENVS[envName];
  const all = texts.join('\n');
  for (const f of e.forbidden) if (f.re.test(all)) return `${envName} 包的产物里出现了${f.why}`;
  if (!all.includes(e.origin)) return `产物里找不到这套环境的接口地址 ${e.origin}（构建时 VITE_PUBLIC_SUPABASE_URL 配错了？）`;
  return null;
}

function main(argv) {
  const envIdx = argv.indexOf('--env');
  const envName = envIdx >= 0 ? argv[envIdx + 1] : undefined;
  const skipCheck = argv.includes(SKIP_ENV_CHECK);
  if (!envName || !Object.hasOwn(ENVS, envName)) {
    console.error(`用法：node desktop/src-tauri/scripts/stage-web.mjs --env production|preview [${SKIP_ENV_CHECK}]`);
    process.exit(2);
  }
  if (skipCheck && !skipAllowed(process.env)) {
    console.error(`CI 环境里不许用 ${SKIP_ENV_CHECK}（安全审查 X-4、代码审查 M4）`);
    process.exit(2);
  }
  if (!existsSync(join(DIST, 'index.html')) || !existsSync(join(DIST, 'auth', 'index.html'))) {
    console.error(`找不到网页产物：${DIST}（先跑网页构建）`);
    process.exit(1);
  }

  const js = walk(DIST).filter((p) => p.endsWith('.js') && !skipped(rel(DIST, p)));
  const why = checkBundleEnv(envName, js.map((p) => readFileSync(p, 'utf8')));
  if (why) {
    if (!skipCheck) {
      console.error(`环境核对失败：${why}`);
      process.exit(1);
    }
    console.warn(`【只限本地冒烟】跳过环境核对：${why}`);
  }

  rmSync(STAGE_ROOT, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  cpSync(DIST, STAGE, { recursive: true, filter: (src) => !skipped(rel(DIST, src)) });

  const staged = walk(STAGE);
  const files = staged.map((p) => rel(STAGE, p));
  const html = files.filter(isPageFile);
  let plan;
  try {
    const bad = checkFileTypes(files);
    for (const p of staged) {
      const r = rel(STAGE, p);
      const bytes = readFileSync(p);
      const m = checkMagic(r, bytes) ?? checkJsonAsset(r, bytes) ?? checkTextAsset(r, bytes);
      if (m) bad.push(m);
      if (extOf(r) === '.svg') {
        const why = checkSvg(bytes);
        if (why.length) bad.push(`${r}（SVG：${why.join('、')}）`);
      }
    }
    if (bad.length) throw new Error(`这些文件不能进安装包：${bad.join('；')}（X-S7、F5-3、F5-6）`);
    plan = planPages(html);
  } catch (e) {
    rmSync(STAGE_ROOT, { recursive: true, force: true });
    console.error(`暂存失败：${e.message}`);
    process.exit(1);
  }
  for (const [file, page] of plan) {
    const p = join(STAGE, file);
    writeFileSync(p, injectCsp(readFileSync(p, 'utf8'), pageCsp(envName, page)));
  }
  writeFileSync(join(STAGE, 'desktop-env.json'), `${JSON.stringify(envMarker(envName, skipCheck && why !== null))}\n`);

  const n = walk(STAGE).length;
  console.log(`已暂存 ${envName}：${n} 个文件 → ${rel(REPO, STAGE)}（不带 ${[...SKIP, ...[...SKIP_EXT].map((e) => `*${e}`)].join('、')}；已注入 meta CSP：${plan.map(([f, p]) => `${f}=${p}`).join('，')}）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
