// publish-run*.test.ts 共用的演练台：假仓库、假工具、假令牌跑 tools/release/publish.ps1（B1 接手清单 OPS-deploy）。
// 不连 Cloudflare、Supabase、GitHub，不用任何真令牌，不真的部署：
// - 仓库：把本仓库当前提交 clone 到临时目录，改三处再提交、打带说明的 tag（正式 v<VERSION>、预览 v<VERSION>-preview.7）——lemo-ops 的 KV id 换成假的 32 位十六进制，
//   tools/ci-tools.lock 里 Supabase CLI（windows_amd64）的 SHA-256 换成假安装包的，tools/release/wrangler-tree.lock 换成假依赖树的；
//   node_modules 是真目录：每一项联接到本仓库那份（第 1 步 check_backend、发布包里的 copy_shared 要用）；
//   备份目录里放好这个提交的“发布前”备份清单（不跑 build/backup.py）；
// - 发布包（B7a 起 publish.ps1 下载 CI 的产物，不在本机构建）：artifactZip 按 tag 提交现做一份 zip，和 release-build / deploy-preview 出的一样——
//   假网页（index.html、app/version.json、_worker.js/index.js）＋ 仓库里被跟踪的 supabase 文件（正式只带 config.toml、migrations、functions、templates）
//   ＋ 真 node 跑 build/copy_shared.mjs 生成的 _shared/gen ＋（预览）预览专用函数的入口和 config.toml 追加段 ＋ SHA256SUMS；同一提交只做一次；
// - 工具：npm.cmd、node 换成记日志的函数（npm ci tools\deploy 时生成假的依赖树：wrangler\bin\wrangler.js ＋ 同目录的假 wrangler.exe，
//   另有 .bin、.package-lock.json 两样脚本会删掉的；node 跑 ...\wrangler\bin\wrangler.js 时转给那个假 wrangler.exe）；
//   Supabase CLI、wrangler 是现编的假 exe，只把参数和“哪些令牌环境变量有值”（只记名字）写进日志，
//   wrangler secret list 打印 LEMO_FAKE_SECRETS（只有名字的 JSON），LEMO_FAKE_TAMPER_AT 出现在参数里时改一处文件（模拟中途被改）；
//   Invoke-WebRequest、Invoke-RestMethod 换成本地假响应（GitHub 的产物接口、两段式下载、Supabase 的 SQL 接口也在里面），Start-Sleep 不真等；
//   git、python（build/check_backend.py、build/ci/dist_hash.py）、tar.exe 是真的；
// - 输入：Read-Host 从队列取假值（假令牌只在本测试里），多问一次就失败；剪贴板、注册表检查屏蔽；
// - 每次运行都给脚本一个私有的 TEMP、TMP（publish.ps1 在 $env:TEMP 下建 lemo-publish-*、lemo-nohooks-*），不碰系统临时目录。
// 只在 Windows 上跑（npm.cmd、tar.exe、编假 exe 要 Windows PowerShell）。会清一次本机剪贴板历史（脚本收尾的 Clear-Clip）。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { FAKE_TOOL_CS, fakeFunctions, q, TOKEN_ENV } from './publish-run-fakes.ts';
import { artifactZip, type PackMutate } from './publish-run-pack.ts';

export const root = join(import.meta.dirname, '..', '..');
const SCRIPT = join(root, 'tools', 'release', 'publish.ps1');
// Git Bash 里跑 vitest 时 PATH 前面是 Git 自带的 GNU tar（不认 C:\ 路径）；脚本要的是 Windows 自带的 tar.exe
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
// 令牌相关的环境变量一律不传给演练：本机窗口里万一有，也不会混进假工具的日志
export { TOKEN_ENV } from './publish-run-fakes.ts';
const ENV: NodeJS.ProcessEnv = { ...process.env, PATH: `${SYS32};${process.env.PATH ?? ''}` };
for (const k of TOKEN_ENV) delete ENV[k];
export const PS = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8' }).status === 0 ? 'powershell.exe' : null;

