// Vite：App 主体和预览沙箱两个页面入口（SW 单独打包，见 vite.sw.config.ts）（架构 8.1）
// base '/app/'，输出到 dist/web/app/；没有内联脚本和样式，modulepreload polyfill 关掉
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
export const APP_VERSION = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();

export default defineConfig(({ mode }) => {
  if (mode === 'production') {
    // 正式版必须带齐公开配置（只认 VITE_PUBLIC_ 前缀，A14）
    for (const k of ['VITE_PUBLIC_SUPABASE_URL', 'VITE_PUBLIC_ANON_KEY']) {
      if (!process.env[k]) throw new Error(`production build needs ${k}`);
    }
  }
  return {
    root: resolve(root, 'src'),
    base: '/app/',
    publicDir: resolve(root, 'src/public'),
    envPrefix: 'VITE_PUBLIC_',
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    build: {
      outDir: resolve(root, 'dist/web/app'),
      emptyOutDir: true,
      manifest: true,
      sourcemap: false,
      target: 'es2023',
      modulePreload: { polyfill: false },
      // 小文件也不内联成 data: URI（img-src 虽然放了 data:，字体等没放）
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          main: resolve(root, 'src/index.html'),
          preview: resolve(root, 'src/preview.html'),
        },
      },
    },
    server: { port: 5173, strictPort: true },
  };
});
