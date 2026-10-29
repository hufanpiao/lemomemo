// publish-run-harness.ts 用的假工具模板（从 harness 拆出来，免得超过 300 行；行为不变）：
// - FAKE_TOOL_CS：编成假 supabase.exe、wrangler.exe 的 C# 源码。只把参数和“哪些令牌环境变量有值”（只记名字）写进 LEMO_FAKE_LOG；
//   wrangler secret list 打印 LEMO_FAKE_SECRETS；参数里含 LEMO_FAKE_TAMPER_AT 时改一处文件，LEMO_FAKE_TAMPER 是 git:<参数> 时跑一次真 git；
//   参数里含 LEMO_FAKE_FAIL 时返回 1。
// - fakeFunctions：演练窗口里先定义好的 PowerShell 函数——git（只替换 git var 两种情形）、Invoke-WebRequest、Invoke-RestMethod、
//   npm.cmd、node、Read-Host（从队列取假值，多问一次就失败）等，覆盖掉同名命令，publish.ps1 调到的就是它们。
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
      string target = what == "web" ? Path.Combine(Path.Combine(w, "web"), "index.html")
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
  const { fakeTgz, fakeExe, fakeJs, ver, inputs } = p;
  return `$T = [string][char]9
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
$global:lastSec = $null`;
}
