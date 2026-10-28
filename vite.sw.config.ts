// Service Worker 单独打包（架构 8.1）：src/sw/sw.ts → dist/web/app/sw.js（经典脚本格式，iOS 兼容）
// 预缓存清单由 build/inject_sw_manifest.mjs 在 App 打包之后注入（替换 self.__WB_MANIFEST）
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  root,
  publicDir: false,
  build: {
    outDir: resolve(root, 'dist/web/app'),
    emptyOutDir: false,
    target: 'es2023',
    sourcemap: false,
    lib: {
      entry: resolve(root, 'src/sw/sw.ts'),
      formats: ['iife'],
      name: 'lemoSw',
      fileName: () => 'sw.js',
    },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