// 假值：只在本测试里出现，格式像真的（Read-Secret 要求至少 8 位、Supabase 令牌以 sbp_ 开头）
export const SB_TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_supabase_token_'.padEnd(40, 'z');
export const DB_PW = 'TEST_ONLY_not_a_real_db_password';
export const CF_TOKEN = 'TEST_ONLY_not_a_real_cloudflare_token_xx';
/** GitHub 下载令牌（细粒度令牌以 github_pat_ 开头） */
export const GH_TOKEN = 'github_pat_' + 'TEST_ONLY_not_a_real_github_token_'.padEnd(40, 'z');
const SECRETS = [SB_TOKEN, DB_PW, CF_TOKEN, GH_TOKEN];
export const REF = 'abcdefghijklmnopqrst';
export const ACCT = '0123456789abcdef0123456789abcdef';
/** 预览项目的 ref（publish.ps1 写死的公开值）和演练用的预览 tag 运行号 */
export const PREVIEW_REF = 'yoeqwhygehbaftkppati';
export const PREVIEW_RUN = 7;
/** 完整发布依次要输入的：GitHub 下载令牌、“一致”、ref、Supabase 令牌、数据库密码、Cloudflare 令牌、Account ID、项目名、“确认推送” */
export const FULL = [GH_TOKEN, '一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'];
/** 回滚 -Only functions -Ops：没有数据库密码、没有“确认推送” */
export const ROLLBACK = [GH_TOKEN, '一致', REF, SB_TOKEN, CF_TOKEN, ACCT, 'lemomemo'];
/** -DryRun 要输入的：只有 GitHub 下载令牌和“一致” */
export const DRY = [GH_TOKEN, '一致'];
export const KV_ID = 'fedcba9876543210fedcba9876543210';
/** lemo-ops 的六个密钥名（publish.ps1 的 $script:OpsSecretNames；publish-run-deploy.test.ts 核对和 wrangler.toml 的注释一致） */
export const OPS_SECRETS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'OPS_SECRET', 'RESEND_API_KEY_OPS', 'ALERT_TO', 'ALERT_FROM'];
export const secretListJson = (names: string[]) => JSON.stringify(names.map((name) => ({ name, type: 'secret_text' })));

/** 演练台的状态（setup 填好；每个测试文件各有一份）。sysConfig：私有的 system 一级 git 配置（GIT_CONFIG_SYSTEM 默认指向它） */
export const ctx = { dir: '', repo: '', backupRoot: '', fakeExe: '', fakeTgz: '', fakeJs: '', ver: '', sysConfig: '' };
/** Git for Windows 自带的四项 git-lfs 设置（R-264 放行的就是这四项，值和本机 C:/Program Files/Git/etc/gitconfig 的原值一致） */
export const LFS_SYSTEM_CONFIG = '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n';
/** publish.ps1 的 Set-WranglerEnv 给 wrangler 子进程设的（OPS-deploy-sugg ④） */
export const WRANGLER_QUIET = 'WRANGLER_SEND_METRICS=false;DO_NOT_TRACK=1;WRANGLER_SEND_ERROR_REPORTS=false;WRANGLER_HIDE_BANNER=true;WRANGLER_NO_SKILLS_UPDATE_PROMPTS=true';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function writePs(name: string, text: string): string {
  const p = join(ctx.dir, name);
  writeFileSync(p, '\uFEFF' + text, 'utf8');
  return p;
}
export function git(args: string[], cwd = ctx.repo): string {
  const r = spawnSync('git', ['-c', 'user.name=publish-test', '-c', 'user.email=publish-test@example.test', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
}
function psRun(file: string) {
  const r = spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`${file}：${r.stdout}${r.stderr}`);
  return r.stdout;
}
/** 预览 tag（v<VERSION>-preview.7） */
export const previewTag = () => `v${ctx.ver}-preview.${PREVIEW_RUN}`;
export function tagHere() {
  git(['tag', '-a', '-f', `v${ctx.ver}`, '-m', 'publish-run 测试用']);
  git(['tag', '-a', '-f', previewTag(), '-m', 'publish-run 测试用（预览）']);
}
// 要部署的服务器函数：被 git 跟踪、有 index.ts、不以 _ 开头的目录，按名字排序（和 publish.ps1 的 Get-DeployFunctionNames 一样）
export function functionNames(): string[] {
  const names = git(['ls-files', '--', 'supabase/functions']).split('\n')
    .map((l) => /^supabase\/functions\/([^/]+)\/index\.ts$/u.exec(l.trim())?.[1])
    .filter((n): n is string => n !== undefined && !n.startsWith('_'));
  return names.sort();
}
export function writeBackupManifest() {
  const commit = git(['rev-parse', 'HEAD']);
  const d = join(ctx.backupRoot, `2026-10-29_${ctx.ver}发布前`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '清单.json'), JSON.stringify({ 'git 提交': commit, 恢复测试: { 通过: true } }), 'utf8');
}

