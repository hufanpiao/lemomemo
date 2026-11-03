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
//      不复制 SKIP 里的文件：sw.js（exe 不注册 Service Worker，更新走 updater）、preview.html（网页版的开发预览页）；
//   2. 核对产物编进去的接口地址属于这次的环境（两个方向都查：正式包里不能有预览地址，预览包里不能有正式地址）；
//   3. 暂存目录里的每个 .html 都按 PAGES 名单注入按环境区分的严格 meta CSP（和全局 CSP 取交集），
//      名单以外的 .html 直接失败（X-1）；main、auth 两页必须有，quick-add 页有就注入（页面入口加进 vite.config.ts 之前没有）；
//   4. 写 app/desktop-env.json（{ env, envCheck: "passed" | "skipped" }），Rust 启动时核对（lib.rs check_env）。
// 页面里有内联 <script> 时直接失败（严格 CSP 下会被拦，宁可构建时报错）。

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

/** 不进安装包的文件（相对 app/） */
export const SKIP = new Set(['sw.js', 'sw.js.map', 'preview.html']);

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

  const js = walk(DIST).filter((p) => p.endsWith('.js') && !SKIP.has(rel(DIST, p)));
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
  cpSync(DIST, STAGE, { recursive: true, filter: (src) => !SKIP.has(rel(DIST, src)) });

  const html = walk(STAGE)
    .filter((p) => p.toLowerCase().endsWith('.html') || p.toLowerCase().endsWith('.htm'))
    .map((p) => rel(STAGE, p));
  let plan;
  try {
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
  console.log(`已暂存 ${envName}：${n} 个文件 → ${rel(REPO, STAGE)}（不带 ${[...SKIP].join('、')}；已注入 meta CSP：${plan.map(([f, p]) => `${f}=${p}`).join('，')}）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
