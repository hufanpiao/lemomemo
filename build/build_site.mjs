// 官网静态页的构建和检查（架构 8.1、16.2）。
//
// 用法：
//   node build/build_site.mjs                     # 检查 site/，再复制到 dist/web 根目录（npm run build:site）
//   node build/build_site.mjs --mode preview      # 预览环境：robots.txt 换成整站禁止（production 以外的模式都这样）
//   node build/build_site.mjs --check             # 只检查，不输出
//   node build/build_site.mjs --out <目录>
//
// 做的事：
// 1. site/ 原样复制到 dist/web/；脚本、样式、og 图改成带哈希的文件名放进 /s/（_headers 给 /s/* 设 immutable），
//    HTML 里的引用跟着改；
// 2. 检查：首页里不能出现 supabase 和 /sb/；中韩页面成对；每页有 title、description、og、canonical、hreflang；
//    没有内联脚本和样式；_routes.json 只让 /、/files/* 和 /sb/* 进 Functions；_headers 里官网的 CSP 和 Pages Function 里的一字不差；
//    根目录有 404.html（Pages 的静态 404：noindex、中韩两段、去两个首页的链接、引用写绝对路径；0.31 第 31 条）；
//    没有 site/errors/ 和 _headers 的 /errors/* 段（Cloudflare 自定义错误页免费版不能用，0.31 第 31 条删掉）；
//    输出不覆盖 dist/web/app/ 下 Vite 的产物。
// 3. _headers 不原样复制：和 src/_headers（/app/* 那几段）一起由 build/assemble_web.mjs 的 writeHeaders 拼好再写，
//    所以单独跑本脚本、或在 npm run build 前后跑，dist/web/_headers 都是完整的两段（B0 集成）。
//    npm run build（build_web.mjs）里已经调了本脚本的 buildSite，部署前不用再单独跑。
// 需要 Node 22.18 以上（直接 import .ts，读 Functions 里的 CSP 常量）。

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

/** 改成带哈希文件名的资源（site/ 下的相对路径） */
const HASHED = ['lp.js', 'lang.js', 'site.css', 'og-zh.png', 'og-ko.png'];
const ORIGIN = 'https://lemomemo.com';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const rel = (p) => relative(SITE, p).split(sep).join('/');

// ---------- 检查 ----------