/** 和 publish.ps1 的 Get-DistHash、build/ci/dist_hash.py 同一个算法：每个文件“SHA-256␠␠相对路径\n”按路径的 UTF-8 字节排序，再整体算 SHA-256 */
export function treeHash(files: Record<string, Buffer>): { count: number; total: string } {
  const rows = Object.entries(files).sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return { count: rows.length, total: sha256(rows.map(([rel, buf]) => `${sha256(buf)}  ${rel}\n`).join('')) };
}


/** 搭演练台：编假 exe、打假 Supabase CLI 包、clone 假仓库（beforeAll 里调） */
export function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lemo-publish-run-'));
  ctx.dir = dir;
  ctx.repo = join(dir, 'repo');
  ctx.backupRoot = join(dir, 'backup');
  ctx.fakeExe = join(dir, 'fake.exe');
  ctx.sysConfig = join(dir, 'system.gitconfig');
  writeFileSync(ctx.sysConfig, LFS_SYSTEM_CONFIG, 'utf8');
  psRun(writePs('build-fake.ps1', `Add-Type -OutputType ConsoleApplication -OutputAssembly ${q(ctx.fakeExe)} -TypeDefinition @'\n${FAKE_TOOL_CS}\n'@`));
  ctx.fakeJs = join(dir, 'fake-wrangler.js');
  writeFileSync(ctx.fakeJs, '// 假的 wrangler 入口：演练台的 node 函数把它转给同目录的 wrangler.exe\n', 'utf8');
  // 假的 Supabase CLI 安装包
  const pkg = join(dir, 'pkg');
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'supabase.exe'), readFileSync(ctx.fakeExe));
  ctx.fakeTgz = join(dir, 'supabase_fake.tar.gz');
  const t = spawnSync(join(SYS32, 'tar.exe'), ['-czf', ctx.fakeTgz, '-C', pkg, 'supabase.exe'], { encoding: 'utf8' });
  if (t.status !== 0) throw new Error(`tar：${t.stderr}`);
  const sha = sha256(readFileSync(ctx.fakeTgz));

  const repo = ctx.repo;
  git(['clone', '--quiet', '--shared', root, repo], dir);
  // 本仓库可能检出在功能分支上（clone 会跟着检出同名分支）；发布脚本只认 main 上的 tag，演练仓库统一放到 main
  git(['checkout', '-q', '-B', 'main']);
  ctx.ver = readFileSync(join(repo, 'VERSION'), 'utf8').trim();
  const lockPath = join(repo, 'tools', 'ci-tools.lock');
  const lock = readFileSync(lockPath, 'utf8').split('\n').map((l) => {
    const c = l.trim().split(/\s+/);
    if (c.length === 6 && c[0] === 'supabase' && c[2] === 'windows_amd64') return l.replace(c[4] ?? '', sha);
    return l;
  });
  writeFileSync(lockPath, lock.join('\n'), 'utf8');
  const tomlPath = join(repo, 'workers', 'lemo-ops', 'wrangler.toml');
  writeFileSync(tomlPath, readFileSync(tomlPath, 'utf8').replace('REPLACE_WITH_KV_NAMESPACE_ID', KV_ID), 'utf8');
  // 假依赖树（npm 函数装的，脚本删掉 .bin 和 .package-lock.json 以后）就这两个文件
  const tree = treeHash({ 'wrangler/bin/wrangler.exe': readFileSync(ctx.fakeExe), 'wrangler/bin/wrangler.js': readFileSync(ctx.fakeJs) });
  const pkgLock = sha256(readFileSync(join(repo, 'tools', 'deploy', 'package-lock.json')));
  mkdirSync(join(repo, 'tools', 'release'), { recursive: true });
  writeFileSync(join(repo, 'tools', 'release', 'wrangler-tree.lock'), `# publish-run 测试：假依赖树\n${pkgLock} ${tree.count} ${tree.total}\n`, 'utf8');
  // 备份分支（tools\backup\pull.ps1）合进来之前演练仓库里没有它：放一个占位（演练窗口里 powershell.exe 是假函数，不会真跑）
  const pull = join(repo, 'tools', 'backup', 'pull.ps1');
  if (!existsSync(pull)) { mkdirSync(join(repo, 'tools', 'backup'), { recursive: true }); writeFileSync(pull, '# publish-run 测试占位\n', 'utf8'); }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'publish-run 测试：假的 KV id、Supabase CLI 哈希、wrangler 依赖树哈希']);
  tagHere();
  // node_modules 被 .gitignore 忽略，工作区仍算干净。第 1 步的 check_backend 做类型检查、做发布包时的 copy_shared 要用本仓库装好的包：
  // 每一项联接过去（不复制）
  const nm = join(repo, 'node_modules');
  mkdirSync(nm);
  for (const e of readdirSync(join(root, 'node_modules'), { withFileTypes: true })) {
    const from = join(root, 'node_modules', e.name);
    if (e.isDirectory()) { symlinkSync(from, join(nm, e.name), 'junction'); links.push(join(nm, e.name)); }
    else if (e.isFile()) cpSync(from, join(nm, e.name));
  }
  writeBackupManifest();
}
const links: string[] = [];

