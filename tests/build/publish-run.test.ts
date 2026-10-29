// tools/release/publish.ps1 从头跑到尾（B1 接手清单 OPS-deploy：-Ops 部署 lemo-ops、-Only functions 只部署或回滚服务器函数）。
// 不连 Cloudflare、Supabase、GitHub，不用任何真令牌，不真的部署：
// - 仓库：把本仓库当前提交 clone 到临时目录，改两处再提交、打带说明的 tag——lemo-ops 的 KV id 换成假的 32 位十六进制，
//   tools/ci-tools.lock 里 Supabase CLI（windows_amd64）的 SHA-256 换成假安装包的；加一份只有公开值的 .env.production.local；
//   备份目录里放好这个提交的“发布前”备份清单（不跑 build/backup.py）；
// - 工具：npm.cmd、node 换成记日志的函数（npm ci tools\deploy 时生成假的 wrangler.cmd）；Supabase CLI、wrangler 是现编的假 exe，
//   只把参数和“哪些令牌环境变量有值”（只记名字）写进日志；Invoke-WebRequest、Invoke-RestMethod 换成本地假响应；
//   git、python（build/check_backend.py、build/ci/dist_hash.py）、tar.exe 是真的；
// - 输入：Read-Host 从队列取假值（假令牌只在本测试里），多问一次就失败；剪贴板、注册表检查屏蔽。
// 核对：-DryRun 不读令牌、不调部署工具，-Ops 时只做 wrangler deploy --dry-run；正式路径的部署顺序（函数 → lemo-ops → 网页）、
// -Only functions 不 link、不 db push、不部署 Pages、不要数据库密码；usage-report 和 lemo-ops 必须同一次部署；KV id 是占位值就停；
// 屏幕输出和工具参数里没有任何令牌。（解析和中文弯引号的静态检查在 ps1-static.test.ts，覆盖 tools/ 下全部 .ps1。）只在 Windows 上跑（npm.cmd、tar.exe、编假 exe 要 Windows PowerShell）。
// 会清一次本机剪贴板历史（脚本收尾的 Clear-Clip，同 set-fn-role-passwords-run.test.ts）。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const SCRIPT = join(root, 'tools', 'release', 'publish.ps1');
// Git Bash 里跑 vitest 时 PATH 前面是 Git 自带的 GNU tar（不认 C:\ 路径）；脚本要的是 Windows 自带的 tar.exe
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const ENV = { ...process.env, PATH: `${SYS32};${process.env.PATH ?? ''}` };
const PS = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8' }).status === 0 ? 'powershell.exe' : null;

// 假值：只在本测试里出现，格式像真的（Read-Secret 要求至少 8 位、Supabase 令牌以 sbp_ 开头）
const SB_TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_supabase_token_'.padEnd(40, 'z');
const DB_PW = 'TEST_ONLY_not_a_real_db_password';
const CF_TOKEN = 'TEST_ONLY_not_a_real_cloudflare_token_xx';
const SECRETS = [SB_TOKEN, DB_PW, CF_TOKEN];
const REF = 'abcdefghijklmnopqrst';
const ACCT = '0123456789abcdef0123456789abcdef';
const KV_ID = 'fedcba9876543210fedcba9876543210';

let dir = '';
let repo = '';
let backupRoot = '';
let fakeExe = '';
let fakeTgz = '';
let ver = '';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
function writePs(name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, '\uFEFF' + text, 'utf8');
  return p;
}
function git(args: string[], cwd = repo): string {
  const r = spawnSync('git', ['-c', 'user.name=publish-test', '-c', 'user.email=publish-test@example.test', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
}
function psRun(file: string) {
  const r = spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`${file}：${r.stdout}${r.stderr}`);
  return r.stdout;
}
function tagHere() {
  git(['tag', '-a', '-f', `v${ver}`, '-m', 'publish-run 测试用']);
}
// 要部署的服务器函数：被 git 跟踪、有 index.ts、不以 _ 开头的目录，按名字排序（和 publish.ps1 的 Get-DeployFunctionNames 一样）
function functionNames(): string[] {
  const names = git(['ls-files', '--', 'supabase/functions']).split('\n')
    .map((l) => /^supabase\/functions\/([^/]+)\/index\.ts$/u.exec(l.trim())?.[1])
    .filter((n): n is string => n !== undefined && !n.startsWith('_'));
  return names.sort();
}
function writeBackupManifest() {
  const commit = git(['rev-parse', 'HEAD']);
  const d = join(backupRoot, `2026-10-29_${ver}发布前`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '清单.json'), JSON.stringify({ 'git 提交': commit, 恢复测试: { 通过: true } }), 'utf8');
}

