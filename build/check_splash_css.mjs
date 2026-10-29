// 构建后检查启动画面样式（R-254；审查必改 1）：Vite 8 的 CSS 压缩会把旧式媒体查询改写成范围写法
// （例如 (min-aspect-ratio: 1/1) → (aspect-ratio>=1)），iOS 15.5～16.3、macOS Safari 15～16.3 不认，启动画面在电脑上会画错。
// 这里查产物：包含 .lemo-splash 规则的每一段 @media，查询条件里不准有 < > = 这种范围写法；电脑版式那一段必须是 (orientation:landscape)。
// 用法：node build/check_splash_css.mjs [--app-dir <目录>]（默认 dist/web/app）；build/build_web.mjs 构建完调用，不过就让构建失败
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 一段 CSS 里每个 @media 的条件和块内文字（按花括号配对，不处理字符串里的花括号：产物里没有） */
export function mediaBlocks(css) {
  const out = [];
  const re = /@media\s*([^{]*)\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    out.push({ query: (m[1] ?? '').trim(), body: css.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** 启动画面那几段 @media 的问题（空数组 = 没问题）；没有任何 .lemo-splash 规则时也报 */
export function splashMediaProblems(css) {
  if (!css.includes('.lemo-splash')) return ['产物里没有 .lemo-splash 的样式'];
  const problems = [];
  const blocks = mediaBlocks(css).filter((b) => b.body.includes('.lemo-splash'));
  for (const b of blocks) {
    if (/[<>=]/.test(b.query)) problems.push(`@media ${b.query}：范围写法旧版 Safari 不认`);
  }
  const landscape = blocks.filter((b) => /\(\s*orientation\s*:\s*landscape\s*\)/.test(b.query));
  if (!landscape.some((b) => /--cw\s*:\s*400px/.test(b.body))) problems.push('缺电脑版式那一段 @media (orientation:landscape) { .lemo-splash { --cw:400px } }');
  return problems;
}

/** 产物目录里包含启动画面样式的 CSS 文件 */
export function splashCssFiles(appDir) {
  const dir = join(appDir, 'assets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => join(dir, f))
    .filter((f) => readFileSync(f, 'utf8').includes('.lemo-splash'));
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--app-dir');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const appDir = i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : resolve(root, 'dist/web/app');
  const files = splashCssFiles(appDir);
  if (files.length === 0) {
    console.error(`check_splash_css：${appDir}/assets 里找不到启动画面的样式`);
    process.exit(1);
  }
  let bad = 0;
  for (const f of files) {
    for (const p of splashMediaProblems(readFileSync(f, 'utf8'))) {
      bad += 1;
      console.error(`check_splash_css：${f}：${p}`);
    }
  }
  if (bad) process.exit(1);
  console.log(`check_splash_css：启动画面样式 ${files.length} 个文件，媒体查询写法都对`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