export function teardown() {
  // 先拆掉联接，免得 rmSync 顺着联接删到本仓库的 node_modules
  for (const l of links.splice(0)) if (existsSync(l)) unlinkSync(l);
  if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
}

/** secDisposed：最后一次 Read-Host -AsSecureString 返回的 SecureString 跑完后是否已 Dispose（yes / no；没读过令牌时为空） */
export type Run = { code: number; out: string; log: string[]; calls: string[]; prompts: string[]; left: number; envLeft: string; temp: string; penv: string[]; secDisposed: string };
export type RunOpts = {
  /** 假工具参数里含这一段就返回 1 */
  fail?: string;
  /** Workers 权限的只读预检返回 403 */
  cfDeny?: boolean;
  /** 运行前设进演练窗口的环境变量 */
  env?: Record<string, string>;
  /** 假工具参数里含 tamperAt 时改一处文件：web（临时目录里的网页）、tree（wrangler 依赖树）或绝对路径；git:<参数> 则跑一次真 git（R-268 第 5 步用） */
  tamperAt?: string;
  tamper?: string;
  /** 正式项目 Edge Function secrets 的名字（默认 CRON_SECRET、OPS_SECRET）；'deny' = 接口回 403（令牌没有 Edge Function Secrets 只读）。B2 安全审查 D1-S3 */
  fnSecrets?: string[] | 'deny';
  /** wrangler secret list 打印的名单（默认六个都在） */
  secrets?: string[];
  /** 假 npm ci 在 wrangler 依赖树里多放一个文件 */
  treeExtra?: boolean;
  /** git var 这个变量时当作不认识（模拟 2.42 以前的 git：退出码 129） */
  gitVarFail?: string;
  /** -Tag 的值，写成 PowerShell 表达式（默认 'v<VERSION>'，-Env preview 时是预览 tag；末尾带换行之类的写法用 ("v4.0.0" + [char]10)） */
  tagPs?: string;
  /** 假发布包：写 SHA256SUMS 之前 / 之后改暂存目录（publish-run-pack.ts） */
  pack?: PackMutate | undefined;
  /** 假 GitHub：list 列产物回 401、none 没有产物、fork 运行来自 fork、zip 下载那一步回 401 */
  gh?: 'list' | 'none' | 'fork' | 'zip';
  /** 假 GitHub 返回的产物所在提交（默认是 tag 的提交） */
  headSha?: string;
  /** 假 GitHub 返回的运行号（默认 PREVIEW_RUN） */
  runNo?: number;
  /** 假 SQL 接口（backup-daily）：none 库里没有 cron（默认，首发）、ok 2 个账号都做完、nojob 有账号没任务、slow 一直做不完、deny 回 403 */
  backup?: 'none' | 'ok' | 'nojob' | 'slow' | 'deny';
  /** 假 tools\backup\pull.ps1（演练窗口里的 powershell.exe 函数）的退出码，默认 0 */
  pull?: number;
  /** 假 version.json 返回的版本（默认就是这次要发的版本） */
  liveVersion?: string;
  /** 运行哪一份 publish.ps1（默认仓库里的 tools/release/publish.ps1；冻结副本单独复制出去的那份用这个） */
  script?: string;
};

