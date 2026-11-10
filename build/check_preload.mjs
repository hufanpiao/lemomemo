// 预加载表去重的产物核对（B2-UI-b 预加载去重代码审建议 1；规则在 vite.config.ts 的 dropHostLoaded）：check_size.mjs 每次构建后调
// 拿真实产物逐个懒加载核三件事，任何一件不对就失败：
//   ① 预加载表（__vite__mapDeps）里没有宿主静态闭包里的 JS；
//   ② 目标块的闭包里，除了宿主已加载的那些，其余 JS 一个不少（也不多）；
//   ③ CSS 列表和不去重时一模一样（顺序也一样）。
// “不去重时”的表按 Vite 8.3.5 的 collectPreloadDependencies 从 manifest 重算：从目标块起深度优先，先记块自己的 JS，再走它静态引的块，最后记它的 CSS；宿主本身不算
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { parseSync } from 'vite';

/**
 * 构建时在 app/.vite/，构建完挪到 dist/vite-manifest/（和 check_size.mjs 的 measure 同一个找法）。
 * 后备的 dist/vite-manifest 只有默认输出 dist/web 才更新，对 dist/web-xxx 单独跑会拿到别的构建的 manifest：checkPreload 先核对 manifest 里的文件都在产物里（复审建议 3）
 */
export function readManifest(appDir) {
  const p = [resolve(appDir, '.vite/manifest.json'), resolve(appDir, '../../vite-manifest/manifest.json')].find((f) => existsSync(f));
  if (!p) throw new Error('找不到 Vite 的 manifest.json，先运行 npm run build');
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** manifest 的键换成产物文件名：file → { imports、dynamic（动态 import 的目标）、css，都是文件名 } */
function graphOf(manifest) {
  const g = new Map();
  const files = (ks) => (ks ?? []).map((k) => manifest[k]?.file).filter(Boolean);
  for (const c of Object.values(manifest)) g.set(c.file, { imports: files(c.imports), dynamic: files(c.dynamicImports), css: c.css ?? [] });
  return g;
}

function staticClosure(g, file) {
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const i of g.get(f)?.imports ?? []) visit(i);
  };
  visit(file);
  return seen;
}

/** 不去重时 Vite 会写的表（JS 和 CSS 混排，顺序同 Vite） */
export function fullDeps(g, target, host) {
  const visited = new Set([host]);
  const out = [];
  const visit = (f) => {
    const c = g.get(f);
    if (!c || visited.has(f)) return;
    visited.add(f);
    out.push(f);
    c.imports.forEach(visit);
    for (const css of c.css) out.push(css);
  };
  visit(target);
  return out;
}

/** 字符串或不带插值的模板字符串的值；别的返回 null */
function staticString(n) {
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}

/** 语法树里所有节点（不用递归，块大时不爆栈） */
function* nodes(root) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) {
      for (const x of n) stack.push(x);
      continue;
    }
    if (typeof n.type === 'string') yield n;
    for (const k in n) if (k !== 'type' && n[k] && typeof n[k] === 'object') stack.push(n[k]);
  }
}

const isMapDeps = (n) => n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === '__vite__mapDeps';

/**
 * 从一个块的代码里取出预加载表：m.f=[文件名…]，每处 __vite__mapDeps([下标…])，连同它所在的预加载调用 preload(() => import("./x.js")…, __vite__mapDeps([…]))
 * 第一个参数里的 import 地址（相对宿主所在目录）。目标从 import 的地址取，不拿表的第一项：目标本身在宿主闭包里时，第一项会是别的块或 CSS（复审建议 2）。
 * 第一个参数可能是 import(…).then(…)，也可能是整段 async 函数，所以用 vite 自带的 parseSync 解析成语法树找，不靠正则往前看。
 * 找不到 import 地址（不在预加载调用里，或第一个参数里不是正好一个写死地址的 import）的表 target 为 null，由 checkCall 报出来
 */
export function mapDepsCalls(code, host) {
  const m = code.match(/m\.f=(\[[^\]]*\])/);
  if (!m) return [];
  const list = JSON.parse(m[1]);
  const { program } = parseSync(host, code);
  const targetOf = new Map();
  const calls = [];
  for (const n of nodes(program)) {
    if (isMapDeps(n)) calls.push(n);
    else if (n.type === 'CallExpression' && isMapDeps(n.arguments?.[1])) {
      const imports = [...nodes(n.arguments[0])].filter((x) => x.type === 'ImportExpression');
      const url = imports.length === 1 ? staticString(imports[0].source) : null;
      if (url) targetOf.set(n.arguments[1], posix.join(posix.dirname(host), url));
    }
  }
  return calls
    .filter((c) => c.arguments[0]?.type === 'ArrayExpression')
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ target: targetOf.get(c) ?? null, deps: c.arguments[0].elements.map((e) => list[Number(e.value)]) }));
}

