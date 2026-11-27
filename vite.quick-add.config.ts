// exe 快速记录小窗口 /app/desktop/quick-add.html 单独打包（架构 5.10）：src/desktop/quick-add.html → dist/desktop-only/app/desktop/quick-add.html + assets/
// 只进 exe，不进网页版：网页构建（build_web.mjs）不打这一份，dist/web 里没有它，网页版预缓存、线上网站都不会多出这个页面。
// exe 流水线（desktop.yml）在暂存页面之前单独跑 `vite build -c vite.quick-add.config.ts --mode <环境>`，stage-web.mjs 再把这里的文件并进暂存目录。
// 为什么不和 App 一起打：它和 App 共用语言、皮肤几个模块，同一次构建时这些模块会从 App 入口块里拆出来，首屏多一个文件、净增约 430 B（11-24 实测）
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

/** exe 专用页面的输出目录（stage-web.mjs 的 DESKTOP_ONLY 读同一个位置） */
export const DESKTOP_ONLY_OUT = resolve(root, 'dist', 'desktop-only', 'app');

export default defineConfig({
  root: resolve(root, 'src'),
  base: '/app/',
  publicDir: false,
  envPrefix: 'VITE_PUBLIC_',
  build: {
    outDir: DESKTOP_ONLY_OUT,
    emptyOutDir: true,
    manifest: false,
    sourcemap: false,
    target: 'es2023',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: { input: { 'quick-add': resolve(root, 'src/desktop/quick-add.html') } },
  },
});
