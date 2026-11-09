// 体积预算（架构 2.6、W3）：按 Vite 的 manifest 找出首屏要下载的 JS（入口 + 它静态 import 的 chunk），gzip 后合计
// 首屏 JS ≤ 150 KB（含 React）超了就失败；全部 JS ≤ 250 KB 只提示（硬验收在 B2，B0 只做脚本，空白 App 的数字没有意义）
// B3 净增额度（11-09，B3 任务单架构审“首屏净增 ≤ 1 KB”、代码审 B1）：--mode 给了、build/first-screen-baseline.json 里有这个模式和平台的基线时，
// 首屏 JS 超过 基线 + limitBytes 也失败。150 KB 总量管不到这 1 KB。没有基线的模式（production 要真密钥构建、development、test）只提示不查
// 用法：node build/check_size.mjs [--json] [--app-dir <目录>] [--mode <模式>] [--baseline <文件>]
//（--app-dir 默认 dist/web/app；违规样例测试用它指到临时目录，QA D-06；--baseline 默认 build/first-screen-baseline.json，测试用它换成临时文件）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = { firstScreenJs: 150 * 1024, totalJs: 250 * 1024 };

/** manifest：Vite 的 .vite/manifest.json 内容；entryKey：入口在 manifest 里的键 */
export function firstScreenFiles(manifest, entryKey) {
  const seen = new Set();
  const files = [];
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`manifest 里没有 ${key}`);
    files.push(chunk.file);
    for (const k of chunk.imports ?? []) visit(k);
  };
  visit(entryKey);
  return files;
}

export function measure(appDir) {
  // 构建时在 app/.vite/，构建完挪到 dist/vite-manifest/（不发布）
  const manifestPath = [resolve(appDir, '.vite/manifest.json'), resolve(appDir, '../../vite-manifest/manifest.json')].find((p) =>
    existsSync(p),
  );
  if (!manifestPath) throw new Error('找不到 Vite 的 manifest.json，先运行 npm run build');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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

export const NET_GROWTH_MESSAGE = 'B3 首屏净增额度用完，要主持人定从哪里挪空间或放宽（需求编号）';

/**
 * 相对基线的净增关卡。data：first-screen-baseline.json 的内容；返回 { skip } 或 { base, limit, net, error }（error 为 null 就是通过）
 */
export function netGrowthCheck(firstScreenStable, data, mode) {
  if (!mode) return { skip: '净增关卡跳过：没给 --mode' };
  if (!(data?.modes ?? []).includes(mode)) return { skip: `净增关卡跳过：${mode} 模式不在 first-screen-baseline.json 的 modes 里` };
  const base = data.baseline;
  if (base === null) return { skip: '净增关卡跳过：first-screen-baseline.json 的基线还没定（baseline 为 null）' };
  if (!Number.isInteger(base) || base <= 0) throw new Error('first-screen-baseline.json 的 baseline 不是正整数');
  const limit = data.limitBytes;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('first-screen-baseline.json 的 limitBytes 不是非负整数');
  const net = firstScreenStable - base;
  const error = net > limit ? `${NET_GROWTH_MESSAGE}：首屏（稳定口径）${firstScreenStable} B，基线 ${base} B（${mode}），净增 ${net} B > ${limit} B` : null;
  return { base, limit, net, error };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const appDir = resolve(argValue('--app-dir') ?? resolve(root, 'dist/web/app'));
  const baselinePath = resolve(argValue('--baseline') ?? resolve(root, 'build/first-screen-baseline.json'));
  const r = measure(appDir);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  if (process.argv.includes('--json')) console.log(JSON.stringify(r));
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
  // 净增关卡比的是 firstScreenStable（去掉构建时刻、提交号、文件名哈希后的 gzip 字节），基线也按这个口径量
  const g = netGrowthCheck(r.firstScreenStable, JSON.parse(readFileSync(baselinePath, 'utf8')), argValue('--mode'));
  if (g.skip) console.log(g.skip);
  else if (g.error) {
    console.error(g.error);
    failed = true;
  } else console.log(`B3 首屏净增：${g.net} B / 额度 ${g.limit} B（基线 ${g.base} B）`);
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
