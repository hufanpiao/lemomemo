// 体积预算（架构 2.6、W3）：按 Vite 的 manifest 找出首屏要下载的 JS（入口 + 它静态 import 的 chunk），gzip 后合计
// 首屏 JS ≤ 150 KB（含 React）超了就失败；全部 JS ≤ 250 KB 只提示（硬验收在 B2，B0 只做脚本，空白 App 的数字没有意义）
// 首屏净增额度（11-09 起，B3 任务单架构审“首屏净增 ≤ 1 KB”、代码审 B1；R-379 起按批次重设）：--mode 给了、build/first-screen-baseline.json
// 当前批次（current）的 modes 里有这个模式、基线已定时，首屏 JS 超过 基线 + limitBytes 也失败。150 KB 总量管不到这 1 KB。
// 没有基线的模式（production 要真密钥构建、development、test）、基线还是 null 的批次只提示不查。日志和报错里的批次名取 current。
// R-379（2026-11-10 负责人选项原文：“B4 新开一份 1 KB 额度（推荐）”）：首屏净增额度按批次重设：以 R-378 合入后的 main 为 B4 新基线，
// B4 这一批首屏净增 ≤ 1 KB，标准同 B3
// 用法：node build/check_size.mjs [--json] [--app-dir <目录>] [--mode <模式>] [--baseline <文件>]
//（--app-dir 默认 dist/web/app；违规样例测试用它指到临时目录，QA D-06；--baseline 默认 build/first-screen-baseline.json，测试用它换成临时文件；
// 参数解析见 cli_args.mjs：相对路径按仓库根，写了参数没给值退出 2）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkPreload } from './check_preload.mjs';
import { argPath, argValue, withUsage } from './cli_args.mjs';
import { readManifest, staticClosure } from './vite_manifest.mjs';

/**
 * firstScreenFiles（B4b-1 第二轮，主持人定）：首屏 JS 文件数上限 = 当时 main 的 8 个 + 1。冷启动每多一个文件就多一个请求；
 * 懒加载页共用的小模块被拆出、又被首屏静态引到时，文件数会先涨（vite.config.ts 的 LAZY_GROUPS 就是为这个合成一块）
 */
export const BUDGET = { firstScreenJs: 150 * 1024, totalJs: 250 * 1024, firstScreenFiles: 9 };

/** 首屏文件数超了的说明；没超回 null */
export const firstFilesError = (n) => (n > BUDGET.firstScreenFiles ? `首屏 JS 文件 ${n} 个，超过上限 ${BUDGET.firstScreenFiles} 个（冷启动多请求；先查是不是共用的小模块被拆成了单独一块）` : null);

/** manifest：Vite 的 .vite/manifest.json 内容；entryKey：入口在 manifest 里的键 */
export function firstScreenFiles(manifest, entryKey) {
  return staticClosure(manifest, [entryKey]).map((k) => manifest[k].file);
}

export function measure(appDir, manifest = readManifest(appDir)) {
  const gz = (f) => gzipSync(readFileSync(resolve(appDir, f)), { level: 9 }).length;
  const first = firstScreenFiles(manifest, 'index.html').filter((f) => f.endsWith('.js'));
  const all = [...new Set(Object.values(manifest).map((c) => c.file))].filter((f) => f.endsWith('.js'));
  const firstScreenJs = first.reduce((s, f) => s + gz(f), 0);
  const totalJs = all.reduce((s, f) => s + gz(f), 0);
  const commits = buildCommits();
  const pub = publicValues();
  const gzStable = (f) => gzipSync(Buffer.from(stableText(readFileSync(resolve(appDir, f), 'utf8'), commits, pub)), { level: 9 }).length;
  const firstScreenStable = first.reduce((s, f) => s + gzStable(f), 0);
  return { firstScreenJs, firstScreenStable, totalJs, firstFiles: first };
}

