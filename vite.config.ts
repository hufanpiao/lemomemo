// Vite：App 主体、登录页 /app/auth/（15.6 第 4b 条，K4）和预览沙箱三个页面入口（SW 单独打包，见 vite.sw.config.ts）（架构 8.1）
// base '/app/'，输出到 dist/web/app/；没有内联脚本和样式，modulepreload polyfill 关掉
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { buildVersion } from './build/assemble_web.mjs';

const root = import.meta.dirname;
// LEMO_BUILD_VERSION（deploy-preview 给的 X.Y.Z-preview.N）优先，否则 VERSION 文件；和 app/version.json 同一个来源
export const APP_VERSION: string = buildVersion(root);

export default defineConfig(({ mode }) => {
  if (mode === 'production') {
    // 正式版必须带齐公开配置（只认 VITE_PUBLIC_ 前缀，A14）
    for (const k of ['VITE_PUBLIC_SUPABASE_URL', 'VITE_PUBLIC_ANON_KEY']) {
      if (!process.env[k]) throw new Error(`production build needs ${k}`);
    }
    // 登录页的 Turnstile 站点密钥（15.2 中 1 ①）：正式版必须给，而且不能是 Cloudflare 的测试密钥（1x/2x/3x + 20 个 0 + 两位字母）
    // 本机、e2e、预览没给时由 src/platform/turnstile.ts 退回测试密钥做桩
    const sitekey = (process.env.VITE_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim(); // 先去掉首尾空白再判断（安全审查 6）
    if (!sitekey) throw new Error('production build needs VITE_PUBLIC_TURNSTILE_SITE_KEY');
    if (/^[1-3]x0{20}[A-Z]{2}$/.test(sitekey)) throw new Error('production build must not use a Turnstile test sitekey');
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
          auth: resolve(root, 'src/auth/index.html'),
          preview: resolve(root, 'src/preview.html'),
        },
      },
    },
    server: { port: 5173, strictPort: true },
  };
});
