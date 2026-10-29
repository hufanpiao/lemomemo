// publish-run*.test.ts 共用的演练台：假仓库、假工具、假令牌跑 tools/release/publish.ps1（B1 接手清单 OPS-deploy）。
// 不连 Cloudflare、Supabase、GitHub，不用任何真令牌，不真的部署：
// - 仓库：把本仓库当前提交 clone 到临时目录，改三处再提交、打带说明的 tag——lemo-ops 的 KV id 换成假的 32 位十六进制，
//   tools/ci-tools.lock 里 Supabase CLI（windows_amd64）的 SHA-256 换成假安装包的，tools/release/wrangler-tree.lock 换成假依赖树的；
//   加一份只有公开值的 .env.production.local；node_modules 是真目录：typescript 联接到本仓库那份（第 1 步 check_backend 要用），
//   aws4fetch 复制一份（用例要改它，不能碰本仓库的）；备份目录里放好这个提交的“发布前”备份清单（不跑 build/backup.py）；
// - 工具：npm.cmd、node 换成记日志的函数（npm ci tools\deploy 时生成假的依赖树：wrangler\bin\wrangler.js ＋ 同目录的假 wrangler.exe，
//   另有 .bin、.package-lock.json 两样脚本会删掉的；node 跑 ...\wrangler\bin\wrangler.js 时转给那个假 wrangler.exe）；
//   Supabase CLI、wrangler 是现编的假 exe，只把参数和“哪些令牌环境变量有值”（只记名字）写进日志，
//   wrangler secret list 打印 LEMO_FAKE_SECRETS（只有名字的 JSON），LEMO_FAKE_TAMPER_AT 出现在参数里时改一处文件（模拟中途被改）；
//   Invoke-WebRequest、Invoke-RestMethod 换成本地假响应；git、python（build/check_backend.py、build/ci/dist_hash.py）、tar.exe 是真的；
// - 输入：Read-Host 从队列取假值（假令牌只在本测试里），多问一次就失败；剪贴板、注册表检查屏蔽；
// - 每次运行都给脚本一个私有的 TEMP、TMP（publish.ps1 在 $env:TEMP 下建 lemo-publish-*、lemo-nohooks-*），不碰系统临时目录。
// 只在 Windows 上跑（npm.cmd、tar.exe、编假 exe 要 Windows PowerShell）。会清一次本机剪贴板历史（脚本收尾的 Clear-Clip）。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

export const root = join(import.meta.dirname, '..', '..');
const SCRIPT = join(root, 'tools', 'release', 'publish.ps1');
// Git Bash 里跑 vitest 时 PATH 前面是 Git 自带的 GNU tar（不认 C:\ 路径）；脚本要的是 Windows 自带的 tar.exe
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
// 令牌相关的环境变量一律不传给演练：本机窗口里万一有，也不会混进假工具的日志
export const TOKEN_ENV = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const;
const ENV: NodeJS.ProcessEnv = { ...process.env, PATH: `${SYS32};${process.env.PATH ?? ''}` };
for (const k of TOKEN_ENV) delete ENV[k];
export const PS = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8' }).status === 0 ? 'powershell.exe' : null;

