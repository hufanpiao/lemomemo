// 官网静态页的构建和检查（架构 8.1、16.2）。
//
// 用法：
//   node build/build_site.mjs                     # 检查 site/，再复制到 dist/web 根目录（npm run build:site）
//   node build/build_site.mjs --mode preview      # 预览环境：robots.txt 换成整站禁止（production 以外的模式都这样）
//   node build/build_site.mjs --check             # 只检查，不输出
//   node build/build_site.mjs --out <目录>
//
// 做的事：
// 1. site/ 原样复制到 dist/web/；根目录的脚本、样式、og 图和 site/home/ 下的文件（hashedNames 自动列），
//    加上从仓库别处取的吉祥物 .riv、Rive 运行库和 wasm（SITE_EXTERNAL），改成带哈希的文件名放进 /s/（_headers 给 /s/* 设 immutable），
//    HTML、根目录 CSS 和首页脚本模块之间的 import 里的引用跟着改；HTML 和根目录 CSS 去掉注释再输出；
//    检查里另有：首页不引演示页的脚本样式、演示页不引 lp.js、引用和 import 的文件都在、站内链接的 #锚点在目标页里有、
//    CSS 的 url() 带引号、site/ 里不放 .riv；首页和演示页和 build/site_pages.mjs 生成的一致；
// 2. 检查：首页里不能出现 supabase 和 /sb/；中韩页面成对；每页有 title、description、og、canonical、hreflang；
//    没有内联脚本和样式；_routes.json 只让 /、/files/*、/sb/* 和 /wx/*（今天页天气代理，11-26）进 Functions；
//    _headers 里官网的 CSP 和 Pages Function 里的一字不差（首页 /zh/、/ko/ 是 HOME_CSP，其他页 /zh/:page、/ko/:page 是 SITE_CSP）；
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
import { MASCOTS, PEEK, SITE_MASCOT_IDS } from '../src/features/mascot/data/catalog.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

/** 改成带哈希文件名的资源：site/ 根目录下所有 .js、.css、og-*.png，和 site/home/ 下的文件（首页的静帧图、子集字体）。不手写名单 */
export function hashedNames(siteDir = SITE) {
  const top = readdirSync(siteDir).filter((n) => statSync(join(siteDir, n)).isFile() && (/\.(js|css)$/.test(n) || /^og-[a-z]+\.png$/.test(n)));
  const homeDir = join(siteDir, 'home');
  const home = existsSync(homeDir) ? readdirSync(homeDir).map((n) => `home/${n}`) : [];
  return [...top, ...home].sort();
}

/**
 * 不在 site/ 里、构建时从仓库别处取来带哈希放进 /s/ 的文件：发布名 → 仓库里的路径（页面里写 /发布名，构建时换成 /s/ 下的名字）。
 * 首页的吉祥物只取 catalog.ts 的 SITE_MASCOT_IDS（样机画的 7 只）+ 输入框小人 PEEK；#2 不在目录里，进不了官网；Rive 运行库和 wasm 和 App 用同一份。
 */
export const SITE_EXTERNAL = Object.freeze({
  'rive.js': 'node_modules/@rive-app/canvas/rive.js',
  'rive.wasm': 'node_modules/@rive-app/canvas/rive.wasm',
  ...Object.fromEntries([...SITE_MASCOT_IDS.map((id) => [id, MASCOTS[id]]), ['peek', PEEK]].map(([id, d]) => [`mascot-${id}.riv`, relative(ROOT, fileURLToPath(d.url)).split(sep).join('/')])),
});
const MASCOT_DIR = 'src/features/mascot/assets/';

/** 外部文件上线的内容：.js 去掉末尾的 sourceMappingURL 注释（rive.js 自带一行指向不存在的 rive.js.map，desktop.yml 的 no-source-map 检查不放行）；哈希和写出都用这一份 */
function externalBytes(src) {
  const buf = readFileSync(join(ROOT, src));
  return src.endsWith('.js') ? Buffer.from(buf.toString('utf8').replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, '\n')) : buf;
}
const ORIGIN = 'https://lemomemo.com';

