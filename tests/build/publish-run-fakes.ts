// publish-run-harness.ts 用的假工具模板（从 harness 拆出来，免得超过 300 行；行为不变）：
// - FAKE_TOOL_CS：编成假 supabase.exe、wrangler.exe 的 C# 源码。只把参数和“哪些令牌环境变量有值”（只记名字）写进 LEMO_FAKE_LOG；
//   wrangler secret list 打印 LEMO_FAKE_SECRETS；参数里含 LEMO_FAKE_TAMPER_AT 时改一处文件，LEMO_FAKE_TAMPER 是 git:<参数> 时跑一次真 git；
//   参数里含 LEMO_FAKE_FAIL 时返回 1。
// - fakeFunctions：演练窗口里先定义好的 PowerShell 函数——git（只替换 git var 两种情形）、Invoke-WebRequest、Invoke-RestMethod、
//   npm.cmd、node、Read-Host（从队列取假值，多问一次就失败）等，覆盖掉同名命令，publish.ps1 调到的就是它们。
//   node 跑 build\ci\check_deno_drift.mjs 时不连 npm，按 LEMO_FAKE_DRIFT（第几次返回 1）给退出码，默认都是 0。
//   B7a 起 publish.ps1 不在本机构建、不跑 copy_shared（发布包由 publish-run-pack.ts 现做），所以没有 npm run build、copy_shared 的假行为了。
//   GitHub 的产物接口和两段式下载、Supabase 的 SQL 接口（backup-daily）按 LEMO_FAKE_GH、LEMO_FAKE_BACKUP 答；Start-Sleep 只记日志不真等。
// 不是测试文件，不起子进程。

/** 令牌相关的环境变量名（演练不传给子进程，假工具只记有没有值） */
export const TOKEN_ENV = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const;

/** 写进 PowerShell 单引号字符串 */
export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const FAKE_TOOL_CS = `using System;
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
      string target = what == "web" ? Path.Combine(Path.Combine(Path.Combine(Path.Combine(w, "pub"), "dist"), "web"), "index.html")
        : what == "tree" ? Path.Combine(Path.Combine(Path.Combine(Path.Combine(Path.Combine(w, "deploy"), "node_modules"), "wrangler"), "bin"), "wrangler.js")
        : what;
      if (what.StartsWith("git:")) { System.Diagnostics.Process p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("git", what.Substring(4)) { UseShellExecute = false }); p.WaitForExit(); } else { File.AppendAllText(target, "tampered"); }
    }
    string fail = Environment.GetEnvironmentVariable("LEMO_FAKE_FAIL");
    if (!string.IsNullOrEmpty(fail) && args.Contains(fail)) { Console.Error.WriteLine("fake " + name + " failed"); return 1; }
    if (a.Length >= 2 && a[0] == "secret" && a[1] == "list") { Console.WriteLine(Environment.GetEnvironmentVariable("LEMO_FAKE_SECRETS")); return 0; }
    Console.WriteLine("fake " + name + " ok");
    return 0;
  }
}`;

