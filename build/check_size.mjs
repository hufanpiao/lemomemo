// 体积预算（架构 2.6、W3）：按 Vite 的 manifest 找出首屏要下载的 JS（入口 + 它静态 import 的 chunk），gzip 后合计
// 首屏 JS ≤ 150 KB（含 React）超了就失败；全部 JS ≤ 250 KB 只提示（硬验收在 B2，B0 只做脚本，空白 App 的数字没有意义）
// 只管总量（负责人 11-25 定“改成只管总量”：首屏总量不超过 150 KB gzip、打开速度不变慢就行）：原来的“每批首屏净增 ≤ 1 KB”关卡
// （B3 起，R-379 按批次重设）连同它的基线文件 build/first-screen-baseline.json、去抖动的稳定口径一起删掉；打开速度靠改动时实测冷启动对比，不在这里卡
// 用法：node build/check_size.mjs [--json] [--app-dir <目录>]
//（--app-dir 默认 dist/web/app；违规样例测试用它指到临时目录，QA D-06；参数解析见 cli_args.mjs：相对路径按仓库根，写了参数没给值退出 2）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkPreload } from './check_preload.mjs';
import { argPath, withUsage } from './cli_args.mjs';
import { readManifest, staticClosure } from './vite_manifest.mjs';

/**
 * firstScreenFiles（B4b-1 第二轮，主持人定）：首屏 JS 文件数上限 = 当时 main 的 8 个 + 1。冷启动每多一个文件就多一个请求；
 * 懒加载页共用的小模块被拆出、又被首屏静态引到时，文件数会先涨（vite.config.ts 的 LAZY_GROUPS 就是为这个合成一块）
 */
export const BUDGET = { firstScreenJs: 150 * 1024, totalJs: 250 * 1024, firstScreenFiles: 9 };

/** 首屏文件数超了的说明；没超回 null */
export const firstFilesError = (n) => (n > BUDGET.firstScreenFiles ? `首屏 JS 文件 ${n} 个，超过上限 ${BUDGET.firstScreenFiles} 个（冷启动多请求；先查是不是共用的小模块被拆成了单独一块）` : null);

/** manifest：Vite 的 .vite/manifest.json 内容；entryKey：入口在 manifest 里的键 */
export function firstScreenFiles(manifest, entryKey) {
  return staticClosure(manifest, [entryKey]).map((k) => manifest[k].file);
}

export function measure(appDir, manifest = readManifest(appDir)) {
  const gz = (f) => gzipSync(readFileSync(resolve(appDir, f)), { level: 9 }).length;
  const first = firstScreenFiles(manifest, 'index.html').filter((f) => f.endsWith('.js'));
  const all = [...new Set(Object.values(manifest).map((c) => c.file))].filter((f) => f.endsWith('.js'));
  const firstScreenJs = first.reduce((s, f) => s + gz(f), 0);
  const totalJs = all.reduce((s, f) => s + gz(f), 0);
  return { firstScreenJs, totalJs, firstFiles: first };
}

/** 命令行入口（build_web.mjs 构建完直接调它，不另起进程）：argv 是 process.argv.slice(2) 那样的参数，返回退出码 */
export const cli = withUsage((argv) => {
  const appDir = argPath(argv, '--app-dir', 'dist/web/app');
  const manifest = readManifest(appDir);
  const r = measure(appDir, manifest);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  if (argv.includes('--json')) console.log(JSON.stringify(r));
  else {
    console.log(`首屏 JS（gzip）：${kb(r.firstScreenJs)} / 预算 ${kb(BUDGET.firstScreenJs)}（${r.firstFiles.length} 个文件）`);
    console.log(`全部 JS（gzip）：${kb(r.totalJs)} / 参考 ${kb(BUDGET.totalJs)}`);
  }
  if (r.totalJs > BUDGET.totalJs) console.warn('提示：全部 JS 超过 250 KB（B2 起按真实页面验收）');
  let failed = false;
  if (r.firstScreenJs > BUDGET.firstScreenJs) {
    console.error('W3：首屏 JS 超出预算');
    failed = true;
  }
  const fe = firstFilesError(r.firstFiles.length);
  if (fe) {
    console.error(fe);
    failed = true;
  }
  // 预加载表去重的产物核对（vite.config.ts 的 preloadDeps、dropHostLoaded，见 check_preload.mjs）。manifest 里该有表的动态 import 在产物里找不到也算失败
  const p = checkPreload(appDir, manifest);
  if (p.errors.length) {
    for (const e of p.errors) console.error(`预加载表去重：${e}`);
    failed = true;
  } else if (p.calls > 0) console.log(`预加载表去重：${p.calls} 处懒加载都核对过（宿主已加载的 JS 不列、入口块只给首屏动态入口列 JS、其余 JS 一个不少、CSS 和不去重时一样）`);
  return failed ? 1 : 0;
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(cli(process.argv.slice(2)));
