// 体积预算（架构 2.6、W3）：按 Vite 的 manifest 找出首屏要下载的 JS（入口 + 它静态 import 的 chunk），gzip 后合计
// 首屏 JS ≤ 150 KB（含 React）超了就失败；全部 JS ≤ 250 KB 只提示（硬验收在 B2，B0 只做脚本，空白 App 的数字没有意义）
// 用法：node build/check_size.mjs [--json] [--app-dir <目录>]（--app-dir 默认 dist/web/app；违规样例测试用它指到临时目录，QA D-06）
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = { firstScreenJs: 150 * 1024, totalJs: 250 * 1024 };

/** manifest：Vite 的 .vite/manifest.json 内容；entryKey：入口在 manifest 里的键 */
export function firstScreenFiles(manifest, entryKey) {
  const seen = new Set();
  const files = [];
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`manifest 里没有 ${key}`);
    files.push(chunk.file);
    for (const k of chunk.imports ?? []) visit(k);
  };
  visit(entryKey);
  return files;
}

export function measure(appDir) {
  // 构建时在 app/.vite/，构建完挪到 dist/vite-manifest/（不发布）
  const manifestPath = [resolve(appDir, '.vite/manifest.json'), resolve(appDir, '../../vite-manifest/manifest.json')].find((p) =>
    existsSync(p),
  );
  if (!manifestPath) throw new Error('找不到 Vite 的 manifest.json，先运行 npm run build');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const gz = (f) => gzipSync(readFileSync(resolve(appDir, f)), { level: 9 }).length;
  const first = firstScreenFiles(manifest, 'index.html').filter((f) => f.endsWith('.js'));
  const all = [...new Set(Object.values(manifest).map((c) => c.file))].filter((f) => f.endsWith('.js'));
  const firstScreenJs = first.reduce((s, f) => s + gz(f), 0);
  const totalJs = all.reduce((s, f) => s + gz(f), 0);
  return { firstScreenJs, totalJs, firstFiles: first };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const i = process.argv.indexOf('--app-dir');
  const appDir = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : resolve(root, 'dist/web/app');
  const r = measure(appDir);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  if (process.argv.includes('--json')) console.log(JSON.stringify(r));
  else {
    console.log(`首屏 JS（gzip）：${kb(r.firstScreenJs)} / 预算 ${kb(BUDGET.firstScreenJs)}（${r.firstFiles.length} 个文件）`);
    console.log(`全部 JS（gzip）：${kb(r.totalJs)} / 参考 ${kb(BUDGET.totalJs)}`);
  }
  if (r.totalJs > BUDGET.totalJs) console.warn('提示：全部 JS 超过 250 KB（B2 起按真实页面验收）');
  if (r.firstScreenJs > BUDGET.firstScreenJs) {
    console.error('W3：首屏 JS 超出预算');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