type Run = { code: number; out: string; log: string[]; calls: string[]; prompts: string[]; left: number; envLeft: string };

async function runScript(extra: string, inputs: string[], fail = '', cfDeny = false, preEnv: Record<string, string> = {}): Promise<Run> {
  const id = Math.random().toString(36).slice(2, 10);
  const log = join(dir, `log-${id}.txt`);
  writeFileSync(log, '', 'utf8');
  const harness = writePs(
    `run-${id}.ps1`,
    `$ErrorActionPreference = 'Stop'
$env:LEMO_FAKE_LOG = ${q(log)}
$env:LEMO_FAKE_FAIL = ${q(fail)}
$env:LEMO_FAKE_CF_DENY = ${q(cfDeny ? '1' : '')}
${Object.entries(preEnv).map(([k, v]) => `[Environment]::SetEnvironmentVariable(${q(k)}, ${q(v)}, 'Process')`).join('\n')}
$T = [string][char]9
function global:L([string]$s) { [IO.File]::AppendAllText($env:LEMO_FAKE_LOG, $s + [char]10) }
function global:Get-ItemProperty { $null }
function global:Set-Clipboard { }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
function global:Invoke-WebRequest { param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  L ('download' + $T + $Uri); Copy-Item -LiteralPath ${q(fakeTgz)} -Destination $OutFile }
function global:Invoke-RestMethod { param([string]$Uri, $Headers, $MaximumRedirection)
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
    $bin = Join-Path (Get-Location).Path 'node_modules\\.bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Copy-Item -LiteralPath ${q(fakeExe)} -Destination (Join-Path $bin 'wrangler.exe')
    Set-Content -LiteralPath (Join-Path $bin 'wrangler.cmd') -Value '@"%~dp0wrangler.exe" %*' -Encoding Ascii }
  if ($a[0] -eq 'run' -and $a[1] -eq 'build') {
    New-Item -ItemType Directory -Force -Path 'dist\\web\\app' | Out-Null
    Set-Content -LiteralPath 'dist\\web\\index.html' -Value 'x' -Encoding Ascii
    Set-Content -LiteralPath 'dist\\web\\app\\version.json' -Value '{}' -Encoding Ascii }
  $global:LASTEXITCODE = 0 }
function global:node { L ('node' + $T + ($args -join ' ')); $global:LASTEXITCODE = 0 }
$global:inputs = New-Object System.Collections.Queue
${inputs.map((v) => `$global:inputs.Enqueue(${q(v)})`).join('\n')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  L ('prompt' + $T + $Prompt)
  if ($global:inputs.Count -eq 0) { throw ('test: Read-Host 多问了一次：' + $Prompt) }
  $v = $global:inputs.Dequeue()
  if ($AsSecureString) { return (ConvertTo-SecureString $v -AsPlainText -Force) }
  return $v }
& ${q(SCRIPT)} -Tag ${q('v' + ver)} -RepoPath ${q(repo)} -BackupRoot ${q(backupRoot)} ${extra}
$code = $LASTEXITCODE
L ('left' + $T + $global:inputs.Count)
$still = @('SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_BASE_URL', 'WRANGLER_WRITE_LOGS', 'WRANGLER_LOG_PATH', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1') | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }
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
  const leftLine = lines.find((l) => l.startsWith('left\t'));
  const envLine = lines.find((l) => l.startsWith('envleft\t'));
  return { code, out, log: lines, calls, prompts, left: leftLine ? Number(leftLine.split('\t')[1]) : -1, envLeft: envLine ? (envLine.split('\t')[1] ?? '') : '?' };
}

// 每次调用 wrangler 都带 --env-file <空文件>，并且进程里 CLOUDFLARE_API_BASE_URL 是官方地址、不写日志文件
function wranglerSafe(r: Run) {
  for (const c of r.calls.filter((x) => x.startsWith('wrangler\t'))) {
    expect(c.split('\t')[1], c).toMatch(/ --env-file \S+empty\.env$/u);
    expect(c.split('\t')[3], c).toBe('CLOUDFLARE_API_BASE_URL=https://api.cloudflare.com/client/v4;WRANGLER_WRITE_LOGS=false;SUPABASE_API_URL=https://api.supabase.com');
  }
  // Supabase CLI 调用时管理接口地址是官方的
  for (const c of r.calls.filter((x) => x.startsWith('supabase\t'))) {
    expect(c.split('\t')[3] ?? '', c).toMatch(/;SUPABASE_API_URL=https:\/\/api\.supabase\.com$/u);
  }
}

const has = (r: Run, re: RegExp) => r.calls.some((c) => re.test(c));
function noSecrets(r: Run) {
  for (const s of SECRETS) {
    expect(r.out.includes(s), '屏幕输出里出现了令牌').toBe(false);
    expect(r.log.join('\n').includes(s), '工具参数或日志里出现了令牌').toBe(false);
  }
}

describe.skipIf(!PS)('publish.ps1 从头跑到尾（假仓库、假工具、假令牌）', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-publish-run-'));
    repo = join(dir, 'repo');
    backupRoot = join(dir, 'backup');
    // 假的 Supabase CLI / wrangler：记下参数和哪些令牌环境变量有值（只记名字），LEMO_FAKE_FAIL 出现在参数里就返回 1
    fakeExe = join(dir, 'fake.exe');
    psRun(
      writePs(
        'build-fake.ps1',
        `Add-Type -OutputType ConsoleApplication -OutputAssembly ${q(fakeExe)} -TypeDefinition @'
using System;
using System.IO;
public static class FakeTool {
  public static int Main(string[] a) {
    string name = Path.GetFileNameWithoutExtension(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName);
    string[] keys = { "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID" };
    string env = "";
    foreach (string k in keys) { if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(k))) { env += (env == "" ? "" : ",") + k; } }
    string args = string.Join(" ", a);
    string extra = "CLOUDFLARE_API_BASE_URL=" + Environment.GetEnvironmentVariable("CLOUDFLARE_API_BASE_URL") + ";WRANGLER_WRITE_LOGS=" + Environment.GetEnvironmentVariable("WRANGLER_WRITE_LOGS") + ";SUPABASE_API_URL=" + Environment.GetEnvironmentVariable("SUPABASE_API_URL");
    File.AppendAllText(Environment.GetEnvironmentVariable("LEMO_FAKE_LOG"), name + "\\t" + args + "\\t" + env + "\\t" + extra + "\\n");
    string fail = Environment.GetEnvironmentVariable("LEMO_FAKE_FAIL");
    if (!string.IsNullOrEmpty(fail) && args.Contains(fail)) { Console.Error.WriteLine("fake " + name + " failed"); return 1; }
    Console.WriteLine("fake " + name + " ok");
    return 0;
  }
}
'@`,
      ),
    );
    // 假的 Supabase CLI 安装包
    const pkg = join(dir, 'pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'supabase.exe'), readFileSync(fakeExe));
    fakeTgz = join(dir, 'supabase_fake.tar.gz');
    const t = spawnSync(join(SYS32, 'tar.exe'), ['-czf', fakeTgz, '-C', pkg, 'supabase.exe'], { encoding: 'utf8' });
    if (t.status !== 0) throw new Error(`tar：${t.stderr}`);
    const sha = createHash('sha256').update(readFileSync(fakeTgz)).digest('hex');

    git(['clone', '--quiet', '--shared', root, repo], dir);
    ver = readFileSync(join(repo, 'VERSION'), 'utf8').trim();
    const lockPath = join(repo, 'tools', 'ci-tools.lock');
    const lock = readFileSync(lockPath, 'utf8').split('\n').map((l) => {
      const c = l.trim().split(/\s+/);
      if (c.length === 6 && c[0] === 'supabase' && c[2] === 'windows_amd64') return l.replace(c[4] ?? '', sha);
      return l;
    });
    writeFileSync(lockPath, lock.join('\n'), 'utf8');
    const tomlPath = join(repo, 'workers', 'lemo-ops', 'wrangler.toml');
    writeFileSync(tomlPath, readFileSync(tomlPath, 'utf8').replace('REPLACE_WITH_KV_NAMESPACE_ID', KV_ID), 'utf8');
    git(['commit', '-q', '-am', 'publish-run 测试：假的 KV id 和 Supabase CLI 哈希']);
    tagHere();
    writeFileSync(join(repo, '.env.production.local'), 'VITE_PUBLIC_SITE=https://example.test\n', 'utf8');
    // 第 1 步的 build/check_backend.py 要用 node_modules 里的 typescript：联接到本仓库已装好的那份（node_modules 被 .gitignore 忽略，工作区仍算干净）
    symlinkSync(join(root, 'node_modules'), join(repo, 'node_modules'), 'junction');
    writeBackupManifest();
  }, 300_000);

  afterAll(() => {
    // 先拆掉联接，免得 rmSync 顺着联接删到本仓库的 node_modules
    const link = repo ? join(repo, 'node_modules') : '';
    if (link && existsSync(link)) unlinkSync(link);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('-DryRun -Ops：构建、装工具、lemo-ops 只做 --dry-run；不读令牌、不调 supabase', async () => {
    const r = await runScript('-DryRun -Ops', ['一致']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('这次要部署：数据库迁移 → 服务器函数 → lemo-ops → 网页（Pages）');
    expect(r.out).toContain('lemo-ops 的配置可以部署');
    expect(r.out).toContain('lemo-ops 打包演练通过');
    expect(r.out).toContain('演练（-DryRun）到此结束');
    expect(r.log.some((l) => l.startsWith('npm\trun build'))).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^wrangler\tdeploy --config workers\\lemo-ops\\wrangler\.toml --dry-run --outdir \S+lemo-ops-dry --env-file \S+empty\.env\t\t/u);
    wranglerSafe(r);
    expect(r.envLeft).toBe('');
    expect(r.prompts).toHaveLength(1);
    expect(r.left).toBe(0);
    noSecrets(r);
  }, 180_000);

  it('-DryRun -Only functions（不加 -Ops）：这个 tag 有 usage-report 和 lemo-ops，第 1 步就停', async () => {
    const r = await runScript('-DryRun -Only functions', []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('usage-report 和 lemo-ops 必须同一次部署');
    expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.prompts).toEqual([]);
  }, 180_000);

  it('-DryRun -Only functions -Ops：不构建网页；装 Supabase CLI 和 wrangler，lemo-ops 只做 --dry-run', async () => {
    const r = await runScript('-DryRun -Only functions -Ops', []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('这次要部署：服务器函数 → lemo-ops（');
    expect(r.out).toContain('-Only functions：跳过（不部署网页）');
    // 项目本身的 npm ci、npm run build 都不跑；只在临时目录里装 tools\deploy 的 wrangler
    const npm = r.log.filter((l) => l.startsWith('npm\t'));
    expect(npm.some((l) => l.split('\t')[2] === repo), npm.join('\n')).toBe(false);
    expect(npm.some((l) => l.startsWith('npm\tci ') && l.endsWith('\\deploy'))).toBe(true);
    expect(r.log.some((l) => l.startsWith('download\thttps://github.com/supabase/cli/'))).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^wrangler\tdeploy --config workers\\lemo-ops\\wrangler\.toml --dry-run /u);
    wranglerSafe(r);
    expect(r.prompts).toEqual([]);
    noSecrets(r);
  }, 180_000);

  it('正式路径 -Ops（假令牌）：db push → 函数 → lemo-ops → 网页，顺序对；令牌不进参数、不上屏幕', async () => {
    const r = await runScript('-Ops', ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送']);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    const seq = r.calls.map((c) => c.split('\t')[0] + ' ' + (c.split('\t')[1] ?? '').split(' ').slice(0, 2).join(' '));
    expect(seq).toEqual([
      'wrangler deploy --config',  // 第 4 步打包演练（--dry-run）
      'supabase link --project-ref',
      'supabase db push',
      'supabase db push',
      'supabase functions deploy',
      'wrangler deploy --config',
      'wrangler pages deploy',
    ]);
    expect(r.calls[0]).toContain('--dry-run');
    // 打包演练时还没有任何令牌
    expect(r.calls[0]?.split('\t')[2]).toBe('');
    // 服务器函数逐个写出名字部署（M2），不是“不写名字＝全部部署”
    expect(functionNames().length).toBeGreaterThan(0);
    expect(r.calls[4]).toContain(`functions deploy ${functionNames().join(' ')} --project-ref ${REF} --use-api --yes\t`);
    expect(r.out).toContain('网页产物和第 3 步核对过的一致');
    const ops = r.calls[5] ?? '';
    expect(ops).toMatch(new RegExp(`^wrangler\\tdeploy --config workers\\\\lemo-ops\\\\wrangler\\.toml --tag v${ver.replace(/\./g, '\\.')} --message v${ver.replace(/\./g, '\\.')}@[0-9a-f]{12} --env-file \\S+empty\\.env\\t`, 'u'));
    wranglerSafe(r);
    // 改库之前做了 Workers 权限的只读预检（带令牌、不跟随重定向）
    const cfAt = r.log.findIndex((l) => l.startsWith('cf\t'));
    expect(cfAt).toBeGreaterThan(-1);
    expect(r.log[cfAt]).toMatch(/\tTrue\t0$/u);
    expect(cfAt).toBeLessThan(r.log.findIndex((l) => l.startsWith('supabase\tlink')));
    expect(r.envLeft, '跑完以后环境变量没清干净').toBe('');
    expect(ops.split('\t')[2]).toContain('CLOUDFLARE_API_TOKEN');
    expect(ops.split('\t')[2]).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(r.log.some((l) => l.startsWith('api\t') && l.endsWith('\tTrue'))).toBe(true);
    expect(r.out).toContain('lemo-ops 部署完成');
    expect(r.out).toContain(`线上已是 ${ver}`);
    expect(r.out).toContain('已清掉本窗口里的令牌');
    noSecrets(r);
  }, 180_000);

  it('回滚 -Only functions -Ops（假令牌）：不 link、不 db push、不部署 Pages、不要数据库密码；函数后紧接着 lemo-ops', async () => {
    const r = await runScript('-Only functions -Ops', [REF, SB_TOKEN, CF_TOKEN, ACCT, 'lemomemo']);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    expect(r.prompts.some((p) => p.includes('数据库密码'))).toBe(false);
    expect(has(r, /^supabase\t(link|db )/u)).toBe(false);
    expect(has(r, /^wrangler\tpages /u)).toBe(false);
    const seq = r.calls.map((c) => c.split('\t')[0] + ' ' + (c.split('\t')[1] ?? '').split(' ')[0]);
    expect(seq).toEqual(['wrangler deploy', 'supabase functions', 'wrangler deploy']);
    const fn = r.calls[1] ?? '';
    expect(fn).toContain(`functions deploy ${functionNames().join(' ')} --project-ref ${REF} --use-api --yes\t`);
    expect(fn.split('\t')[2]).not.toContain('SUPABASE_DB_PASSWORD');
    expect(r.calls[2]).toContain('--message v');
    wranglerSafe(r);
    expect(r.envLeft).toBe('');
    expect(r.out).toContain('不核对 version.json');
    expect(r.log.some((l) => l.startsWith('version\t'))).toBe(false);
    noSecrets(r);
  }, 180_000);

  it('lemo-ops 部署失败：函数已部署，停下、不再部署网页，并说清现在的状态和怎么重跑', async () => {
    const r = await runScript('-Ops', ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'], '--message');
    expect(r.code).toBe(1);
    expect(r.out).toContain('发布停止：lemo-ops 部署失败');
    expect(r.out).toContain('数据库迁移已推、服务器函数已是新版，lemo-ops 和网页还是旧版');
    expect(r.out).toContain('同一个 tag、同样的参数原样重跑');
    expect(has(r, /^supabase\tfunctions deploy /u)).toBe(true);
    expect(has(r, /^wrangler\tdeploy --config \S+ --tag \S+ --message /u)).toBe(true);
    expect(r.envLeft).toBe('');
    expect(has(r, /^wrangler\tpages /u)).toBe(false);
    expect(r.out).toContain('已清掉本窗口里的令牌');
    noSecrets(r);
  }, 180_000);

  it('Cloudflare 令牌没有 Workers 权限：只读预检失败，停在改库之前', async () => {
    const r = await runScript('-Ops', ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'], '', true);
    expect(r.code).toBe(1);
    expect(r.out).toContain('读不了 Worker 列表');
    expect(has(r, /^supabase\t/u)).toBe(false);
    expect(r.left).toBe(1);
    expect(r.envLeft).toBe('');
    noSecrets(r);
  }, 180_000);

  // M1：wrangler pages deploy 从仓库根目录往上找配置和重定向文件；Supabase CLI 读 supabase\.env*；代理、global key 之类的环境变量
  const stopCases: { name: string; path?: () => string; env?: Record<string, string>; want: string }[] = [
    { name: '仓库根目录有 .wrangler\\deploy\\config.json（重定向文件）', path: () => join(repo, '.wrangler', 'deploy', 'config.json'), want: '会自动采用的配置文件' },
    { name: '上一级目录有 wrangler.toml', path: () => join(dir, 'wrangler.toml'), want: '会自动采用的配置文件' },
    { name: 'supabase\\.env.local（Supabase CLI 会读）', path: () => join(repo, 'supabase', '.env.local'), want: 'supabase\\.env.local' },
    { name: '根目录有 .env.production', path: () => join(repo, '.env.production'), want: '自动读的环境文件：.env.production' },
    { name: '窗口里有 HTTPS_PROXY', env: { HTTPS_PROXY: 'http://127.0.0.1:9' }, want: '不该有的环境变量：HTTPS_PROXY' },
    { name: '窗口里有 CLOUDFLARE_API_KEY ＋ CLOUDFLARE_EMAIL（global key 优先于令牌）', env: { CLOUDFLARE_API_KEY: 'x', CLOUDFLARE_EMAIL: 'a@example.test' }, want: 'CLOUDFLARE_API_KEY、CLOUDFLARE_EMAIL' },
    // M2：被 git 忽略的函数文件（git status 看不见）会跟着正式部署上线
    { name: 'functions\\tmp\\x.ts（被 git 忽略）', path: () => join(repo, 'functions', 'tmp', 'x.ts'), want: '会跟着正式部署上线：functions/tmp/x.ts' },
    { name: 'supabase\\functions\\tmp\\index.ts（被 git 忽略）', path: () => join(repo, 'supabase', 'functions', 'tmp', 'index.ts'), want: '会跟着正式部署上线：supabase/functions/tmp/index.ts' },
    { name: '窗口里有 GIT_EXEC_PATH、GIT_TEMPLATE_DIR', env: { GIT_EXEC_PATH: 'C:\\nowhere', GIT_TEMPLATE_DIR: 'C:\\nowhere' }, want: '会改 git 行为的环境变量：GIT_EXEC_PATH、GIT_TEMPLATE_DIR' },
    { name: '窗口里预先设了 SUPABASE_API_URL', env: { SUPABASE_API_URL: 'https://evil.example.test' }, want: '不该有的环境变量：SUPABASE_API_URL' },
  ];
  for (const c of stopCases) {
    it(`${c.name}：第 1 步就停`, async () => {
      const p = c.path?.();
      if (p) {
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, p.endsWith('.toml') ? 'name = "x"\npages_build_output_dir = "dist/web"\n' : 'X=1\n', 'utf8');
      }
      try {
        const r = await runScript('-DryRun -Ops', [], '', false, c.env ?? {});
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(c.want);
        expect(r.calls).toEqual([]);
        expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
      } finally {
        if (p) rmSync(p, { force: true });
        if (p?.includes(join('.wrangler', 'deploy'))) rmSync(join(repo, '.wrangler'), { recursive: true, force: true });
        if (p?.includes(join('functions', 'tmp'))) rmSync(join(p, '..'), { recursive: true, force: true });
      }
    }, 180_000);
  }

  it('仓库里有 .env.local（wrangler 会自动读）：第 1 步就停', async () => {
    const f = join(repo, '.env.local');
    writeFileSync(f, 'CLOUDFLARE_API_BASE_URL=https://evil.example.test/client/v4\n', 'utf8');
    try {
      const r = await runScript('-DryRun -Ops', []);
      expect(r.code).toBe(1);
      expect(r.out).toContain('会自动读的环境文件：.env.local');
      expect(r.calls).toEqual([]);
      expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  }, 180_000);

  // M3、M4：.git 里事先放好的东西。三个用例都在 .git\config 里挂一个会留记号的 core.fsmonitor 程序，
  // 先确认它在普通的 git status 里确实会被执行，再断言跑发布脚本时它一次都没被执行（脚本第一次调 git 之前就把 fsmonitor 关了）
  const gitStateCases: { name: string; setup: () => void; undo: () => void; want: string }[] = [
    {
      name: 'assume-unchanged 标记',
      setup: () => git(['update-index', '--assume-unchanged', 'VERSION']),
      undo: () => git(['update-index', '--no-assume-unchanged', 'VERSION']),
      want: '被标成 assume-unchanged 或 skip-worktree',
    },
    { name: '.git\\config 里有 core.fsmonitor', setup: () => undefined, undo: () => undefined, want: '不许有的设置：core.fsmonitor' },
    {
      name: '.git\\info\\attributes 不为空',
      setup: () => writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.ts filter=x\n', 'utf8'),
      undo: () => rmSync(join(repo, '.git', 'info', 'attributes'), { force: true }),
      want: '.git\\info\\attributes 不是空的',
    },
  ];
  for (const c of gitStateCases) {
    it(`${c.name}：第 1 步就停，fsmonitor 程序没被执行`, async () => {
      const marker = join(dir, 'fsmonitor-ran.txt');
      const hook = join(dir, 'fsmonitor.sh');
      writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, '/')}'\n`, 'utf8');
      git(['config', '--local', 'core.fsmonitor', hook.replace(/\\/g, '/')]);
      try {
        // 探针有效：普通的 git status 会执行它
        spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
        expect(existsSync(marker), 'fsmonitor 探针没生效，这个用例测不出东西').toBe(true);
        c.setup();
        // setup 里的 git 命令也可能触发它，跑脚本之前再清一次记号
        rmSync(marker, { force: true });
        const r = await runScript('-DryRun -Ops', []);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(c.want);
        expect(existsSync(marker), '发布脚本运行时 fsmonitor 程序被执行了').toBe(false);
        expect(r.calls).toEqual([]);
        expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
      } finally {
        c.undo();
        git(['config', '--local', '--unset', 'core.fsmonitor']);
        rmSync(marker, { force: true });
      }
    }, 180_000);
  }

  // M5：git status 写回刷新后的索引会触发 post-index-change 钩子；脚本用 GIT_CONFIG_* 把 core.hooksPath 指到空目录，钩子一次都不执行
  it('.git\\hooks\\post-index-change 钩子：演练全程一次都没执行', async () => {
    const marker = join(dir, 'hook-ran.txt');
    const hook = join(repo, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, '/')}'\n`, 'utf8');
    const stale = () => { const t = new Date(Date.now() + 5_000); utimesSync(join(repo, 'VERSION'), t, t); };
    try {
      // 探针有效：让索引过期，普通的 git status 写回索引时会执行它
      stale();
      spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
      expect(existsSync(marker), 'post-index-change 探针没生效，这个用例测不出东西').toBe(true);
      rmSync(marker, { force: true });
      stale();
      const r = await runScript('-DryRun -Ops', ['一致']);
      expect(r.code, r.out).toBe(0);
      expect(existsSync(marker), '发布脚本运行时 post-index-change 钩子被执行了').toBe(false);
      expect(r.out).toContain('演练（-DryRun）到此结束');
      // 空的钩子目录用完就删，GIT_CONFIG_* 也清掉
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('lemo-nohooks-'))).toEqual([]);
      expect(r.envLeft).toBe('');
    } finally {
      rmSync(hook, { force: true });
      rmSync(marker, { force: true });
    }
  }, 180_000);

  // core.hookspath 只放行指向本仓库被跟踪的 .githooks（项目的密钥检查钩子），其他都在第 1 步停
  const hooksCases: { name: string; value: () => string; extra?: () => string; ok: boolean; want: string }[] = [
    { name: '指向仓库外的目录', value: () => join(dir, 'hooks-outside'), ok: false, want: '不许有的设置：core.hookspath' },
    { name: '指向 .githooks，但里面有被忽略的文件', value: () => join(repo, '.githooks'), extra: () => join(repo, '.githooks', 'x.tmp'), ok: false, want: '.githooks 下有没被 git 跟踪的文件（含被忽略的）：.githooks/x.tmp' },
    { name: '指向 <RepoPath>\\.githooks（项目规定的写法）', value: () => join(repo, '.githooks'), ok: true, want: 'core.hookspath 指向本仓库被跟踪的 .githooks' },
    { name: '相对路径 .githooks', value: () => '.githooks', ok: true, want: 'core.hookspath 指向本仓库被跟踪的 .githooks' },
  ];
  for (const c of hooksCases) {
    it(`core.hookspath ${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      mkdirSync(join(dir, 'hooks-outside'), { recursive: true });
      git(['config', '--local', 'core.hookspath', c.value()]);
      const extra = c.extra?.();
      if (extra) writeFileSync(extra, 'x\n', 'utf8');
      try {
        // 被忽略的文件不进 git status：确认工作区仍算干净，拦下它的是 .githooks 的检查
        if (extra) expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
        const r = await runScript('-CheckOnly -Ops', []);
        expect(r.code, r.out).toBe(c.ok ? 0 : 1);
        expect(r.out).toContain(c.want);
        expect(r.calls).toEqual([]);
      } finally {
        if (extra) rmSync(extra, { force: true });
        git(['config', '--local', '--unset', 'core.hookspath']);
      }
    }, 180_000);
  }

  it('-Ops 时 KV id 还是占位值：第 1 步就停', async () => {
    const tomlPath = join(repo, 'workers', 'lemo-ops', 'wrangler.toml');
    writeFileSync(tomlPath, readFileSync(tomlPath, 'utf8').replace(KV_ID, 'REPLACE_WITH_KV_NAMESPACE_ID'), 'utf8');
    git(['commit', '-q', '-am', 'publish-run 测试：KV id 改回占位值']);
    tagHere();
    const r = await runScript('-CheckOnly -Ops', []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('KV 的 id 还是占位值');
  }, 180_000);

  it('tag 里没有 lemo-ops 时，-Only functions 不加 -Ops 也能跑（不要求同一次部署）', async () => {
    git(['rm', '-q', '-r', 'workers/lemo-ops']);
    git(['commit', '-q', '-m', 'publish-run 测试：去掉 lemo-ops']);
    tagHere();
    expect(existsSync(join(repo, 'workers', 'lemo-ops', 'wrangler.toml'))).toBe(false);
    const r = await runScript('-CheckOnly -Only functions', []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('这次不部署 lemo-ops');
    expect(r.out).toContain('这次要部署：服务器函数（');
  }, 180_000);

  it('tag 里没有 lemo-ops 时，-Only functions 不加 -Ops 的正式路径：只要 Supabase 令牌，不问 Cloudflare 令牌、不装不调 wrangler', async () => {
    writeBackupManifest();
    const r = await runScript('-Only functions', [REF, SB_TOKEN, 'lemomemo']);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    expect(r.prompts.some((p) => p.includes('Cloudflare'))).toBe(false);
    expect(r.calls.map((c) => c.split('\t')[0])).toEqual(['supabase']);
    expect(r.calls[0]).toContain(`functions deploy ${functionNames().join(' ')} --project-ref`);
    expect(r.log.some((l) => l.startsWith('cf\t') || l.startsWith('npm\t'))).toBe(false);
    expect(r.envLeft).toBe('');
    noSecrets(r);
  }, 180_000);
});