const isCss = (f) => f.endsWith('.css');

/** 去重以后该留的：目标闭包里宿主没加载的 JS（含目标自己），和全部 CSS（顺序同 Vite） */
function wanted(g, target, host) {
  const loaded = staticClosure(g, host);
  const full = fullDeps(g, target, host);
  return { loaded, full, js: full.filter((f) => !isCss(f) && !loaded.has(f)), css: full.filter(isCss) };
}

/** 核对一处懒加载；返回问题列表（空 = 通过） */
export function checkCall(g, host, target, actual) {
  const where = `${host} → ${target ?? '?'}`;
  if (!target) return [`${where}：这张预加载表前面找不到 import("…") 地址，产物格式变了，核对脚本要跟着改`];
  if (!g.has(target)) return [`${where}：import 的目标不在 manifest 里`];
  const errs = [];
  const w = wanted(g, target, host);
  const actJs = actual.filter((f) => !isCss(f));
  const dup = actJs.filter((f) => w.loaded.has(f));
  if (dup.length) errs.push(`${where}：① 表里还有宿主已加载的 JS：${dup.join('、')}`);
  const missing = w.js.filter((f) => !actJs.includes(f));
  const extra = actJs.filter((f) => !w.js.includes(f) && !w.loaded.has(f));
  if (missing.length) errs.push(`${where}：② 少了 JS：${missing.join('、')}`);
  if (extra.length) errs.push(`${where}：② 多了闭包外的 JS：${extra.join('、')}`);
  const wantCss = w.css.join(' ');
  const actCss = actual.filter(isCss).join(' ');
  if (wantCss !== actCss) errs.push(`${where}：③ CSS 和不去重时不一样：应为 [${wantCss}]，实际 [${actCss}]`);
  return errs;
}

/** manifest 里的块和 CSS 在产物里找不到的（manifest 是别的构建的，或产物被删过） */
function missingFiles(manifest, appDir) {
  const files = new Set();
  for (const c of Object.values(manifest)) for (const f of [c.file, ...(c.css ?? [])]) if (f) files.add(f);
  return [...files].filter((f) => !existsSync(resolve(appDir, f)));
}

/** 整个产物：返回 { calls: 核对了几处懒加载, errors }。没有 assets 目录（check_size 测试造的假产物）时 calls 为 0、不算错 */
export function checkPreload(appDir, manifest = readManifest(appDir)) {
  const assets = resolve(appDir, 'assets');
  if (!existsSync(assets)) return { calls: 0, errors: [] };
  const gone = missingFiles(manifest, appDir);
  if (gone.length) {
    return { calls: 0, errors: [`manifest 和产物对不上：manifest 里有 ${gone.length} 个文件在 ${appDir} 里找不到（例如 ${gone.slice(0, 3).join('、')}），多半是读到了别的构建的 manifest，没有逐个核对`] };
  }
  const g = graphOf(manifest);
  let calls = 0;
  const errors = [];
  const seenPairs = new Set();
  for (const name of readdirSync(assets)) {
    if (!name.endsWith('.js')) continue;
    const host = `assets/${name}`;
    const code = readFileSync(resolve(assets, name), 'utf8');
    if (!code.includes('__vite__mapDeps(')) continue;
    for (const { target, deps } of mapDepsCalls(code, host)) {
      calls++;
      if (target) seenPairs.add(`${host} → ${target}`);
      errors.push(...checkCall(g, host, target, deps));
    }
  }
  // 整张表都不见了也要发现。Vite 只在不去重时表超过 1 项时写表；去重后该留的 JS 和 CSS 都空了（目标本身在宿主闭包里、又没有 CSS），
  // 写的是 []、没有表，这时不要求（复审建议 1）
  for (const [host, c] of g) {
    for (const t of c.dynamic) {
      if (seenPairs.has(`${host} → ${t}`) || fullDeps(g, t, host).length <= 1) continue;
      const w = wanted(g, t, host);
      if (w.js.length + w.css.length > 0) errors.push(`${host} → ${t}：② 整张预加载表不见了`);
    }
  }
  return { calls, errors };
}
