// 附件预览沙箱 /app/preview（B4b-1）单独打包（同 vite.sw.config.ts 的做法；架构 8.1）：src/preview.html → dist/web/app/preview.html + assets/
// 为什么不和 App 一起打：沙箱按文件类型动态 import 四个渲染器，和 App 同一次构建时 Vite 的预加载助手（preload-helper）被两个入口共用，
// 就从 App 的入口块里拆成单独一块，首屏多一个文件、少了一起压缩，净增约 370 B（11-14 实测）。单独打包后沙箱和 App 不共用任何块，
// App 的首屏、manifest、预加载表去重都只管 App；沙箱里 zip、文件判型这些小模块各带一份（只多在沙箱那几块里）
// 预缓存：inject_sw_manifest.mjs 扫整个 app 目录，沙箱的文件照样进；build_web.mjs 在 App 之后、SW 之前跑这一份（emptyOutDir 关掉）
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { webOutDir } from './build/assemble_web.mjs';
import { ZIP_LITE_ALIAS, ZOD_JITLESS_ALIAS } from './vite.config.ts';

const root = import.meta.dirname;

export default defineConfig({
  root: resolve(root, 'src'),
  base: '/app/',
  publicDir: false,
  envPrefix: 'VITE_PUBLIC_',
  resolve: { alias: [ZOD_JITLESS_ALIAS, ZIP_LITE_ALIAS] },
  build: {
    outDir: resolve(webOutDir(root), 'app'),
    emptyOutDir: false,
    manifest: false,
    sourcemap: false,
    target: 'es2023',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: { input: { preview: resolve(root, 'src/preview.html') } },
  },
});