export async function checkSite(siteDir = SITE) {
  const errors = [];
  const files = walk(siteDir).map((p) => relative(siteDir, p).split(sep).join('/'));

  // 首页里不能出现 supabase、/sb/（16.2）：HTML、JS、CSS 都查；_routes.json、_headers、robots.txt 本来就要写 /sb/
  for (const f of files.filter((x) => /\.(html|js|css)$/.test(x))) {
    const text = readFileSync(join(siteDir, f), 'utf8');
    if (/supabase/i.test(text)) errors.push(`${f}：出现了 supabase`);
    if (text.includes('/sb/')) errors.push(`${f}：出现了 /sb/`);
  }

  // 两种语言的页面成对
  const pages = files.filter((f) => /^(zh|ko)\/[^/]+\.html$/.test(f));
  for (const f of pages) {
    const other = f.startsWith('zh/') ? 'ko/' + f.slice(3) : 'zh/' + f.slice(3);
    if (!files.includes(other)) errors.push(`${f}：缺少成对的 ${other}`);
  }
  if (!files.includes('zh/index.html') || !files.includes('ko/index.html')) errors.push('缺少 zh/index.html 或 ko/index.html');

  // 每页的 SEO 基本项和 CSP 约束
  for (const f of pages) {
    const html = readFileSync(join(siteDir, f), 'utf8');
    const lang = f.startsWith('zh/') ? 'zh-Hans' : 'ko';
    const need = [
      [new RegExp(`<html lang="${lang}">`), `<html lang="${lang}">`],
      [/<title>[^<]+<\/title>/, 'title'],
      [/<meta name="description" content="[^"]+">/, 'description'],
      [/<meta property="og:title" content="[^"]+">/, 'og:title'],
      [/<meta property="og:description" content="[^"]+">/, 'og:description'],
      [/<meta property="og:image" content="https:\/\/lemomemo\.com\/og-(zh|ko)\.png">/, 'og:image'],
      [/<meta property="og:url" content="https:\/\/lemomemo\.com\/[^"]*">/, 'og:url'],
      [/<meta name="twitter:card" content="summary_large_image">/, 'twitter:card'],
      [/<link rel="canonical" href="https:\/\/lemomemo\.com\/[^"]*">/, 'canonical'],
      [/<link rel="alternate" hreflang="zh-Hans" href="[^"]+">/, 'hreflang zh-Hans'],
      [/<link rel="alternate" hreflang="ko" href="[^"]+">/, 'hreflang ko'],
      [/<link rel="alternate" hreflang="x-default" href="[^"]+">/, 'hreflang x-default'],
    ];
    for (const [re, name] of need) if (!re.test(html)) errors.push(`${f}：缺少 ${name}`);
    const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];
    const ogUrl = /<meta property="og:url" content="([^"]+)">/.exec(html)?.[1];
    const expect = ORIGIN + '/' + f.replace(/index\.html$/, '').replace(/\.html$/, '');
    if (canonical !== expect) errors.push(`${f}：canonical 应该是 ${expect}`);
    if (ogUrl !== expect) errors.push(`${f}：og:url 应该是 ${expect}`);
    if (f.endsWith('index.html') && !html.includes(`hreflang="x-default" href="${ORIGIN}/"`)) errors.push(`${f}：首页的 x-default 应指向 /`);
    if (!/<a [^>]*data-lang="zh"/.test(html) || !/<a [^>]*data-lang="ko"/.test(html)) errors.push(`${f}：页脚缺少语言切换`);
  }

  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(join(siteDir, f), 'utf8');
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) errors.push(`${f}：有内联脚本`);
    if (/<style[\s>]/i.test(html)) errors.push(`${f}：有内联 <style>`);
    if (/\sstyle=/i.test(html)) errors.push(`${f}：有 style 属性`);
    if (/\son[a-z]+=/i.test(html)) errors.push(`${f}：有 on* 事件属性`);
    if (/<form[\s>]/i.test(html)) errors.push(`${f}：首页不收集任何信息，不能有表单`);
    if (/\s(src|href)="https?:\/\/(?!lemomemo\.com\/)/i.test(html)) errors.push(`${f}：引用了外部资源`);
  }

  // 首页才带 lp.js（隐私说明、条款页不跳）
  for (const f of ['zh/index.html', 'ko/index.html']) {
    if (files.includes(f) && !readFileSync(join(siteDir, f), 'utf8').includes('<script src="/lp.js"></script>')) errors.push(`${f}：缺少 /lp.js`);
  }

  // Pages 的静态 404（0.31 第 31 条）：产物根目录必须有 404.html。它在任意路径下返回，相对引用会指错，所以一律写绝对路径；
  // 请求路径匹配不到 _headers 的任何一段（没有 CSP），所以只许引样式表，不许有脚本（上面的通用检查管内联，这里连外链脚本也不许）
  if (!files.includes('404.html')) {
    errors.push('缺少 404.html（Pages 找不到文件时用它；没有的话 Pages 会把所有找不到的路径当单页应用回首页）');
  } else {
    const html = readFileSync(join(siteDir, '404.html'), 'utf8');
    if (!/<meta name="robots" content="noindex">/.test(html)) errors.push('404.html：缺少 <meta name="robots" content="noindex">');
    if (!/<title>[^<]+<\/title>/.test(html)) errors.push('404.html：缺少 title');
    if (!/<html lang="zh-Hans">/.test(html) || !/<[a-z0-9]+ lang="ko"/.test(html)) errors.push('404.html：要中韩两段（<html lang="zh-Hans"> 和 lang="ko" 的段落）');
    if (!html.includes('href="/zh/"') || !html.includes('href="/ko/"')) errors.push('404.html：要有去 /zh/ 和 /ko/ 的链接');
    if (/<script[\s>]/i.test(html)) errors.push('404.html：不能有脚本（404 的响应不带 CSP）');
    for (const m of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
      const u = m[1] ?? '';
      if (!/^(\/|#|https:\/\/lemomemo\.com\/)/.test(u)) errors.push(`404.html：引用要写绝对路径：${u}`);
    }
  }
  if (files.some((f) => f.startsWith('errors/'))) errors.push('site/errors/ 要删掉：Cloudflare 自定义错误页免费版不能用，放着会让人以为它生效（0.31 第 31 条）');

  // _routes.json 只让 /、/files/*（0.32 起照片和附件）和 /sb/* 进 Functions（14.2 第 7 点）
  try {
    const routes = JSON.parse(readFileSync(join(siteDir, '_routes.json'), 'utf8'));
    const inc = JSON.stringify([...(routes.include ?? [])].sort());
    if (routes.version !== 1 || inc !== JSON.stringify(['/', '/files/*', '/sb/*']) || (routes.exclude ?? []).length !== 0) {
      errors.push('_routes.json：include 只能是 ["/", "/files/*", "/sb/*"]，exclude 为空');
    }
  } catch {
    errors.push('_routes.json：缺少或不是合法 JSON');
  }

  // _headers 里官网的 CSP 和 Functions 的一字不差
  const { SITE_CSP } = await import('../functions/_lib/security-headers.ts');
  const headers = readFileSync(join(siteDir, '_headers'), 'utf8');
  for (const block of ['/zh/*', '/ko/*']) {
    const m = new RegExp(`^${block.replace(/[/*]/g, (c) => '\\' + c)}\\r?\\n((?:[ \\t]+.*\\r?\\n?)*)`, 'm').exec(headers);
    const csp = m ? /Content-Security-Policy:\s*(.+)/.exec(m[1])?.[1]?.trim() : undefined;
    if (csp !== SITE_CSP) errors.push(`_headers ${block}：CSP 和 functions/_lib/security-headers.ts 不一致`);
  }
  if (/^\/\*\s*$/m.test(headers)) errors.push('_headers：不要写 /* 全站规则（会和 /app/* 的头拼在一起）');
  if (/^\/errors\//m.test(headers)) errors.push('_headers：/errors/* 一段要删掉（0.31 第 31 条）');

  return errors;
}

// ---------- 构建 ----------

function hashName(name, buf) {
  const h = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const dot = name.lastIndexOf('.');
  return `s/${name.slice(0, dot)}.${h}${name.slice(dot)}`;
}

export function buildSite({ out, mode }) {
  const map = new Map();
  // 旧的带哈希文件不留（/s/ 只放官网的资源）
  rmSync(join(out, 's'), { recursive: true, force: true });
  for (const name of HASHED) map.set(name, hashName(name, readFileSync(join(SITE, name))));

  for (const abs of walk(SITE)) {
    const f = rel(abs);
    if (f.startsWith('app/')) throw new Error(`site/${f}：site/ 里不能有 app/，那是 Vite 的输出`);
    if (f === '_headers') continue;   // 由 writeHeaders 和 src/_headers 拼好再写
    let target = map.get(f) ?? f;
    const dest = join(out, ...target.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    if (f.endsWith('.html')) {
      let html = readFileSync(abs, 'utf8');
      for (const [from, to] of map) {
        // 只改属性值里的引用：src="/lp.js"、href="/site.css"、content="https://lemomemo.com/og-zh.png"
        const re = new RegExp(`(["'])((?:${ORIGIN.replace(/[.]/g, '\\.')})?)/${from.replace(/[.]/g, '\\.')}(["'])`, 'g');
        html = html.replace(re, `$1$2/${to}$3`);
      }
      writeFileSync(dest, html);
    } else if (f === 'robots.txt' && mode === 'preview') {
      writeFileSync(dest, '# 预览环境：整站不给搜索引擎收录\nUser-agent: *\nDisallow: /\n');
    } else {
      cpSync(abs, dest);
    }
  }
  return map;
}

// ---------- 命令行 ----------

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const errors = await checkSite();
  if (errors.length) {
    console.error('官网检查没通过：');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log('官网检查通过');
  if (args.includes('--check')) return;
  const mode = opt('--mode', 'production');
  const { MODES, writeHeaders } = await import('./assemble_web.mjs');
  if (!MODES.includes(mode)) throw new Error(`--mode 只能是 ${MODES.join('、')}`);
  const out = resolve(ROOT, opt('--out', 'dist/web'));
  if (!existsSync(out)) mkdirSync(out, { recursive: true });
  const map = buildSite({ out, mode: mode === 'production' ? 'production' : 'preview' });
  writeHeaders({ root: ROOT, mode, out });
  console.log(`已复制到 ${relative(ROOT, out) || '.'}（${mode}），带哈希的资源：`);
  for (const [from, to] of map) console.log(`  ${from} → ${to}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