/** 演练窗口里覆盖同名命令的 PowerShell 函数；inputs 是 Read-Host 依次返回的假值 */
export function fakeFunctions(p: { fakeTgz: string; fakeExe: string; fakeJs: string; ver: string; inputs: string[] }): string {
  const { fakeTgz, fakeExe, fakeJs, inputs } = p;
  return `$global:T = [string][char]9
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
function global:PEnv([string]$where) { L ('penv' + $global:T + $where + $global:T + ((@(${TOKEN_ENV.map(q).join(', ')}) | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }) -join ',')) }
function global:Get-ItemProperty { $null }
function global:Set-Clipboard { }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
function global:Start-Sleep { param([int]$Seconds) L ('sleep' + $global:T + $Seconds) }
# 正式发布第 6a 步调的 tools\\backup\\pull.ps1：只记参数和当时进程里有哪些令牌环境变量（只记名字），退出码按 LEMO_FAKE_PULL
function global:powershell.exe { L ('pull' + $global:T + (@($args) -join ' ') + $global:T + ((@(${TOKEN_ENV.map(q).join(', ')}) | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }) -join ',')); $global:LASTEXITCODE = [int]$env:LEMO_FAKE_PULL }
# 下载：GitHub 产物 zip 是两段式（api.github.com 回 302 和一个签名地址，再不带令牌去下载）；其余是 Supabase CLI 安装包
function global:Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, $Headers, $MaximumRedirection)
  PEnv ('web ' + $Uri)
  if ($Uri -like 'https://api.github.com/repos/*/actions/artifacts/*/zip') {
    L ('ghzip' + $global:T + $Uri + $global:T + ([string]$Headers.Authorization).StartsWith('Bearer github_pat_') + $global:T + $MaximumRedirection + $global:T + [string]$OutFile)
    if ($env:LEMO_FAKE_GH -eq 'zip') { throw 'test: 401 Unauthorized' }
    return [pscustomobject]@{ StatusCode = 302; Headers = @{ Location = 'https://blob.example.test/pub.zip?sig=TESTONLY' } } }
  if ($Uri -like 'https://blob.example.test/*') {
    L ('blob' + $global:T + $Uri + $global:T + ($null -eq $Headers))
    Copy-Item -LiteralPath $env:LEMO_FAKE_ZIP -Destination $OutFile; return }
  L ('download' + $global:T + $Uri); Copy-Item -LiteralPath ${q(fakeTgz)} -Destination $OutFile }
$global:ghName = ''
function global:Invoke-RestMethod { [CmdletBinding()] param([string]$Uri, $Headers, $MaximumRedirection, [string]$Method = 'Get', [string]$Body = '', [string]$ContentType = '')
  PEnv ('rest ' + $Uri)
  # GitHub 产物接口：只有一个产物（名字照请求的），所在运行默认是本仓库对应工作流、对得上的 tag / 运行号；LEMO_FAKE_GH 模拟各种不对
  if ($Uri -like 'https://api.github.com/*') {
    L ('gh' + $global:T + $Uri + $global:T + ([string]$Headers.Authorization).StartsWith('Bearer github_pat_') + $global:T + $MaximumRedirection + $global:T + [string]$Headers.Accept)
    if ($env:LEMO_FAKE_GH -eq 'list') { throw 'test: 401 Unauthorized' }
    if ($Uri -match '/actions/artifacts\\?name=([^&]+)') {
      $global:ghName = $Matches[1]
      if ($env:LEMO_FAKE_GH -eq 'none') { return [pscustomobject]@{ total_count = 0; artifacts = @() } }
      $wr = [pscustomobject]@{ id = 555; head_sha = $env:LEMO_FAKE_HEAD_SHA; head_branch = 'x' }
      return [pscustomobject]@{ total_count = 1; artifacts = @([pscustomobject]@{ id = 101; name = $global:ghName; expired = $false; size_in_bytes = 12345; created_at = '2026-11-26T00:00:00Z'; workflow_run = $wr }) } }
    if ($Uri -like '*/actions/runs/555') {
      $prev = ($global:ghName -eq 'preview-bundle')
      $repo = 'hufanpiao/lemomemo'
      $headRepo = if ($env:LEMO_FAKE_GH -eq 'fork') { 'someone/lemomemo' } else { $repo }
      $wf = if ($prev) { '.github/workflows/deploy-preview.yml' } else { '.github/workflows/release-build.yml' }
      $br = if ($prev) { 'main' } else { $global:ghName.Substring(16) }
      return [pscustomobject]@{ id = 555; run_number = [int]$env:LEMO_FAKE_RUN_NO; path = $wf; event = 'push'; head_sha = $env:LEMO_FAKE_HEAD_SHA; head_branch = $br
        html_url = ('https://github.com/' + $repo + '/actions/runs/555'); repository = [pscustomobject]@{ full_name = $repo }; head_repository = [pscustomobject]@{ full_name = $headRepo } } }
    throw ('test: 没想到的 GitHub 请求 ' + $Uri) }
  # Supabase 的 SQL 接口（发布前触发 backup-daily）：按 LEMO_FAKE_BACKUP 答；只记 SQL 的开头，不记请求头
  if ($Uri -like 'https://api.supabase.com/v1/projects/*/database/query') {
    $sql = [string]($Body | ConvertFrom-Json).query
    L ('dbq' + $global:T + $Method + $global:T + ([string]$Headers.Authorization).StartsWith('Bearer sbp_') + $global:T + $MaximumRedirection + $global:T + $sql)
    $m = $env:LEMO_FAKE_BACKUP
    if ($m -eq 'deny') { throw 'test: 403 Forbidden' }
    if ($sql -like '*to_regprocedure(*backup_dispatch*') {
      $d = if ($m -eq 'none' -or $m -eq 'nojob') { 0 } else { 1 }; $u = if ($m -eq 'none') { 0 } else { 1 }
      return @([pscustomobject]@{ has_dispatch = $d; has_users = $u }) }
    if ($sql -like "*backup_dispatch('publish')*") { return @([pscustomobject]@{ n = 2 }) }
    if ($sql -like '*account_usable(p.user_id)*') { return @([pscustomobject]@{ n = 3 }) }   # 可用账号 3 个，backup_dispatch 只发了 2 个：等的是 2
    if ($sql -like '*to_char(now()*') { return @([pscustomobject]@{ t = '2026-11-26T01:02:03Z'; d = '2026-11-26' }) }
    if ($sql -like '*storage.objects*') { $n = if ($m -eq 'slow') { 1 } else { 2 }; return @([pscustomobject]@{ n = $n }) }
    throw ('test: 没想到的 SQL ' + $sql) }
  if ($Uri -like 'https://api.cloudflare.com/client/v4/accounts/*/workers/scripts') {
    L ('cf' + $global:T + $Uri + $global:T + ([string]$Headers.Authorization).StartsWith('Bearer ') + $global:T + $MaximumRedirection)
    if ($env:LEMO_FAKE_CF_DENY) { throw 'test: 403 Forbidden' }
    return [pscustomobject]@{ success = $true; result = @() } }
  # 正式项目的 Edge Function secrets 名单（B2 安全审查 D1-S3）：LEMO_FAKE_FN_SECRETS 逗号分隔；LEMO_FAKE_FN_SECRETS_DENY 时回 403。值一律是摘要，脚本只能取名字
  if ($Uri -like 'https://api.supabase.com/v1/projects/*/secrets') {
    L ('fnsecrets' + $global:T + $Uri + $global:T + ([string]$Headers.Authorization).StartsWith('Bearer sbp_') + $global:T + $MaximumRedirection)
    if ($env:LEMO_FAKE_FN_SECRETS_DENY) { throw 'test: 403 Forbidden {"value":"TESTONLYdigest"}' }
    return @(([string]$env:LEMO_FAKE_FN_SECRETS).Split(',') | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ name = $_; value = 'TESTONLYdigest' } }) }
  if ($Uri -like 'https://api.supabase.com/v1/projects/*') {
    L ('api' + $global:T + $Uri + $global:T + ([string]$Headers.Authorization).StartsWith('Bearer sbp_'))
    return [pscustomobject]@{ name = 'lemomemo'; region = 'ap-northeast-2'; status = 'ACTIVE_HEALTHY' } }
  if ($Uri -like '*/app/version.json') { L ('version' + $global:T + $Uri); return [pscustomobject]@{ version = $env:LEMO_FAKE_VERSION } }
  throw ('test: 没想到的请求 ' + $Uri) }
function global:npm.cmd {
  $a = @($args); L ('npm' + $global:T + ($a -join ' ') + $global:T + (Get-Location).Path)
  if ($a[0] -eq 'ci' -and (Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match 'lemo-deploy-tools')) {
    $nm = Join-Path (Get-Location).Path 'node_modules'
    $bin = Join-Path $nm 'wrangler\\bin'
    New-Item -ItemType Directory -Force -Path $bin, (Join-Path $nm '.bin') | Out-Null
    Copy-Item -LiteralPath ${q(fakeExe)} -Destination (Join-Path $bin 'wrangler.exe')
    Copy-Item -LiteralPath ${q(fakeJs)} -Destination (Join-Path $bin 'wrangler.js')
    Set-Content -LiteralPath (Join-Path $nm '.bin\\wrangler.cmd') -Value '@echo off' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $nm '.package-lock.json') -Value '{}' -Encoding Ascii
    if ($env:LEMO_FAKE_TREE_EXTRA) { Set-Content -LiteralPath (Join-Path $nm 'extra.js') -Value 'x' -Encoding Ascii } }
  $global:LASTEXITCODE = 0 }
# node 跑临时目录里的 wrangler\\bin\\wrangler.js 时转给同目录的假 wrangler.exe（真的子进程，日志里记它拿到了哪些令牌）；其余只记日志
$global:driftCalls = 0
function global:node {
  $a = @($args)
  if ($a.Count -gt 0 -and ([string]$a[0]).EndsWith('\\wrangler\\bin\\wrangler.js')) {
    $exe = Join-Path (Split-Path -Parent ([string]$a[0])) 'wrangler.exe'
    $rest = @(if ($a.Count -gt 1) { $a[1..($a.Count - 1)] })
    & $exe @rest
    $global:LASTEXITCODE = $LASTEXITCODE
    return }
  L ('node' + $global:T + ($a -join ' '))
  # 部署前查 npm 漂移（build\\ci\\check_deno_drift.mjs）：LEMO_FAKE_DRIFT 是 1 时第一次就返回 1，是 2 时第二次（输令牌前的复查）才返回 1。
  # 计数变量在上面先设成 0：publish.ps1 开了 Set-StrictMode，读没设过的变量会报错
  if ($a.Count -gt 0 -and ([string]$a[0]).EndsWith('check_deno_drift.mjs')) {
    $global:driftCalls = 1 + [int]$global:driftCalls
    $global:LASTEXITCODE = if ($env:LEMO_FAKE_DRIFT -eq [string]$global:driftCalls) { 1 } else { 0 }
    return }
  $global:LASTEXITCODE = 0 }
$global:inputs = New-Object System.Collections.Queue
${inputs.map((v) => `$global:inputs.Enqueue(${q(v)})`).join('\n')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  L ('prompt' + $global:T + $Prompt)
  PEnv ('prompt ' + $Prompt)
  if ($global:inputs.Count -eq 0) { throw ('test: Read-Host 多问了一次：' + $Prompt) }
  $v = $global:inputs.Dequeue()
  if ($AsSecureString) { $global:lastSec = ConvertTo-SecureString $v -AsPlainText -Force; return $global:lastSec }
  return $v }
$global:lastSec = $null`;
}
