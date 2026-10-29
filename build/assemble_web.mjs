// 拼出 dist/web（架构 8.1、16.2）：
// - 官网：调 build/build_site.mjs 的 buildSite（先检查，再把 site/ 复制到 dist/web/ 根目录，脚本、样式、og 图改成带哈希的 /s/ 文件名）
// - _headers = site/_headers（首页那几段，前端 B）+ src/_headers（/app/* 那几段，前端 A），{{WSS}} 按模式替换
//   e2e-real（真后端那组 e2e）：前端和 /sb 同源，由 8789 端口的服务一起提供；http 那一项 'self' 已经覆盖，connect-src 只加 ws://127.0.0.1:8789
//   build_web.mjs 和 build_site.mjs 都用这里的 writeHeaders 写 _headers：谁先谁后、只跑哪一个，结果都一样，互不覆盖对方的段
// - dist/web/app/version.json（LEMO_BUILD_VERSION 优先，否则 VERSION 文件）
// 输出目录默认 dist/web；LEMO_WEB_OUT 可改成 dist/web-<名字>（webOutDir，真后端那组 e2e 写 dist/web-real，和无后端组互不覆盖），正式、预览构建不许改
// ws 端口：本机模式默认 8788（e2e-real 8789），LEMO_WS_PORT 可改（wsOrigin）；正式、预览写死
// 输出目录的分工：Vite 只写 dist/web/app/（emptyOutDir 只清它）；官网只写 dist/web/ 根上 site/ 里有的文件和 /s/；_headers 两边共用
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 正式和预览的 ws 地址写死，不看任何环境变量
const WSS_FIXED = {
  production: 'wss://lemomemo.com',
  preview: 'wss://preview.lemomemo.com',
};
// 本机几种模式的 ws 端口：默认值如下；LEMO_WS_PORT 给了就用它（跑在别的端口的 e2e，比如 8790，CSP 跟着走）
const WS_LOCAL_PORT = {
  e2e: 8788,
  'e2e-real': 8789,
  development: 8788,
  test: 8788,
};

export const MODES = ['production', 'preview', 'e2e', 'e2e-real', 'development', 'test'];

/**
 * connect-src 里那一项 ws 地址（替换 _headers 的 {{WSS}}）：
 * - production、preview：写死，LEMO_WS_PORT 不起作用；
 * - e2e、e2e-real、development、test：ws://127.0.0.1:端口，端口取 LEMO_WS_PORT（1024–65535 的整数），没给用上面的默认值。
 * @param {string} mode
 * @param {Record<string, string | undefined>} env
 */
export function wsOrigin(mode, env = process.env) {
  if (Object.hasOwn(WSS_FIXED, mode)) return WSS_FIXED[mode];
  if (!Object.hasOwn(WS_LOCAL_PORT, mode)) throw new Error(`未知的构建模式：${mode}`);
  const raw = env.LEMO_WS_PORT?.trim();
  if (!raw) return `ws://127.0.0.1:${WS_LOCAL_PORT[mode]}`;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1024 && port <= 65535)) throw new Error(`LEMO_WS_PORT=${raw} 不是 1024–65535 的端口号`);
  return `ws://127.0.0.1:${port}`;
}

/** 网页产物的默认输出目录（正式构建、CI、publish.ps1 都认这里） */
export const WEB_OUT_DEFAULT = 'dist/web';

/**
 * 网页产物的输出目录（vite.config.ts、vite.sw.config.ts、build_web.mjs、assembleWeb 共用）：
 * LEMO_WEB_OUT 没给就是 dist/web；给了只许 dist/web-<小写字母数字>（如 dist/web-real，真后端那组 e2e 用），别的写法一律抛错
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 */
export function webOutDir(root, env = process.env) {
  const raw = env.LEMO_WEB_OUT?.trim();
  if (!raw) return resolve(root, WEB_OUT_DEFAULT);
  const rel = raw.replaceAll('\\', '/');
  if (rel !== WEB_OUT_DEFAULT && !/^dist\/web-[a-z0-9]+$/.test(rel)) {
    throw new Error(`LEMO_WEB_OUT=${raw} 不对：只许 dist/web 或 dist/web-<小写字母数字>（相对仓库根目录）`);
  }
  return resolve(root, rel);
}