// 假值：只在本测试里出现，格式像真的（Read-Secret 要求至少 8 位、Supabase 令牌以 sbp_ 开头）
export const SB_TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_supabase_token_'.padEnd(40, 'z');
export const DB_PW = 'TEST_ONLY_not_a_real_db_password';
export const CF_TOKEN = 'TEST_ONLY_not_a_real_cloudflare_token_xx';
const SECRETS = [SB_TOKEN, DB_PW, CF_TOKEN];
export const REF = 'abcdefghijklmnopqrst';
export const ACCT = '0123456789abcdef0123456789abcdef';
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

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
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
export function tagHere() {
  git(['tag', '-a', '-f', `v${ctx.ver}`, '-m', 'publish-run 测试用']);
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

const FAKE_TOOL_CS = `using System;
using System.IO;
public static class FakeTool {
  static string WorkDir(string exeDir) {
    DirectoryInfo d = new DirectoryInfo(exeDir);
    while (d != null && !d.Name.StartsWith("lemo-publish-")) { d = d.Parent; }
    return d == null ? "" : d.FullName;
  }
  public static int Main(string[] a) {
    string exe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    string name = Path.GetFileNameWithoutExtension(exe);
    string[] keys = { "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID" };
    string env = "";
    foreach (string k in keys) { if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(k))) { env += (env == "" ? "" : ",") + k; } }
    string args = string.Join(" ", a);
    string extra = "CLOUDFLARE_API_BASE_URL=" + Environment.GetEnvironmentVariable("CLOUDFLARE_API_BASE_URL") + ";WRANGLER_WRITE_LOGS=" + Environment.GetEnvironmentVariable("WRANGLER_WRITE_LOGS") + ";SUPABASE_API_URL=" + Environment.GetEnvironmentVariable("SUPABASE_API_URL");
    string[] quietKeys = { "WRANGLER_SEND_METRICS", "DO_NOT_TRACK", "WRANGLER_SEND_ERROR_REPORTS", "WRANGLER_HIDE_BANNER", "WRANGLER_NO_SKILLS_UPDATE_PROMPTS" };
    string quiet = "";
    foreach (string k in quietKeys) { quiet += (quiet == "" ? "" : ";") + k + "=" + Environment.GetEnvironmentVariable(k); }
    File.AppendAllText(Environment.GetEnvironmentVariable("LEMO_FAKE_LOG"), name + "\\t" + args + "\\t" + env + "\\t" + extra + "\\t" + quiet + "\\n");
    string at = Environment.GetEnvironmentVariable("LEMO_FAKE_TAMPER_AT");
    string what = Environment.GetEnvironmentVariable("LEMO_FAKE_TAMPER");
    if (!string.IsNullOrEmpty(at) && !string.IsNullOrEmpty(what) && args.Contains(at)) {
      string w = WorkDir(Path.GetDirectoryName(exe));
      string target = what == "web" ? Path.Combine(Path.Combine(w, "web"), "index.html")
        : what == "tree" ? Path.Combine(Path.Combine(Path.Combine(Path.Combine(Path.Combine(w, "deploy"), "node_modules"), "wrangler"), "bin"), "wrangler.js")
        : what;
      File.AppendAllText(target, "tampered");
    }
    string fail = Environment.GetEnvironmentVariable("LEMO_FAKE_FAIL");
    if (!string.IsNullOrEmpty(fail) && args.Contains(fail)) { Console.Error.WriteLine("fake " + name + " failed"); return 1; }
    if (a.Length >= 2 && a[0] == "secret" && a[1] == "list") { Console.WriteLine(Environment.GetEnvironmentVariable("LEMO_FAKE_SECRETS")); return 0; }
    Console.WriteLine("fake " + name + " ok");
    return 0;
  }
}`;

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
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'publish-run 测试：假的 KV id、Supabase CLI 哈希、wrangler 依赖树哈希']);
  tagHere();
  writeFileSync(join(repo, '.env.production.local'), 'VITE_PUBLIC_SITE=https://example.test\n', 'utf8');
  // node_modules 被 .gitignore 忽略，工作区仍算干净。第 1 步的 check_backend 做类型检查要用本仓库装好的包：
  // 每一项联接过去（不复制），只有 aws4fetch 复制一份（用例会改它）
  const nm = join(repo, 'node_modules');
  mkdirSync(nm);
  for (const e of readdirSync(join(root, 'node_modules'), { withFileTypes: true })) {
    const from = join(root, 'node_modules', e.name);
    if (e.name === 'aws4fetch') cpSync(from, join(nm, e.name), { recursive: true });
    else if (e.isDirectory()) { symlinkSync(from, join(nm, e.name), 'junction'); links.push(join(nm, e.name)); }
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
  /** 假工具参数里含 tamperAt 时改一处文件：web（临时目录里的网页）、tree（wrangler 依赖树）或绝对路径 */
  tamperAt?: string;
  tamper?: string;
  /** wrangler secret list 打印的名单（默认六个都在） */
  secrets?: string[];
  /** 假 npm ci 在 wrangler 依赖树里多放一个文件 */
  treeExtra?: boolean;
  /** git var 这个变量时当作不认识（模拟 2.42 以前的 git：退出码 129） */
  gitVarFail?: string;
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
  const harness = writePs(
    `run-${id}.ps1`,
    `$ErrorActionPreference = 'Stop'
$env:LEMO_FAKE_LOG = ${q(log)}
$env:LEMO_FAKE_FAIL = ${q(o.fail ?? '')}
$env:LEMO_FAKE_CF_DENY = ${q(o.cfDeny ? '1' : '')}
$env:LEMO_FAKE_TAMPER_AT = ${q(o.tamperAt ?? '')}
$env:LEMO_FAKE_TAMPER = ${q(o.tamper ?? '')}
$env:LEMO_FAKE_SECRETS = ${q(secretListJson(o.secrets ?? OPS_SECRETS))}
$env:LEMO_FAKE_TREE_EXTRA = ${q(o.treeExtra ? '1' : '')}
$env:LEMO_FAKE_GITVAR_FAIL = ${q(o.gitVarFail ?? '')}
${Object.entries(env).map(([k, v]) => `[Environment]::SetEnvironmentVariable(${q(k)}, ${q(v)}, 'Process')`).join('\n')}
$T = [string][char]9
function global:L([string]$s) { [IO.File]::AppendAllText($env:LEMO_FAKE_LOG, $s + [char]10) }
# git 是真的，只有 git var 两种情形替换：LEMO_FAKE_GITVAR_FAIL 点名的变量当作不认识（退出码 129，像 2.42 以前的 git）；
# LEMO_FAKE_ATTR_SYSTEM 不为空时 GIT_ATTR_SYSTEM 答这个路径、退出码 0（模拟 GIT_ATTR_NOSYSTEM 没生效）
$global:RealGit = (Get-Command git -CommandType Application | Select-Object -First 1).Source
function global:git {
  $a = @($args)
  $i = [Array]::IndexOf([object[]]$a, 'var')
  $v = if ($i -ge 0 -and $i + 1 -lt $a.Count) { [string]$a[$i + 1] } else { '' }
  if ($v -and $v -ceq $env:LEMO_FAKE_GITVAR_FAIL) { L ('gitvar-fail' + [char]9 + $v); $global:LASTEXITCODE = 129; return }
  if ($v -ceq 'GIT_ATTR_SYSTEM' -and $env:LEMO_FAKE_ATTR_SYSTEM) { $env:LEMO_FAKE_ATTR_SYSTEM; $global:LASTEXITCODE = 0; return }
  & $global:RealGit @a
  $global:LASTEXITCODE = $LASTEXITCODE }
# 本进程（脚本自己）此刻环境变量里有哪些令牌（只记名字）：读令牌、发请求时都应该是空的
function global:PEnv([string]$where) { L ('penv' + $T + $where + $T + ((@(${TOKEN_ENV.map(q).join(', ')}) | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }) -join ',')) }
function global:Get-ItemProperty { $null }
function global:Set-Clipboard { }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
function global:Invoke-WebRequest { param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  L ('download' + $T + $Uri); Copy-Item -LiteralPath ${q(fakeTgz)} -Destination $OutFile }
function global:Invoke-RestMethod { param([string]$Uri, $Headers, $MaximumRedirection)
  PEnv ('rest ' + $Uri)
  if ($Uri -like 'https://api.cloudflare.com/client/v4/accounts/*/workers/scripts') {
    L ('cf' + $T + $Uri + $T + ([string]$Headers.Authorization).StartsWith('Bearer ') + $T + $MaximumRedirection)
    if ($env:LEMO_FAKE_CF_DENY) { throw 'test: 403 Forbidden' }
    return [pscustomobject]@{ success = $true; result = @() } }
  if ($Uri -like 'https://api.supabase.com/v1/projects/*') {
    L ('api' + $T + $Uri + $T + ([string]$Headers.Authorization).StartsWith('Bearer sbp_'))
    return [pscustomobject]@{ name = 'lemomemo'; region = 'ap-northeast-2'; status = 'ACTIVE_HEALTHY' } }
  if ($Uri -like '*/app/version.json') { L ('version' + $T + $Uri); return [pscustomobject]@{ version = ${q(ver)} } }
  throw ('test: 没想到的请求 ' + $Uri) }
function global:npm.cmd {
  $a = @($args); L ('npm' + $T + ($a -join ' ') + $T + (Get-Location).Path)
  if ($a[0] -eq 'ci' -and (Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match 'lemo-deploy-tools')) {
    $nm = Join-Path (Get-Location).Path 'node_modules'
    $bin = Join-Path $nm 'wrangler\\bin'
    New-Item -ItemType Directory -Force -Path $bin, (Join-Path $nm '.bin') | Out-Null
    Copy-Item -LiteralPath ${q(fakeExe)} -Destination (Join-Path $bin 'wrangler.exe')
    Copy-Item -LiteralPath ${q(fakeJs)} -Destination (Join-Path $bin 'wrangler.js')
    Set-Content -LiteralPath (Join-Path $nm '.bin\\wrangler.cmd') -Value '@echo off' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $nm '.package-lock.json') -Value '{}' -Encoding Ascii
    if ($env:LEMO_FAKE_TREE_EXTRA) { Set-Content -LiteralPath (Join-Path $nm 'extra.js') -Value 'x' -Encoding Ascii } }
  if ($a[0] -eq 'run' -and $a[1] -eq 'build') {
    New-Item -ItemType Directory -Force -Path 'dist\\web\\app' | Out-Null
    Set-Content -LiteralPath 'dist\\web\\index.html' -Value 'x' -Encoding Ascii
    Set-Content -LiteralPath 'dist\\web\\app\\version.json' -Value '{}' -Encoding Ascii }
  $global:LASTEXITCODE = 0 }
# node 跑临时目录里的 wrangler\\bin\\wrangler.js 时转给同目录的假 wrangler.exe（真的子进程，日志里记它拿到了哪些令牌）；其余只记日志
function global:node {
  $a = @($args)
  if ($a.Count -gt 0 -and ([string]$a[0]).EndsWith('\\wrangler\\bin\\wrangler.js')) {
    $exe = Join-Path (Split-Path -Parent ([string]$a[0])) 'wrangler.exe'
    $rest = @(if ($a.Count -gt 1) { $a[1..($a.Count - 1)] })
    & $exe @rest
    $global:LASTEXITCODE = $LASTEXITCODE
    return }
  L ('node' + $T + ($a -join ' ')); $global:LASTEXITCODE = 0 }
$global:inputs = New-Object System.Collections.Queue
${inputs.map((v) => `$global:inputs.Enqueue(${q(v)})`).join('\n')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  L ('prompt' + $T + $Prompt)
  PEnv ('prompt ' + $Prompt)
  if ($global:inputs.Count -eq 0) { throw ('test: Read-Host 多问了一次：' + $Prompt) }
  $v = $global:inputs.Dequeue()
  if ($AsSecureString) { $global:lastSec = ConvertTo-SecureString $v -AsPlainText -Force; return $global:lastSec }
  return $v }
$global:lastSec = $null
& ${q(SCRIPT)} -Tag ${q('v' + ver)} -RepoPath ${q(repo)} -BackupRoot ${q(backupRoot)} ${extra}
$code = $LASTEXITCODE
L ('left' + $T + $global:inputs.Count)
# Dispose 过的 SecureString 调 IsReadOnly() 会抛 ObjectDisposedException（Windows PowerShell 5.1 里读 Length 不抛，不能用）
$disposed = if ($null -eq $global:lastSec) { '' } else { try { $null = $global:lastSec.IsReadOnly(); 'no' } catch { 'yes' } }
L ('secdisposed' + $T + $disposed)
$still = @('SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_BASE_URL', 'WRANGLER_WRITE_LOGS', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_METRICS', 'DO_NOT_TRACK', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_HIDE_BANNER', 'WRANGLER_NO_SKILLS_UPDATE_PROMPTS', 'GIT_ATTR_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'GIT_INDEX_FILE','GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1') | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }
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