/**
 * 净增关卡用的“稳定”字节数（11-09 查清的抖动来源）：同一份源码连构建两次，首屏 gzip 差到 39 B（linux 镜像里 113936 / 113897），
 * 因为 vite.config.ts 把每次不同的 __BUILD_TIME__（ISO 时刻）和 __BUILD_COMMIT__（7 位提交号）编进了包，时刻一变，所在块的哈希、
 * 别的块 import 它时写的文件名（name-哈希.js）跟着全变，gzip 结果就抖。这里只在计数前把这三样换成固定值再压缩，产物本身不动；
 * 150 KB 的 W3 照旧按原样字节算。
 * 11-09 补（807a10f deploy-preview 挂在净增 +1179，本机不注入只有 +992）：deploy-preview 构建时注入的公开变量（VITE_PUBLIC_ANON_KEY 这种 JWT、
 * VAPID、Turnstile、Supabase 地址，以及 LEMO_BUILD_VERSION 的 X.Y.Z-preview.N）被原样写进首屏块（env.ts 的常量，在 jsx-runtime 那块），
 * 一个高熵 JWT 就占一两百字节；基线 111404 是不注入时量的。pub 里每一对 [注入值, 不注入时的值] 只换带引号的整个字面量，
 * 把带注入的构建量回“不注入”的样子（键值换成空串，版本号换回 VERSION 文件的值）
 */
export function stableText(text, commits = [], pub = []) {
  let s = text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '2000-01-01T00:00:00.000Z')
    .replace(/-[A-Za-z0-9_-]{8}\.(js|css)\b/g, '-00000000.$1');
  // 压缩后是 commit:`6f0325b`（反引号），也认双引号、单引号
  for (const c of commits) if (c) for (const q of ['`', '"', "'"]) s = s.replaceAll(`${q}${c}${q}`, `${q}0000000${q}`);
  for (const [from, to] of pub) if (from) for (const q of ['`', '"', "'"]) s = s.replaceAll(`${q}${from}${q}`, `${q}${to}${q}`);
  return s;
}

/**
 * 构建时注入进前端的公开变量，返回 [注入值, 不注入时的值]。VITE_PUBLIC_ENV 不管：值只是 preview / production 这种短词，产物里别处也有同样的字面量，
 * 换了会误伤，而且它没注入时也是同一个词（vite 的 mode），几个字节的差不影响 1 KB 的判断。只收 8 个字符以上的值，短值同理怕误伤
 */
export function publicValues(env = process.env, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('VITE_PUBLIC_') || k === 'VITE_PUBLIC_ENV') continue;
    const t = v?.trim();
    if (t && t.length >= 8) out.push([t, '']);
  }
  const ver = env['LEMO_BUILD_VERSION']?.trim();
  if (ver) {
    const base = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
    if (ver !== base) out.push([ver, base]);
  }
  return out;
}