// 引用换成带哈希的地址：只改属性值和 CSS url() 里带引号的整段地址，如 src="/lp.js"、content="https://lemomemo.com/og-zh.png"、url("/home/mi-15.png")
function rewrite(text, map) {
  for (const [from, to] of map) {
    const re = new RegExp(`(["'])((?:${ORIGIN.replace(/[.]/g, '\\.')})?)/${from.replace(/[.]/g, '\\.')}(["'])`, 'g');
    text = text.replace(re, `$1$2/${to}$3`);
  }
  return text;
}

/** 脚本模块 import 的站内文件（首页的模块一律写绝对路径 '/index-kit.js'，构建时换成带哈希的名字） */
const importsOf = (js) => [...js.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*(["'])([^"']+)\1|(?:^|[\s;])import\s*(["'])([^"']+)\3/gm)].map((m) => m[2] ?? m[4] ?? '');

// 上线的文件里不带开发注释（生成说明、lint 豁免理由这类只给写代码的人看）：HTML 去掉 <!-- -->，CSS 去掉 /* */。JS 不动（正则里会有 /* 这类字样）
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->\r?\n?/g, '');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n{3,}/g, '\n\n');

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
    // 会自动加载的外部资源（src=、<link href>）一律不许；外链只许是普通 <a> 链接（首页页尾的素材署名要链到原作和许可）
    if (/\ssrc="https?:\/\/(?!lemomemo\.com\/)/i.test(html) || /<link\b[^>]*\shref="https?:\/\/(?!lemomemo\.com\/)/i.test(html)) errors.push(`${f}：引用了外部资源`);
  }

  // 吉祥物只从 catalog.ts 登记的 src/features/mascot/assets 取（SITE_EXTERNAL），site/ 里不放 .riv；外部来源的文件都要在
  if (files.some((f) => f.endsWith('.riv'))) errors.push('site/ 里不能放 .riv：吉祥物只取 catalog.ts 登记的（build_site.mjs 的 SITE_EXTERNAL）');
  for (const [name, src] of Object.entries(SITE_EXTERNAL)) {
    if (!existsSync(join(ROOT, src))) errors.push(`SITE_EXTERNAL ${name}：仓库里没有 ${src}`);
    if (name.endsWith('.riv') && !src.startsWith(MASCOT_DIR)) errors.push(`SITE_EXTERNAL ${name}：.riv 只能取自 ${MASCOT_DIR}`);
  }

  // 首页才带 lp.js（隐私说明、条款页不跳）
  for (const f of ['zh/index.html', 'ko/index.html']) {
    if (files.includes(f) && !readFileSync(join(siteDir, f), 'utf8').includes('<script src="/lp.js"></script>')) errors.push(`${f}：缺少 /lp.js`);
  }

  // 首页和演示页各下各的：首页不许引演示页的脚本和样式，演示页不许引 lp.js（已登录会被它跳走）；
  // 引用的根目录脚本、样式和 /home/ 下的图片必须真有这个文件（构建时自动换成带哈希的名字）
  const roots = new Set(hashedNames(siteDir));
  for (const f of files.filter((x) => x.endsWith('.html') && !x.startsWith('diag/'))) {
    const html = readFileSync(join(siteDir, f), 'utf8');
    const refs = [...html.matchAll(/\s(?:src|href|data-[a-z]+)="\/([a-z0-9-]+\.(?:js|css|riv|wasm)|home\/[a-z0-9-]+\.[a-z0-9]+)"/g)].map((m) => m[1] ?? '');
    for (const r of refs) if (!roots.has(r) && !Object.hasOwn(SITE_EXTERNAL, r)) errors.push(`${f}：引用的 /${r} 在 site/ 里没有`);
    if (/(^|\/)index\.html$/.test(f) && refs.some((r) => r.startsWith('demo'))) errors.push(`${f}：首页不能引演示页的脚本或样式（${refs.filter((r) => r.startsWith('demo')).join('、')}）`);
    if (f.endsWith('demo.html') && refs.includes('lp.js')) errors.push(`${f}：演示页不能引 /lp.js`);
  }
  // 根目录脚本模块 import 的文件：只许是 site/ 根目录下真有的脚本，写绝对路径（构建时按这个换成带哈希的名字）
  for (const j of files.filter((x) => /^[^/]+\.js$/.test(x))) {
    for (const u of importsOf(readFileSync(join(siteDir, j), 'utf8'))) {
      if (!/^\/[a-z0-9-]+\.js$/.test(u) || !roots.has(u.slice(1))) errors.push(`${j}：import '${u}' 要写成 site/ 根目录下已有脚本的绝对路径（如 '/index-kit.js'）`);
    }
  }
  // 根目录样式里的 url() 只许指向会带哈希的文件（site/home/ 下的图和字体），写绝对路径、带引号（构建时只换带引号的整段地址）
  for (const c of files.filter((x) => /^[^/]+\.css$/.test(x))) {
    for (const m of readFileSync(join(siteDir, c), 'utf8').matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)) {
      const q = m[1] ?? '', u = m[2] ?? '';
      if (u.startsWith('data:')) continue;
      if (!q) errors.push(`${c}：url(${u}) 要带引号（构建时只换带引号的地址）`);
      else if (!(u.startsWith('/') && roots.has(u.slice(1)))) errors.push(`${c}：url(${u}) 要写成 site/home/ 下已有文件的绝对路径`);
    }
  }

  // 站内链接的 #锚点必须在目标页里有：href="#x" 查本页，href="/zh/#x"、"/zh/demo#x" 查那一页
  const ids = new Map();
  const idsOf = (page) => {
    if (!ids.has(page)) ids.set(page, files.includes(page) ? new Set([...readFileSync(join(siteDir, page), 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])) : null);
    return ids.get(page);
  };
  for (const f of files.filter((x) => /^(zh|ko)\/[^/]+\.html$/.test(x) || x === '404.html')) {
    for (const m of readFileSync(join(siteDir, f), 'utf8').matchAll(/\shref="((?:https:\/\/lemomemo\.com)?\/[^"#]*|)#([^"]+)"/g)) {
      const path = (m[1] ?? '').replace(/^https:\/\/lemomemo\.com/, '');
      const page = path === '' ? f : path.endsWith('/') ? `${path.slice(1)}index.html` : `${path.slice(1)}.html`;
      const got = idsOf(page);
      if (!got) errors.push(`${f}：链接 ${path}#${m[2]} 指向的页面 ${page} 在 site/ 里没有`);
      else if (!got.has(m[2])) errors.push(`${f}：链接 ${path || ''}#${m[2]} 的锚点在 ${page} 里没有`);
    }
  }

  // 首页和演示页由 build/site_pages.mjs 生成：手改了页面、或改了生成器没重新生成，都拦下
  const { stalePages } = await import('./site_pages.mjs');
  for (const f of stalePages(siteDir)) errors.push(`${f}：和 build/site_pages.mjs 生成的不一致（改生成器后跑 node build/site_pages.mjs）`);

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

  // _routes.json 只让 /、/files/*（0.32 起照片和附件）、/sb/* 和 /wx/*（11-26 今天页天气代理，functions/wx）进 Functions（14.2 第 7 点）
  try {
    const routes = JSON.parse(readFileSync(join(siteDir, '_routes.json'), 'utf8'));
    const inc = JSON.stringify([...(routes.include ?? [])].sort());
    if (routes.version !== 1 || inc !== JSON.stringify(['/', '/files/*', '/sb/*', '/wx/*']) || (routes.exclude ?? []).length !== 0) {
      errors.push('_routes.json：include 只能是 ["/", "/files/*", "/sb/*", "/wx/*"]，exclude 为空');
    }
  } catch {
    errors.push('_routes.json：缺少或不是合法 JSON');
  }

  // _headers 里官网的 CSP 和 Functions 的一字不差：只有首页（/zh/、/ko/）用放宽的 HOME_CSP，其他页（/zh/:page、/ko/:page）用 SITE_CSP；
  // 不许再写 /zh/*、/ko/*（会同时命中首页，两条 CSP 被 Cloudflare 用逗号拼起来）
  const { HOME_CSP, SITE_CSP } = await import('../functions/_lib/security-headers.ts');
  const headers = readFileSync(join(siteDir, '_headers'), 'utf8');
  for (const [block, want, name] of [['/zh/', HOME_CSP, 'HOME_CSP'], ['/ko/', HOME_CSP, 'HOME_CSP'], ['/zh/:page', SITE_CSP, 'SITE_CSP'], ['/ko/:page', SITE_CSP, 'SITE_CSP']]) {
    const m = new RegExp(`^${block.replace(/[/*]/g, (c) => '\\' + c)}[ \\t]*\\r?\\n((?:[ \\t]+.*\\r?\\n?)*)`, 'm').exec(headers);
    const csp = m ? /Content-Security-Policy:\s*(.+)/.exec(m[1])?.[1]?.trim() : undefined;
    if (csp !== want) errors.push(`_headers ${block}：CSP 要和 functions/_lib/security-headers.ts 的 ${name} 一字不差`);
  }
  if (/^\/(zh|ko)\/\*\s*$/m.test(headers)) errors.push('_headers：不要写 /zh/*、/ko/*（会同时命中首页，和 /zh/、/ko/ 的 CSP 拼在一起），其他页写 /zh/:page、/ko/:page');
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
  // 哈希按上线的内容算：先算不引别的文件的（图、字体、仓库别处的文件），
  // 再算样式（去掉注释、url() 换成带哈希的地址以后的内容），
  // 脚本按 import 的先后算：被引的先定名字，引它的文件里的 import 换成那个名字以后再算自己的（模块之间不成环，checkSite 查过都在）
  const names = hashedNames();
  for (const name of names.filter((n) => !/\.(css|js)$/.test(n))) map.set(name, hashName(name, readFileSync(join(SITE, name))));
  for (const [name, src] of Object.entries(SITE_EXTERNAL)) map.set(name, hashName(name, externalBytes(src)));
  const css = new Map(names.filter((n) => n.endsWith('.css')).map((n) => [n, rewrite(stripCss(readFileSync(join(SITE, n), 'utf8')), map)]));
  for (const [name, text] of css) map.set(name, hashName(name, Buffer.from(text)));
  const js = new Map(names.filter((n) => n.endsWith('.js')).map((n) => [n, readFileSync(join(SITE, n), 'utf8')]));
  const deps = new Map([...js].map(([n, t]) => [n, importsOf(t).map((u) => u.slice(1))]));
  const jsOut = new Map();
  while (jsOut.size < js.size) {
    const ready = [...js.keys()].filter((n) => !jsOut.has(n) && (deps.get(n) ?? []).every((d) => jsOut.has(d)));
    if (!ready.length) throw new Error(`site/ 的脚本模块 import 成环或引了不存在的文件：${[...js.keys()].filter((n) => !jsOut.has(n)).join('、')}`);
    for (const n of ready) {
      const text = rewrite(js.get(n) ?? '', map);
      jsOut.set(n, text);
      map.set(n, hashName(n, Buffer.from(text)));
    }
  }

  for (const abs of walk(SITE)) {
    const f = rel(abs);
    if (f.startsWith('app/')) throw new Error(`site/${f}：site/ 里不能有 app/，那是 Vite 的输出`);
    if (f === '_headers') continue;   // 由 writeHeaders 和 src/_headers 拼好再写
    let target = map.get(f) ?? f;
    const dest = join(out, ...target.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    if (css.has(f)) {
      writeFileSync(dest, css.get(f));
    } else if (jsOut.has(f)) {
      writeFileSync(dest, jsOut.get(f));
    } else if (f.endsWith('.html')) {
      writeFileSync(dest, rewrite(stripHtml(readFileSync(abs, 'utf8')), map));
    } else if (f === 'robots.txt' && mode === 'preview') {
      writeFileSync(dest, '# 预览环境：整站不给搜索引擎收录\nUser-agent: *\nDisallow: /\n');
    } else {
      cpSync(abs, dest);
    }
  }
  for (const [name, src] of Object.entries(SITE_EXTERNAL)) {
    const dest = join(out, ...(map.get(name) ?? '').split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, externalBytes(src));
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
