// Vite：App 主体、登录页 /app/auth/（15.6 第 4b 条，K4）和预览沙箱三个页面入口（SW 单独打包，见 vite.sw.config.ts）（架构 8.1）
// base '/app/'，输出到 dist/web/app/（LEMO_WEB_OUT 可改输出目录，见 build/assemble_web.mjs 的 webOutDir）；没有内联脚本和样式，modulepreload polyfill 关掉
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type Rolldown } from 'vite';
import { buildVersion, webOutDir } from './build/assemble_web.mjs';

const root = import.meta.dirname;
/**
 * FA-6 ③：裸的 'zod' 一律别名到 src/platform/zod-jitless.ts（先 z.config({ jitless: true }) 再转出），
 * 这样 zod 可以跟着用它的懒加载模块走、不必在入口第一个 import；严格 CSP 下照样不会触发 eval 探测。
 * 只匹配整个说明符 'zod'；垫片自己引 'zod/v4'，不会绕回来。tests/build/zod-alias.test.ts 守着
 */
export const ZOD_JITLESS_ALIAS = { find: /^zod$/, replacement: resolve(root, 'src/platform/zod-jitless.ts') };
/**
 * 只有 export … from 的出口文件按无副作用打包（11-12 首屏瘦身）：底栏从 motion/components.ts 只拿 Pressable，可出口是静态转出，
 * Rolldown 把 Appear、AppearList、useHoldView、swap-guard 这些只有懒加载页用的组件也算进首屏块（约 1 KB gzip）。标成无副作用以后，
 * 引入按名字直接连到真正的模块，没人在首屏用的跟着用它的页走。没匹配上的模块照默认（包的 package.json sideEffects 照认）。
 * 出口文件只许有 export … from（tests/build/pure-reexports.test.ts 守着），往里加顶层语句就不是无副作用了
 */
export const PURE_REEXPORT_RULES = [{ test: /[\\/]src[\\/]motion[\\/]components\.ts$/, sideEffects: false }];
// LEMO_BUILD_VERSION（deploy-preview 给的 X.Y.Z-preview.N）优先，否则 VERSION 文件；和 app/version.json 同一个来源
export const APP_VERSION: string = buildVersion(root);
/**
 * 构建用的提交号（前 7 位；11-06 设置 › 关于的诊断信息要看主屏幕版到底跑的是哪一版）：CI 给的 GITHUB_SHA、Cloudflare Pages 给的 CF_PAGES_COMMIT_SHA 优先，
 * 本机取 git rev-parse；都拿不到写 unknown。只是显示用，不参与任何判断
 */
function buildCommit(): string {
  const e = process.env['GITHUB_SHA'] ?? process.env['CF_PAGES_COMMIT_SHA'];
  if (e) return e.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 动态 import 的预加载表去重（B2-UI-b 任务单 V2：首屏增量 ≤ 0）。Vite 给每个动态 import 写的预加载表（__vite__mapDeps）是目标块的整个静态闭包，
 * 发起 import 的那一块（宿主）自己静态引过的块也照列，比如 main 里几十个懒加载每个都列一遍 jsx-runtime、native-bridge。
 * （以后开了 chunk import map，bundle 的键和预加载表里的文件名会换成另一套，bundle[hostId] 找不到、闭包也对不上，去重会悄悄失效；
 * 失效方向是安全的：表原样全列，只是 main 块变回长的，check_size 的首屏净增会看到。）宿主在跑，这些块早就加载完了；
 * 运行时的预加载助手对页面里已有的 <link> 和加载过的地址本来也跳过，列了也白列，只让 main 块的表变长。
 * 这里只去掉“宿主静态闭包里的 JS”：CSS 不经过 resolveDependencies（Vite 自己把 CSS 拆出来照旧全列），html 宿主（index.html 的 modulepreload 链接）不动。
 * tests/build/preload-dedupe.test.ts 守着规则；build/check_preload.mjs（check_size 每次构建后调）拿真实产物逐个懒加载核对
 */
export function staticClosure(bundle: Rolldown.OutputBundle, fileName: string): Set<string> {
  const seen = new Set<string>();
  const visit = (f: string): void => {
    if (seen.has(f)) return;
    seen.add(f);
    const c = bundle[f];
    if (c?.type === 'chunk') for (const i of c.imports) visit(i);
  };
  visit(fileName);
  return seen;
}

export function dropHostLoaded(bundle: Rolldown.OutputBundle | undefined, deps: string[], hostId: string, hostType: 'html' | 'js'): string[] {
  if (hostType !== 'js' || !bundle?.[hostId]) return deps;
  const loaded = staticClosure(bundle, hostId);
  return deps.filter((d) => !loaded.has(d));
}

/**
 * 产物图在 generateBundle 最前面记下，Vite 改写预加载表也在 generateBundle 里、排在它后面。
 * 这个先后依赖 Vite 自己的 vite:build-import-analysis 插件的 generateBundle 不是 order: 'pre'（8.3.5 源码 dist/node/chunks/node.js:27164 是普通顺序）；
 * 升级 Vite 时要重新核对：要是它也改成 pre，就可能排到我们前面，get() 拿到 undefined（buildStart 清过），去重整个不生效，方向安全但首屏会涨。
 * buildStart 把 graph 清成 undefined，同一个配置连着构建也不会拿到上一次的产物图，“每次构建各用各的”不靠钩子顺序成立
 */
function preloadGraph(): { plugin: Plugin; get: () => Rolldown.OutputBundle | undefined } {
  let graph: Rolldown.OutputBundle | undefined;
  return {
    plugin: {
      name: 'lemo:preload-graph',
      apply: 'build',
      buildStart() {
        graph = undefined;
      },
      generateBundle: {
        order: 'pre',
        handler(_opts, bundle) {
          graph = bundle;
        },
      },
    },
    get: () => graph,
  };
}

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
  const graph = preloadGraph();
  return {
    root: resolve(root, 'src'),
    base: '/app/',
    publicDir: resolve(root, 'src/public'),
    envPrefix: 'VITE_PUBLIC_',
    plugins: [react(), graph.plugin],
    resolve: { alias: [ZOD_JITLESS_ALIAS] },
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    },
    build: {
      outDir: resolve(webOutDir(root), 'app'),
      emptyOutDir: true,
      manifest: true,
      sourcemap: false,
      target: 'es2023',
      modulePreload: {
        polyfill: false,
        resolveDependencies: (_file, deps, { hostId, hostType }) => dropHostLoaded(graph.get(), deps, hostId, hostType),
      },
      // 小文件也不内联成 data: URI（img-src 虽然放了 data:，字体等没放）
      assetsInlineLimit: 0,
      rollupOptions: {
        treeshake: { moduleSideEffects: PURE_REEXPORT_RULES },
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
