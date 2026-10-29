// 构建 dist/web/（架构 8.1）：npm run build -- --mode preview|production（另有本机用的 development、test、e2e、e2e-real）
// 步骤：vite build（App + 预览沙箱）→ 单独打包 sw.ts → 注入预缓存清单 → 拼 dist/web（site/、_headers、_routes.json、version.json）→ 体积预算
// 输出目录默认 dist/web；LEMO_WEB_OUT=dist/web-<名字> 时写到那里（真后端那组 e2e 用 dist/web-real，和无后端组互不覆盖），production、preview 不许改
// tsc、ESLint、Stylelint、check_arch 由 CI 在这之前单独跑（unit.yml），这里不重复
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assembleWeb, buildEnvErrors, MODES, WEB_OUT_DEFAULT, webOutDir } from './assemble_web.mjs';
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
// e2e：本机端到端测试用的预览版（带 CSP 试验页），WebSocket 指向本机 8788（LEMO_WS_PORT 可改，见 assemble_web.mjs 的 wsOrigin）
// e2e-real：同上，但接本机真后端（8789 端口同源的 /sb）；VITE_PUBLIC_SUPABASE_URL、VITE_PUBLIC_ANON_KEY 由调用方从环境变量传入，Vite 按 envPrefix 自己读
// buildEnvErrors 另外拦住 production 的 VITE_PUBLIC_SUPABASE_URL 指向本机（e2e-real 的变量漏进正式构建）
const envErrors = buildEnvErrors(mode);
if (envErrors.length) {
  for (const e of envErrors) console.error(e);
  process.exit(2);
}
let OUT;
try {
  OUT = webOutDir(ROOT);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
const APP_DIR = resolve(OUT, 'app');
const viteMode = mode === 'e2e' || mode === 'e2e-real' ? 'preview' : mode;

await build({ configFile: resolve(ROOT, 'vite.config.ts'), mode: viteMode, logLevel: 'warn' });
await build({ configFile: resolve(ROOT, 'vite.sw.config.ts'), mode: viteMode, logLevel: 'warn' });
const n = await injectSwManifest(APP_DIR);
await assembleWeb({ root: ROOT, mode, out: OUT });
console.log(`构建完成：mode=${mode}，输出到 ${OUT}，预缓存 ${n} 个文件`);

// 启动画面样式的媒体查询没被压缩改写成旧版 Safari 不认的范围写法（R-254 审查必改 1）
const splash = spawnSync(process.execPath, [resolve(ROOT, 'build/check_splash_css.mjs'), '--app-dir', APP_DIR], { stdio: 'inherit' });
if (splash.status !== 0) process.exit(splash.status ?? 1);
const size = spawnSync(process.execPath, [resolve(ROOT, 'build/check_size.mjs'), '--app-dir', APP_DIR], { stdio: 'inherit' });
// Vite 的 manifest 只给体积检查用，不发布；默认输出目录时另存一份到 dist/ 下给 npm run size 单独再查（别的输出目录不存，免得覆盖默认那份）
const vm = resolve(APP_DIR, '.vite');
if (OUT === resolve(ROOT, WEB_OUT_DEFAULT)) cpSync(vm, resolve(ROOT, 'dist/vite-manifest'), { recursive: true });
rmSync(vm, { recursive: true, force: true });
process.exit(size.status ?? 1);