/** 和 vite.config.ts 的 buildCommit() 同一套来源（CI 的 GITHUB_SHA、Pages 的 CF_PAGES_COMMIT_SHA、本机 git），外加取不到时的 unknown */
function buildCommits() {
  const out = ['unknown'];
  const e = process.env['GITHUB_SHA'] ?? process.env['CF_PAGES_COMMIT_SHA'];
  if (e) out.push(e.slice(0, 7));
  try {
    out.push(execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
  } catch {
    // 没有 git（导出的副本）就只有 unknown
  }
  return out;
}

/** 额度用完时报错的开头；batch 是批次名（first-screen-baseline.json 的 current），R-379 起按批次报 */
export const netGrowthMessage = (batch) => `${batch} 首屏净增额度用完，要主持人定从哪里挪空间或放宽（需求编号）`;

/**
 * 当前批次的设置（R-379：首屏净增额度按批次重设，B4 起以 R-378 合入后的 main 为新基线）。data：first-screen-baseline.json 的内容；
 * 返回 { batch, cfg }。current 缺了、batches 里没有这一段都直接报错（不悄悄跳过关卡）
 */
export function currentBatch(data) {
  const batch = data?.current;
  if (typeof batch !== 'string' || batch === '') throw new Error('first-screen-baseline.json 的 current（当前批次名）没写');
  const cfg = data?.batches?.[batch];
  if (!cfg || typeof cfg !== 'object') throw new Error(`first-screen-baseline.json 的 batches 里没有当前批次 ${batch}`);
  return { batch, cfg };
}

/**
 * 相对基线的净增关卡。data：first-screen-baseline.json 的内容，只按 batches[current] 查；
 * 返回 { batch, skip } 或 { batch, base, limit, net, error }（error 为 null 就是通过）
 */
export function netGrowthCheck(firstScreenStable, data, mode) {
  const { batch, cfg } = currentBatch(data);
  if (!mode) return { batch, skip: `${batch} 净增关卡跳过：没给 --mode` };
  if (!(cfg.modes ?? []).includes(mode)) return { batch, skip: `${batch} 净增关卡跳过：${mode} 模式不在 first-screen-baseline.json 的 ${batch}.modes 里` };
  const base = cfg.baseline;
  if (base === null) return { batch, skip: `${batch} 净增关卡跳过：first-screen-baseline.json 的 ${batch} 基线还没定（baseline 为 null）` };
  if (!Number.isInteger(base) || base <= 0) throw new Error(`first-screen-baseline.json 的 ${batch}.baseline 不是正整数`);
  const limit = cfg.limitBytes;
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`first-screen-baseline.json 的 ${batch}.limitBytes 不是非负整数`);
  const net = firstScreenStable - base;
  const error = net > limit ? `${netGrowthMessage(batch)}：首屏（稳定口径）${firstScreenStable} B，基线 ${base} B（${mode}），净增 ${net} B > ${limit} B` : null;
  return { batch, base, limit, net, error };
}

/** 命令行入口（build_web.mjs 构建完直接调它，不另起进程）：argv 是 process.argv.slice(2) 那样的参数，返回退出码 */
export const cli = withUsage((argv) => {
  const appDir = argPath(argv, '--app-dir', 'dist/web/app');
  const baselinePath = argPath(argv, '--baseline', 'build/first-screen-baseline.json');
  const mode = argValue(argv, '--mode');
  const manifest = readManifest(appDir);
  const r = measure(appDir, manifest);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  if (argv.includes('--json')) console.log(JSON.stringify(r));
  else {
    console.log(`首屏 JS（gzip）：${kb(r.firstScreenJs)} / 预算 ${kb(BUDGET.firstScreenJs)}（${r.firstFiles.length} 个文件）`);
    console.log(`全部 JS（gzip）：${kb(r.totalJs)} / 参考 ${kb(BUDGET.totalJs)}`);
  }
  if (r.totalJs > BUDGET.totalJs) console.warn('提示：全部 JS 超过 250 KB（B2 起按真实页面验收）');
  let failed = false;
  if (r.firstScreenJs > BUDGET.firstScreenJs) {
    console.error('W3：首屏 JS 超出预算');
    failed = true;
  }
  const fe = firstFilesError(r.firstFiles.length);
  if (fe) {
    console.error(fe);
    failed = true;
  }
  // 净增关卡比的是 firstScreenStable（去掉构建时刻、提交号、文件名哈希后的 gzip 字节），基线也按这个口径量
  const g = netGrowthCheck(r.firstScreenStable, JSON.parse(readFileSync(baselinePath, 'utf8')), mode);
  if (g.skip) console.log(g.skip);
  else if (g.error) {
    console.error(g.error);
    failed = true;
  } else console.log(`${g.batch} 首屏净增：${g.net} B / 额度 ${g.limit} B（基线 ${g.base} B）`);
  // 预加载表去重的产物核对（vite.config.ts 的 dropHostLoaded，见 check_preload.mjs）。manifest 里该有表的动态 import 在产物里找不到也算失败
  const p = checkPreload(appDir, manifest);
  if (p.errors.length) {
    for (const e of p.errors) console.error(`预加载表去重：${e}`);
    failed = true;
  } else if (p.calls > 0) console.log(`预加载表去重：${p.calls} 处懒加载都核对过（宿主已加载的 JS 不列、其余 JS 一个不少、CSS 和不去重时一样）`);
  return failed ? 1 : 0;
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(cli(process.argv.slice(2)));