export async function runScript(extra: string, inputs: string[], o: RunOpts = {}): Promise<Run> {
  const { dir, repo, backupRoot, fakeExe, fakeTgz, fakeJs, ver } = ctx;
  const id = Math.random().toString(36).slice(2, 10);
  const log = join(dir, `log-${id}.txt`);
  writeFileSync(log, '', 'utf8');
  // 本次运行私有的 TEMP（不依赖系统临时目录，几份全量同时跑也互不影响）
  const temp = join(dir, `temp-${id}`);
  mkdirSync(temp);
  // R-264：system 一级 git 配置默认用私有的那份（只有 Git for Windows 自带的四项 git-lfs），用例传空字符串就是用本机真的。
  // 系统属性文件（R-265）默认用真的 git var：脚本设了 GIT_ATTR_NOSYSTEM=1，应答不出路径；用例设 LEMO_FAKE_ATTR_SYSTEM 模拟没生效
  const env = { TEMP: temp, TMP: temp, GIT_CONFIG_SYSTEM: ctx.sysConfig, ...(o.env ?? {}) };
  // 发布包按 tag 的提交现做（同一提交缓存）；tag 不存在时（个别用例故意的）用 HEAD
  const preview = /-Env preview\b/.test(extra);
  const tag = preview ? previewTag() : `v${ver}`;
  const tagCommit = spawnSync('git', ['rev-parse', '--verify', '-q', `${tag}^{commit}`], { cwd: repo, encoding: 'utf8' }).stdout.trim() || git(['rev-parse', 'HEAD']);
  const pack = artifactZip({ dir, repo, ver, runNo: PREVIEW_RUN, kind: preview ? 'preview' : 'production', mutate: o.pack });
  const live = o.liveVersion ?? (preview ? `${ver}-preview.${PREVIEW_RUN}` : ver);
  const harness = writePs(
    `run-${id}.ps1`,
    `$ErrorActionPreference = 'Stop'
$env:LEMO_FAKE_LOG = ${q(log)}
$env:LEMO_FAKE_FAIL = ${q(o.fail ?? '')}
$env:LEMO_FAKE_CF_DENY = ${q(o.cfDeny ? '1' : '')}
$env:LEMO_FAKE_FN_SECRETS = ${q(o.fnSecrets === 'deny' ? '' : (o.fnSecrets ?? ['CRON_SECRET', 'OPS_SECRET']).join(','))}
$env:LEMO_FAKE_FN_SECRETS_DENY = ${q(o.fnSecrets === 'deny' ? '1' : '')}
$env:LEMO_FAKE_TAMPER_AT = ${q(o.tamperAt ?? '')}
$env:LEMO_FAKE_TAMPER = ${q(o.tamper ?? '')}
$env:LEMO_FAKE_SECRETS = ${q(secretListJson(o.secrets ?? OPS_SECRETS))}
$env:LEMO_FAKE_TREE_EXTRA = ${q(o.treeExtra ? '1' : '')}
$env:LEMO_FAKE_GITVAR_FAIL = ${q(o.gitVarFail ?? '')}
$env:LEMO_FAKE_ZIP = ${q(pack.zip)}
$env:LEMO_FAKE_HEAD_SHA = ${q(o.headSha ?? tagCommit)}
$env:LEMO_FAKE_RUN_NO = ${q(String(o.runNo ?? PREVIEW_RUN))}
$env:LEMO_FAKE_GH = ${q(o.gh ?? '')}
$env:LEMO_FAKE_BACKUP = ${q(o.backup ?? 'none')}
$env:LEMO_FAKE_PULL = ${q(String(o.pull ?? 0))}
$env:LEMO_FAKE_VERSION = ${q(live)}
${Object.entries(env).map(([k, v]) => `[Environment]::SetEnvironmentVariable(${q(k)}, ${q(v)}, 'Process')`).join('\n')}
${fakeFunctions({ fakeTgz, fakeExe, fakeJs, ver, inputs })}
& ${q(o.script ?? SCRIPT)} -Tag ${o.tagPs ?? q(tag)} -RepoPath ${q(repo)} -BackupRoot ${q(backupRoot)} ${extra}
$code = $LASTEXITCODE
L ('left' + $T + $global:inputs.Count)
# Dispose 过的 SecureString 调 IsReadOnly() 会抛 ObjectDisposedException（Windows PowerShell 5.1 里读 Length 不抛，不能用）
$disposed = if ($null -eq $global:lastSec) { '' } else { try { $null = $global:lastSec.IsReadOnly(); 'no' } catch { 'yes' } }
L ('secdisposed' + $T + $disposed)
$still = @('SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_BASE_URL', 'WRANGLER_WRITE_LOGS', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_METRICS', 'DO_NOT_TRACK', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_HIDE_BANNER', 'WRANGLER_NO_SKILLS_UPDATE_PROMPTS', 'GIT_ATTR_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'GIT_INDEX_FILE','GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2') | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }
L ('envleft' + $T + ($still -join ','))
exit $code`,
  );
  const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (out += c));
  child.stderr.on('data', (c: string) => (out += c));
  const code = await new Promise<number>((ok) => child.on('close', (c) => ok(c ?? -1)));
  const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l !== '');
  const calls = lines.filter((l) => /^(supabase|wrangler)\t/.test(l));
  const prompts = lines.filter((l) => l.startsWith('prompt\t'));
  const penv = lines.filter((l) => l.startsWith('penv\t'));
  const leftLine = lines.find((l) => l.startsWith('left\t'));
  const envLine = lines.find((l) => l.startsWith('envleft\t'));
  const secLine = lines.find((l) => l.startsWith('secdisposed\t'));
  return {
    code, out, log: lines, calls, prompts, penv, temp, left: leftLine ? Number(leftLine.split('\t')[1]) : -1, envLeft: envLine ? (envLine.split('\t')[1] ?? '') : '?',
    secDisposed: secLine ? (secLine.split('\t')[1] ?? '') : '?',
  };
}