/** e2e-real 构建必须由调用方给的公开配置（构建脚本不写死；值来自本机真后端，先跑 npm run e2e:real:up 再取 env） */
export const E2E_REAL_ENV = ['VITE_PUBLIC_SUPABASE_URL', 'VITE_PUBLIC_ANON_KEY'];

/** 本机地址的主机名（URL.hostname 已转小写；IPv6 带方括号） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 构建前检查环境变量（build_web.mjs 在 vite build 之前调）：
 * - e2e-real：两个公开配置缺哪个就报哪个；
 * - production：VITE_PUBLIC_SUPABASE_URL 不准指向本机（防止 e2e-real 的环境变量漏进正式构建）；没给或缺别的由 vite.config.ts 报；
 * - production、preview：不许把 LEMO_WEB_OUT 设成 dist/web 以外的目录（发布和 CI 只认 dist/web）；
 * - 其他模式不检查。
 * @param {string} mode
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function buildEnvErrors(mode, env = process.env) {
  const out = env.LEMO_WEB_OUT?.trim().replaceAll('\\', '/');
  if ((mode === 'production' || mode === 'preview') && out && out !== WEB_OUT_DEFAULT) {
    return [`${mode} 构建不许设 LEMO_WEB_OUT（现在是 ${env.LEMO_WEB_OUT}）：发布和 CI 只认 dist/web；先清掉这个变量再构建`];
  }
  if (mode === 'production') {
    const raw = env.VITE_PUBLIC_SUPABASE_URL?.trim();
    if (!raw) return [];
    let host;
    try {
      host = new URL(raw).hostname;
    } catch {
      return [`production 构建的 VITE_PUBLIC_SUPABASE_URL 不是合法网址：${raw}`];
    }
    if (LOOPBACK_HOSTS.has(host)) {
      return [`production 构建的 VITE_PUBLIC_SUPABASE_URL 指向本机（${host}）：多半是 e2e-real 的环境变量漏进来了，正式版必须用 https://lemomemo.com/sb；先清掉这个变量再构建`];
    }
    return [];
  }
  if (mode !== 'e2e-real') return [];
  const missing = E2E_REAL_ENV.filter((k) => !env[k]?.trim());
  if (!missing.length) return [];
  return [`e2e-real 构建缺少 ${missing.join('、')}：先跑 npm run e2e:real:up，再按它输出的 env 设好这两个变量后重新构建`];
}

/**
 * 解析 _headers：[{ path, lines: ['Header: value', '! Header'] }]
 * @param {string} text
 * @returns {{ path: string, lines: string[] }[]}
 */
export function parseHeaders(text) {
  /** @type {{ path: string, lines: string[] }[]} */
  const blocks = [];
  /** @type {{ path: string, lines: string[] } | null} */
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    if (/^\s/.test(raw)) {
      if (!cur) throw new Error(`_headers：头没有挂在路径下面：${raw.trim()}`);
      cur.lines.push(raw.trim());
    } else {
      cur = { path: raw.trim(), lines: [] };
      blocks.push(cur);
    }
  }
  return blocks;
}

/** 规则 a 的路径会不会命中规则 b 的路径（只处理本项目用到的写法：精确路径和结尾 /*） */
function covers(a, b) {
  if (a === b) return true;
  if (a.endsWith('/*')) return b.startsWith(a.slice(0, -1));
  return false;
}

/**
 * 同一个地址命中的多条规则里，Content-Security-Policy 只能有一条生效（Cloudflare 会把同名头用逗号拼起来，两个 CSP 取交集）：
 * 更具体的那条必须先写 “! Content-Security-Policy” 去掉宽的那条再写自己的。不准写 /* 全站规则。
 */
