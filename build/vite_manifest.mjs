// 构建后几项检查共用的 Vite manifest 读取（第三方审查 CI-12：check_size、check_preload、check_first_paint_chunks 原来各写一份找法）。
// 构建时在 <app>/.vite/manifest.json；build_web.mjs 构建完删掉 .vite，默认输出目录时另存到 dist/vite-manifest/（不发布），npm run size 单独再查时读那份。
// 后备的 dist/vite-manifest 只有默认输出 dist/web 才更新，对 dist/web-xxx 单独跑会拿到别的构建的 manifest：check_preload 先核对 manifest 里的文件都在产物里
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** appDir：产物的 app 目录（dist/web/app 之类）；找不到就抛错 */
export function readManifest(appDir) {
  const p = [resolve(appDir, '.vite/manifest.json'), resolve(appDir, '../../vite-manifest/manifest.json')].find((f) => existsSync(f));
  if (!p) throw new Error('找不到 Vite 的 manifest.json，先运行 npm run build');
  return JSON.parse(readFileSync(p, 'utf8'));
}
