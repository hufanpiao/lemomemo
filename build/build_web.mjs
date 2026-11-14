// 构建 dist/web/（架构 8.1）：npm run build -- --mode preview|production（另有本机用的 development、test、e2e、e2e-real）
// 步骤：数据清单快照核对 → vite build（App + 预览沙箱）→ 单独打包 sw.ts → 生成开源许可清单（R-410）→ 注入预缓存清单 → 拼 dist/web（site/、_headers、_routes.json、version.json）→ 产物检查
// 输出目录默认 dist/web；LEMO_WEB_OUT=dist/web-<名字> 时写到那里（真后端那组 e2e 用 dist/web-real，和无后端组互不覆盖），production、preview 不许改
// tsc、ESLint、Stylelint、check_arch 由 CI 在这之前单独跑（unit.yml），这里不重复
// 构建后的检查都在本进程里直接调各脚本的 cli()（第三方审查 CI-12：原来每项另起一个 node）；各脚本仍能单独 node build/xxx.mjs 跑。
// 顺序和退出码由 tests/build/build-web.test.ts 换成假步骤核对。11-14 起构建后的检查全部跑完、按顺序取第一个非零退出码，.vite 在 finally 里删

import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assembleWeb, buildEnvErrors, MODES, WEB_OUT_DEFAULT, webOutDir } from './assemble_web.mjs';
import { argValue, ROOT } from './cli_args.mjs';
import { cli as firstPaintCli } from './check_first_paint_chunks.mjs';
import { cli as glassCli } from './check_glass_css.mjs';
import { cli as probeCli } from './check_no_probe.mjs';
import { cli as sizeCli } from './check_size.mjs';
import { cli as splashCli } from './check_splash_css.mjs';
import { writeLicenses } from './gen_licenses.mjs';
import { cli as manifestsCli } from './gen_manifests_snapshot.mjs';
import { injectSwManifest } from './inject_sw_manifest.mjs';

/** 真步骤；测试按名字换成假的，记下调用顺序。检查类返回退出码（0 = 过） */
export const STEPS = {
  manifests: () => manifestsCli(['--check']),
  vite: (configFile, viteMode) => build({ configFile: resolve(ROOT, configFile), mode: viteMode, logLevel: 'warn' }),
  licenses: (appDir) => writeLicenses(appDir, ROOT),
  inject: (appDir) => injectSwManifest(appDir),
  assemble: (mode, out) => assembleWeb({ root: ROOT, mode, out }),
  splash: (appDir) => splashCli(['--app-dir', appDir]),
  glass: (appDir) => glassCli(['--app-dir', appDir]),
  probe: (out) => probeCli(['--dir', out]),
  size: (appDir, mode) => sizeCli(['--app-dir', appDir, '--mode', mode]),
  firstPaint: (appDir) => firstPaintCli(['--app-dir', appDir]),
  // Vite 的 manifest 只给检查用，不发布；默认输出目录时另存一份到 dist/ 下给 npm run size 单独再查（别的输出目录不存，免得覆盖默认那份）
  // 构建中途失败时 .vite 可能还没生成：有才另存
  dropViteManifest: (appDir, out) => {
    const vm = resolve(appDir, '.vite');
    if (existsSync(vm) && out === resolve(ROOT, WEB_OUT_DEFAULT)) cpSync(vm, resolve(ROOT, 'dist/vite-manifest'), { recursive: true });
    rmSync(vm, { recursive: true, force: true });
  },
};

/** 一项检查的退出码：抛错也算失败（和原来各起一个进程时一样是 1），不打断后面的收尾 */
async function codeOf(check) {
  try {
    return (await check()) ?? 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/** 构建到 out（mode 已核对过）；返回退出码 */
export async function buildWeb(mode, out, s = STEPS) {
  const appDir = resolve(out, 'app');
  // 首屏用的数据清单快照过期就不构建（B2 FA-6 ③ 审查 L5）：deploy-preview 不跑测试，过期快照不能进预览环境
  const manifests = await codeOf(s.manifests);
  if (manifests) return manifests;
  const viteMode = mode === 'e2e' || mode === 'e2e-real' ? 'preview' : mode;
  // .vite（Vite 的 manifest）不发布：不管构建、检查在哪一步失败或抛错，finally 里都删掉（11-14 整块评审：原来某道检查不过就提前 return，.vite 留在产物里）
  try {
    await s.vite('vite.config.ts', viteMode);
    // 附件预览沙箱单独打包（B4b-1：和 App 共用预加载助手会把它从 App 首屏块里拆出来，见 vite.preview.config.ts 文件头）
    await s.vite('vite.preview.config.ts', viteMode);
    await s.vite('vite.sw.config.ts', viteMode);
    // 开源许可清单 /app/licenses.txt（R-410）：按 lock 的生产依赖生成，不进预缓存
    const licBytes = s.licenses(appDir);
    const n = await s.inject(appDir);
    await s.assemble(mode, out);
    console.log(`构建完成：mode=${mode}，输出到 ${out}，预缓存 ${n} 个文件，开源许可清单 ${licBytes} 字节`);

    const gates = [
      // 启动画面样式的媒体查询没被压缩改写成旧版 Safari 不认的范围写法（R-254 审查必改 1）
      () => s.splash(appDir),
      // 底栏渐隐层的遮罩带 -webkit- 前缀（B12 代码审查 11-06）：构建配置变了不再补前缀时，旧一些的 iOS Safari 上底栏、“＋”的挖空会没
      () => s.glass(appDir),
      // 正式产物里不能有 R-68 探测页和 voice-probe（B3 Q1 ⑧；和 voice-probe 同一个 PR 删）
      ...(mode === 'production' ? [() => s.probe(out)] : []),
      // 体积预算和首屏块里不许有 zod（FA-6 ③ 审查 M3 第二轮）都读 manifest，在 finally 删掉 .vite 之前跑
      () => s.size(appDir, mode),
      () => s.firstPaint(appDir),
    ];
    // 每道检查都跑完（一次构建看全所有问题），退出码按上面的顺序取第一个非零的
    let first = 0;
    for (const gate of gates) {
      const code = await codeOf(gate);
      if (code && !first) first = code;
    }
    return first;
  } finally {
    s.dropViteManifest(appDir, out);
  }
}

/** 构建模式：--mode v 或 --mode=v，没写是 preview；写了 --mode 没给值抛 UsageError（原来悄悄回落成 preview） */
export const argMode = (argv) => argValue(argv, '--mode') ?? 'preview';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let mode;
  try {
    mode = argMode(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
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
  let out;
  try {
    out = webOutDir(ROOT);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  process.exit(await buildWeb(mode, out));
}
