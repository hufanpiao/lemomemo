// 构建后检查底栏渐隐层的遮罩（B12，代码审查 11-06）：GlassBarFx.module.css 的 .edge 用 mask-composite 把底栏、“＋”的形状挖掉，
// 源码只写标准的 mask-composite: subtract, add…；旧一些的 iOS Safari 只认带前缀的 -webkit-mask-composite（取值是 source-out、source-over…），
// 这一行是构建时自动补的前缀。万一构建配置变了不再补，iOS 上挖空就没了：渐隐层盖在底栏、“＋”上面，玻璃变灰。
// 这里查产物：GlassBarFx 的 CSS 里必须有 -webkit-mask-composite:source-out，也要有标准写法 mask-composite:subtract。
// 用法：node build/check_glass_css.mjs [--app-dir <目录>]（默认 dist/web/app）；build/build_web.mjs 构建完调用，不过就让构建失败
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 一段 CSS 的问题（空数组 = 没问题） */
export function glassMaskProblems(css) {
  const flat = css.replace(/\s+/g, '');
  const problems = [];
  if (!/-webkit-mask-composite:source-out[,;}]/.test(flat)) problems.push('缺 -webkit-mask-composite:source-out（旧一些的 iOS Safari 只认带前缀的写法，挖空会没）');
  if (!/(^|[;{])mask-composite:subtract[,;}]/.test(flat)) problems.push('缺标准写法 mask-composite:subtract');
  return problems;
}

/** 产物目录里 GlassBarFx 的 CSS 文件（文件名带 hash：GlassBarFx-xxxx.css） */
export function glassCssFiles(appDir) {
  const dir = join(appDir, 'assets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^GlassBarFx-[\w-]+\.css$/.test(f))
    .map((f) => join(dir, f));
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--app-dir');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const appDir = i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : resolve(root, 'dist/web/app');
  const files = glassCssFiles(appDir);
  if (files.length === 0) {
    console.error(`check_glass_css：${appDir}/assets 里找不到 GlassBarFx 的样式`);
    process.exit(1);
  }
  let bad = 0;
  for (const f of files) {
    for (const p of glassMaskProblems(readFileSync(f, 'utf8'))) {
      console.error(`check_glass_css：${f}：${p}`);
      bad += 1;
    }
  }
  if (bad > 0) process.exit(1);
  console.log(`底栏渐隐层遮罩：${files.length} 个文件，带前缀和标准写法都在`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