export function checkHeaders(text) {
  const errors = [];
  const blocks = parseHeaders(text);
  const seen = new Set();
  for (const b of blocks) {
    if (b.path === '/*') errors.push('_headers：不要写 /* 全站规则（会和每一段的头拼在一起）');
    if (seen.has(b.path)) errors.push(`_headers：路径 ${b.path} 写了两段`);
    seen.add(b.path);
    const csp = b.lines.filter((l) => /^content-security-policy\s*:/i.test(l));
    if (csp.length > 1) errors.push(`_headers：${b.path} 写了 ${csp.length} 条 CSP`);
  }
  for (const wide of blocks) {
    if (!wide.lines.some((l) => /^content-security-policy\s*:/i.test(l))) continue;
    for (const narrow of blocks) {
      if (narrow === wide || !covers(wide.path, narrow.path)) continue;
      const setsCsp = narrow.lines.some((l) => /^content-security-policy\s*:/i.test(l));
      const detaches = narrow.lines.some((l) => /^!\s*content-security-policy$/i.test(l));
      if (setsCsp && !detaches) errors.push(`_headers：${narrow.path} 也被 ${wide.path} 命中，两条 CSP 会叠在一起；先写 “! Content-Security-Policy”`);
    }
  }
  return errors;
}

/**
 * 架构 0.31 第 7 条：site/_headers（官网）和 src/_headers（/app/*）两段的路径互不命中。
 * 重叠时 Cloudflare 会把两边的同名头用逗号拼起来，谁也管不住谁，所以构建直接失败。
 */
export function overlapErrors(siteBlocks, appBlocks) {
  const errors = [];
  for (const s of siteBlocks) {
    for (const a of appBlocks) {
      if (covers(s.path, a.path) || covers(a.path, s.path)) {
        errors.push(`_headers：官网那段的 ${s.path} 和 /app 那段的 ${a.path} 重叠（0.31 第 7 条：两段路径不准重叠）`);
      }
    }
  }
  return errors;
}

export function renderHeaders(appHeaders, siteHeaders, mode, env = process.env) {
  const wss = wsOrigin(mode, env);
  const app = appHeaders.replaceAll('{{WSS}}', wss);
  if (app.includes('{{')) throw new Error('_headers 里还有没替换的占位符');
  const overlap = overlapErrors(parseHeaders(siteHeaders), parseHeaders(app));
  if (overlap.length) throw new Error(overlap.join('\n'));
  const text = siteHeaders ? `${siteHeaders.trimEnd()}\n\n${app}` : app;
  const errors = checkHeaders(text);
  if (errors.length) throw new Error(errors.join('\n'));
  return text;
}

/** 把两段 _headers 拼好写到 out/_headers（两个构建脚本共用） */
export function writeHeaders({ root, mode, out = webOutDir(root) }) {
  const siteHeadersPath = resolve(root, 'site/_headers');
  const siteHeaders = existsSync(siteHeadersPath) ? readFileSync(siteHeadersPath, 'utf8') : '';
  const appHeaders = readFileSync(resolve(root, 'src/_headers'), 'utf8');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, '_headers'), renderHeaders(appHeaders, siteHeaders, mode));
}

/** 版本号：LEMO_BUILD_VERSION（deploy-preview 给的 X.Y.Z-preview.N）优先，否则 VERSION 文件；前三段必须和 VERSION 一致 */
export function buildVersion(root, env = process.env) {
  const base = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
  const v = env.LEMO_BUILD_VERSION?.trim();
  if (!v) return base;
  if (!/^\d+\.\d+\.\d+(-preview\.\d+)?$/.test(v) || v.split('-')[0] !== base) {
    throw new Error(`LEMO_BUILD_VERSION=${v} 不是 ${base} 或 ${base}-preview.N`);
  }
  return v;
}

export async function assembleWeb({ root, mode, out = webOutDir(root) }) {
  const web = out;
  if (existsSync(resolve(root, 'site'))) {
    const { buildSite, checkSite } = await import('./build_site.mjs');
    const errors = await checkSite();
    if (errors.length) throw new Error(`官网检查没通过：\n  ${errors.join('\n  ')}`);
    buildSite({ out: web, mode: mode === 'production' ? 'production' : 'preview' });
  }
  writeHeaders({ root, mode, out: web });
  writeFileSync(resolve(web, 'app/version.json'), `${JSON.stringify({ version: buildVersion(root) })}\n`);
}
