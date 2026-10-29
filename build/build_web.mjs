// 构建 dist/web/（架构 8.1）：npm run build -- --mode preview|production（另有本机用的 development、test、e2e、e2e-real）
// 步骤：vite build（App + 预览沙箱）→ 单独打包 sw.ts → 注入预缓存清单 → 拼 dist/web（site/、_headers、_routes.json、version.json）→ 体积预算
// tsc、ESLint、Stylelint、check_arch 由 CI 在这之前单独跑（unit.yml），这里不重复
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assembleWeb, buildEnvErrors, MODES } from './assemble_web.mjs';
import { injectSwManifest } from './inject_sw_manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argMode(argv) {
  const i = argv.indexOf('--mode');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--mode='));
  return eq ? eq.slice('--mode='.length) : 'preview';
}

const mode = argMode(process.argv.slice(2));
if (!MODES.includes(mode)) {
  console.error(`未知的构建模式：${mode}`);
  process.exit(2);
}
// e2e：本机端到端测试用的预览版（带 CSP 试验页），WebSocket 指向本机 8788
// e2e-real：同上，但接本机真后端（8789 端口同源的 /sb）；VITE_PUBLIC_SUPABASE_URL、VITE_PUBLIC_ANON_KEY 由调用方从环境变量传入，Vite 按 envPrefix 自己读
// buildEnvErrors 另外拦住 production 的 VITE_PUBLIC_SUPABASE_URL 指向本机（e2e-real 的变量漏进正式构建）
const envErrors = buildEnvErrors(mode);
if (envErrors.length) {
  for (const e of envErrors) console.error(e);
  process.exit(2);
}
const viteMode = mode === 'e2e' || mode === 'e2e-real' ? 'preview' : mode;

await build({ configFile: resolve(ROOT, 'vite.config.ts'), mode: viteMode, logLevel: 'warn' });
await build({ configFile: resolve(ROOT, 'vite.sw.config.ts'), mode: viteMode, logLevel: 'warn' });
const n = await injectSwManifest(resolve(ROOT, 'dist/web/app'));
await assembleWeb({ root: ROOT, mode });
console.log(`构建完成：mode=${mode}，预缓存 ${n} 个文件`);

// 启动画面样式的媒体查询没被压缩改写成旧版 Safari 不认的范围写法（R-254 审查必改 1）
const splash = spawnSync(process.execPath, [resolve(ROOT, 'build/check_splash_css.mjs')], { stdio: 'inherit' });
if (splash.status !== 0) process.exit(splash.status ?? 1);
const size = spawnSync(process.execPath, [resolve(ROOT, 'build/check_size.mjs')], { stdio: 'inherit' });
// Vite 的 manifest 只给体积检查用，不发布；另存一份到 dist/ 下给 npm run size 单独再查
const vm = resolve(ROOT, 'dist/web/app/.vite');
cpSync(vm, resolve(ROOT, 'dist/vite-manifest'), { recursive: true });
rmSync(vm, { recursive: true, force: true });
process.exit(size.status ?? 1);
