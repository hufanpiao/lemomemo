// 拼出 dist/web（架构 8.1、16.2）：
// - 官网：调 build/build_site.mjs 的 buildSite（先检查，再把 site/ 复制到 dist/web/ 根目录，脚本、样式、og 图改成带哈希的 /s/ 文件名）
// - _headers = site/_headers（首页那几段，前端 B）+ src/_headers（/app/* 那几段，前端 A），{{WSS}} 按模式替换
//   build_web.mjs 和 build_site.mjs 都用这里的 writeHeaders 写 _headers：谁先谁后、只跑哪一个，结果都一样，互不覆盖对方的段
// - dist/web/app/version.json（LEMO_BUILD_VERSION 优先，否则 VERSION 文件）
// 输出目录的分工：Vite 只写 dist/web/app/（emptyOutDir 只清它）；官网只写 dist/web/ 根上 site/ 里有的文件和 /s/；_headers 两边共用
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WSS = {
  production: 'wss://lemomemo.com',
  preview: 'wss://preview.lemomemo.com',
  e2e: 'ws://127.0.0.1:8788',
  development: 'ws://127.0.0.1:8788',
  test: 'ws://127.0.0.1:8788',
};

export const MODES = Object.keys(WSS);

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

export function renderHeaders(appHeaders, siteHeaders, mode) {
  const wss = WSS[mode];
  if (!wss) throw new Error(`未知的构建模式：${mode}`);
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
export function writeHeaders({ root, mode, out = resolve(root, 'dist/web') }) {
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

export async function assembleWeb({ root, mode }) {
  const web = resolve(root, 'dist/web');
  if (existsSync(resolve(root, 'site'))) {
    const { buildSite, checkSite } = await import('./build_site.mjs');
    const errors = await checkSite();
    if (errors.length) throw new Error(`官网检查没通过：\n  ${errors.join('\n  ')}`);
    buildSite({ out: web, mode: mode === 'production' ? 'production' : 'preview' });
  }
  writeHeaders({ root, mode, out: web });
  writeFileSync(resolve(web, 'app/version.json'), `${JSON.stringify({ version: buildVersion(root) })}\n`);
}