// 每次调用 wrangler 都带 --env-file <空文件>，并且进程里 CLOUDFLARE_API_BASE_URL 是官方地址、不写日志文件；
// 不发统计和错误报告、不打印横幅（不去 npm 查新版本）、不查 skills 更新（OPS-deploy-sugg ④）
export function wranglerSafe(r: Run) {
  const ws = r.calls.filter((x) => x.startsWith('wrangler\t'));
  expect(ws.length).toBeGreaterThan(0);
  for (const c of ws) {
    expect(c.split('\t')[1], c).toMatch(/ --env-file \S+empty\.env$/u);
    expect(c.split('\t')[3], c).toBe('CLOUDFLARE_API_BASE_URL=https://api.cloudflare.com/client/v4;WRANGLER_WRITE_LOGS=false;SUPABASE_API_URL=https://api.supabase.com');
    expect(c.split('\t')[4], c).toBe(WRANGLER_QUIET);
  }
  // Supabase CLI 调用时管理接口地址是官方的
  for (const c of r.calls.filter((x) => x.startsWith('supabase\t'))) {
    expect(c.split('\t')[3] ?? '', c).toMatch(/;SUPABASE_API_URL=https:\/\/api\.supabase\.com$/u);
  }
}

export const has = (r: Run, re: RegExp) => r.calls.some((c) => re.test(c));
export function noSecrets(r: Run) {
  for (const s of SECRETS) {
    expect(r.out.includes(s), '屏幕输出里出现了令牌').toBe(false);
    expect(r.log.join('\n').includes(s), '工具参数或日志里出现了令牌').toBe(false);
  }
}
