// 构建后几项检查共用的 Vite manifest 读取（第三方审查 CI-12：check_size、check_preload、check_first_paint_chunks 原来各写一份找法）。
// 构建时在 <app>/.vite/manifest.json；build_web.mjs 构建完删掉 .vite，默认输出目录时另存到 dist/vite-manifest/（不发布），npm run size 单独再查时读那份。
// 后备的 dist/vite-manifest 只有默认输出 dist/web 才更新，对 dist/web-xxx 单独跑会拿到别的构建的 manifest：check_preload 先核对 manifest 里的文件都在产物里
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { ROOT } from './cli_args.mjs';

/**
 * 从 starts 出发只沿静态 imports 走，按先序返回经过的键（11-14 整块评审：check_size 的 firstScreenFiles、check_first_paint_chunks、
 * check_preload 原来各写一份）。graph：Vite manifest 对象（键 → { imports }），或 Map（check_preload 换成文件名的图）。
 * 起点或 imports 里的键在图里找不到就抛错（manifest 和产物对不上时不悄悄少算）
 */
export function staticClosure(graph, starts) {
  const get = graph instanceof Map ? (k) => graph.get(k) : (k) => (Object.hasOwn(graph, k) ? graph[k] : undefined);
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    const node = get(key);
    if (!node) throw new Error(`manifest 里没有 ${key}`);
    seen.add(key);
    for (const k of node.imports ?? []) visit(k);
  };
  for (const k of starts) visit(k);
  return [...seen];
}

/** appDir：产物的 app 目录（dist/web/app 之类）；找不到就抛错 */
export function readManifest(appDir) {
  // 后备只在仓库里找（11-14 整块评审：产物在系统临时目录时，<app>/../.. 会落到临时目录根，读到不相干的文件）
  const fallback = resolve(appDir, '../../vite-manifest/manifest.json');
  const rel = relative(ROOT, fallback);
  const inRepo = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  const p = [resolve(appDir, '.vite/manifest.json'), ...(inRepo ? [fallback] : [])].find((f) => existsSync(f));
  if (!p) throw new Error('找不到 Vite 的 manifest.json，先运行 npm run build');
  return JSON.parse(readFileSync(p, 'utf8'));
}
