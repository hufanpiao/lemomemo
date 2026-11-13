<#
.SYNOPSIS
  隐私记钥匙的泄漏检查（TC-B5-15；架构 8.4；B5 任务单 S19、第四节第 2 步）：在 AI 会话记录、发布稿子的本地存档、git 历史、
  PowerShell 历史、CI 日志里找 VAULT_KEY、VAULT_PIN_PEPPER，只输出「没找到 / 找到 N 处」。由产品负责人本人运行，AI 不经手值。

.DESCRIPTION
  1. 开头检查（和其他密钥脚本同一段、逐字相同）：剪贴板历史关着、没有 transcript 和日志策略；关掉本窗口的历史记录；
  2. 从 Google 密码管理器复制两把钥匙，依次粘贴（Read-Host -AsSecureString，屏幕不显示，读完清剪贴板；不从命令行参数、文件接收）；
  3. 每把钥匙同时找三种写法：原样（标准 base64）、base64url（+/ 换成 -_、去掉 =）、十六进制（小写）——值被转码后贴到别处也认得出；
     还找原样去掉末尾 = 的写法；
  4. 搜这几处（读进内存逐个比，不起带值的子进程、不把值放进任何命令行）：
       ① %USERPROFILE%\.claude（含 projects 会话记录、工具输出缓存）；
       ② 发布稿子的本地存档（柠檬记仓库 docs\02-设计\线上存档）和本机资料夹（柠檬记APP-本机资料）；
       ③ 柠檬记仓库的 git 历史（git log -p --all 的输出逐行读进内存比，值不进 git 的参数）；
       ④ PowerShell 历史（PSReadLine 的 ConsoleHost_history.txt，Windows PowerShell 和 pwsh 两处）；
       ⑤ CI 日志：本机装了 gh 且已登录时，取最近 -CiRuns 次运行的日志（gh run view --log 的输出读进内存比）；没装或没登录就写「跳过」；
  5. 每一处只打印「没找到」或「找到 N 处」（N 是命中的文件数或日志次数），**不打印命中的文件名、行号、上下文**——
     文件名本身可能带出线索；找到了就在聊天里说「泄漏检查找到 N 处」，由主持人和负责人商量怎么处理（多半要换钥匙）。
  6. 结束时清掉内存里的值、清剪贴板、清 $Error。
  单个文件超过 -MaxFileMB（默认 64 MB）跳过并计数；读不了的文件计数，最后一起报。

.PARAMETER RepoRoot
  柠檬记仓库目录，默认是本脚本上两级。

.PARAMETER CiRuns
  查最近几次 CI 运行的日志，默认 30；0 表示不查。

.PARAMETER MaxFileMB
  单个文件大小上限（MB），默认 64。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\check-vault-keys-leak.ps1"
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [ValidateRange(0, 200)][int]$CiRuns = 30,
    [ValidateRange(1, 1024)][int]$MaxFileMB = 64
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8   # 先设好，下面的报错才不是乱码

# 只许用 -File 运行：点源（. 脚本）或把内容粘贴进窗口跑，脚本里的变量（值、令牌）会留在窗口的会话里（照搬 set-cron-secret.ps1）
if ($MyInvocation.InvocationName -eq '.' -or -not $PSCommandPath) {
    throw '已停止：请用 powershell -NoProfile -ExecutionPolicy Bypass -File <脚本路径> 运行，不要点源、不要粘贴进窗口运行'
}
$byFile = $false
$cmdArgs = [Environment]::GetCommandLineArgs()
for ($i = 0; $i -lt $cmdArgs.Count - 1; $i++) {
    if ($cmdArgs[$i] -match '\A[-/]f(i(le?)?)?\z') {
        try { if ([IO.Path]::GetFullPath($cmdArgs[$i + 1]) -eq [IO.Path]::GetFullPath($PSCommandPath)) { $byFile = $true } } catch { }
    }
}
if (-not $byFile -and $env:LEMO_TEST_API -ne '1') {
    throw '已停止：请用 powershell -NoProfile -ExecutionPolicy Bypass -File <脚本路径> 运行（不要在已打开的窗口里用 & 调用）'
}

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { }
}

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ✘ $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { throw "已停止：$msg" }

# 粘贴后、结束时清剪贴板（剪贴板里只会有负责人粘贴的东西，脚本不往剪贴板里放任何东西）
function Clear-Clip {
    try { Set-Clipboard -Value ' ' } catch { }
    try { Add-Type -AssemblyName System.Windows.Forms } catch { }
    try { [System.Windows.Forms.Clipboard]::Clear() } catch { }
    try {
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory()
    } catch { }
}

# ==== 安全窗口检查：开始（tools/keys/new-proxy-secret.ps1、set-r2-tokens.ps1、set-fn-role-passwords.ps1、login-token-tests.ps1、set-cron-secret.ps1、set-signup-secrets.ps1、set-vapid-keys.ps1、gen-tauri-key.ps1、tools/release/publish.ps1 九处逐字相同，tests/build/keys-guard-sync.test.ts 核对；改一处九处一起改）====
# B0 安全审查低 5：Claude 不只叫 claude*。npm 装的 Claude Code、IDE 扩展里的都可能是 node.exe，所以再按命令行查一遍 node 进程。
# 只看命令行里有没有 claude-code / @anthropic-ai，不打印命令行内容（只报进程号）。查不了命令行（例如管理员权限启动的 node）就按“可能在运行”处理。
function Test-PolicyOn([string]$key, [string]$name) {
    foreach ($root in 'HKLM:', 'HKCU:') {
        $v = Get-ItemProperty -Path "$root\$key" -Name $name -ErrorAction SilentlyContinue
        if ($v -and $v.$name -eq 1) { return $true }
    }
    return $false
}

function Assert-NoClaude {
    $named = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'claude*' })
    if ($named.Count -gt 0) {
        Fail "检测到 Claude 还在运行（$(@($named.ProcessName | Sort-Object -Unique) -join ', ')）。Claude 能读终端里的内容，请完全退出 Claude 桌面 App、终端里的 claude 和编辑器里的 Claude 扩展，再重新运行"
    }
    try {
        $nodes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    } catch {
        Fail '查不了 node 进程的命令行（Get-CimInstance 失败），没法确认 Claude 已退出。请在聊天里告诉运维'
    }
    $hit = @()
    $unknown = @()
    foreach ($p in $nodes) {
        $cl = [string]$p.CommandLine
        if ([string]::IsNullOrEmpty($cl)) { $unknown += $p.ProcessId }
        elseif ($cl -match '(?i)claude-code|@anthropic-ai') { $hit += $p.ProcessId }
    }
    if ($hit.Count -gt 0) {
        Fail "检测到以 node 运行的 Claude（进程号 $($hit -join ', ')）。请完全退出终端和编辑器里的 Claude，再重新运行"
    }
    if ($unknown.Count -gt 0) {
        Fail "有 node 进程查不到命令行（进程号 $($unknown -join ', ')，可能是管理员权限启动的），没法确认不是 Claude。请关掉这些程序，再重新运行"
    }
    Ok '没有 Claude 在运行（含以 node 运行的）'
}

function Assert-NoRecording {
    $hist = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Clipboard' -Name 'EnableClipboardHistory' -ErrorAction SilentlyContinue
    if ($hist -and $hist.EnableClipboardHistory -eq 1) {
        Fail 'Windows 剪贴板历史（Win+V）开着，复制、粘贴的值会留在历史里。请到 设置 › 系统 › 剪贴板 关掉“剪贴板历史记录”和“跨设备共享”，再重新运行'
    }
    Ok 'Windows 剪贴板历史是关的'
    if (Test-PolicyOn 'SOFTWARE\Policies\Microsoft\Windows\PowerShell\Transcription' 'EnableTranscripting') { Fail '系统策略开着 PowerShell transcript（屏幕内容会被自动存成文件）。这台电脑不适合处理密钥，请在聊天里告诉运维' }
    if (Test-PolicyOn 'SOFTWARE\Policies\Microsoft\Windows\PowerShell\ModuleLogging' 'EnableModuleLogging') { Fail '系统策略开着 PowerShell 模块日志。这台电脑不适合处理密钥，请在聊天里告诉运维' }
    if (Test-PolicyOn 'SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging' 'EnableScriptBlockLogging') { Fail '系统策略开着 PowerShell 脚本块日志。这台电脑不适合处理密钥，请在聊天里告诉运维' }
    # 本窗口如果有人手动 Start-Transcript：停掉它（此时还没读、没生成任何值），并要求换一个干净的窗口
    $wasRecording = $false
    try { Stop-Transcript -ErrorAction Stop | Out-Null; $wasRecording = $true } catch { }
    if ($wasRecording) { Fail '这个窗口在记录 transcript（已停掉，还没读、没生成任何值）。请关掉这个窗口，新开一个 PowerShell 再运行' }
    Ok '没有在记录 transcript、没有日志策略'
}
# ==== 安全窗口检查：结束 ====

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Read-Key([string]$name) {
    Say ''
    Say "请从 Google 密码管理器复制 $name，粘贴到这里（屏幕不显示，粘贴后按回车）。"
    for ($try = 1; $try -le 3; $try++) {
        $sec = Read-Host -AsSecureString '  粘贴到这里'
        Clear-Clip
        $v = (To-Plain $sec) -replace '[\s ​-‍⁠﻿]', ''
        $sec.Dispose()
        if ($v -cmatch '\A[A-Za-z0-9+/]{43}=\z') { Ok "$name 已收到（剪贴板已清空）"; return $v }
        Warn "格式不对（应是 44 个字符、以 = 结尾）：收到 $($v.Length) 个字符"
        $v = $null
    }
    Fail "$name 连续 3 次格式不对，已停止"
}

# 一把钥匙的几种写法：原样、去掉 =、base64url、十六进制
function Variants([string]$b64) {
    $bytes = [Convert]::FromBase64String($b64)
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [Array]::Clear($bytes, 0, $bytes.Length)
    $url = $b64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
    return @($b64, $b64.TrimEnd('='), $url, $hex, $hex.ToUpperInvariant()) | Select-Object -Unique
}

function Has-Any([string]$text) {
    foreach ($n in $script:needles) { if ($text.IndexOf($n, [StringComparison]::Ordinal) -ge 0) { return $true } }
    return $false
}

# 搜一个目录：返回命中的文件数（文件按 UTF-8 读；二进制文件里的 ASCII 片段照样认得出）
function Search-Dir([string]$label, [string]$dir) {
    if (-not (Test-Path -LiteralPath $dir)) { Say "  $label：目录不存在，跳过"; return }
    $hit = 0; $big = 0; $bad = 0; $n = 0
    $limit = [int64]$MaxFileMB * 1MB
    foreach ($f in Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue) {
        if ($f.FullName -like '*\node_modules\*' -or $f.FullName -like '*\.git\objects\*') { continue }
        if ($f.Length -gt $limit) { $big++; continue }
        $n++
        try {
            $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
            if (Has-Any $text) { $hit++ }
        } catch { $bad++ }
        $text = $null
    }
    Report $label $hit "看了 $n 个文件" $big $bad
}

function Report([string]$label, [int]$hit, [string]$what, [int]$big, [int]$bad) {
    $extra = @()
    if ($big) { $extra += "$big 个超过 $MaxFileMB MB 没看" }
    if ($bad) { $extra += "$bad 个读不了" }
    $tail = if ($extra.Count) { "（$($extra -join '，')）" } else { '' }
    if ($hit -eq 0) { Ok "$label：没找到（$what）$tail" }
    else { $script:total += $hit; Warn "$label：找到 $hit 处（$what）$tail" }
}

# 子进程的输出逐行读进内存比（值不进子进程的参数）；返回命中行数
function Search-Output([string]$exe, [string[]]$argv, [string]$cwd) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = ($argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $psi.WorkingDirectory = $cwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $p = [Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()
    $hit = 0
    while ($null -ne ($line = $p.StandardOutput.ReadLine())) { if (Has-Any $line) { $hit++ } }
    $p.WaitForExit()
    $null = $errTask.Result
    return @{ hit = $hit; code = $p.ExitCode }
}

# ───────────────────────── 主流程 ─────────────────────────
$k1 = $null; $k2 = $null; $script:needles = @(); $script:total = 0
try {
    Step '隐私记钥匙泄漏检查：先检查窗口'
    Assert-NoRecording

    Step '粘贴两把钥匙（从 Google 密码管理器复制）'
    $k1 = Read-Key 'VAULT_KEY'
    $k2 = Read-Key 'VAULT_PIN_PEPPER'
    $script:needles = @((Variants $k1) + (Variants $k2))
    $k1 = $null; $k2 = $null

    Step '开始搜（只报“没找到 / 找到 N 处”，不显示命中在哪）'
    Search-Dir '① Claude 会话记录和工具输出缓存（%USERPROFILE%\.claude）' (Join-Path $env:USERPROFILE '.claude')
    Search-Dir '② 发布稿子的本地存档（docs\02-设计\线上存档）' (Join-Path $RepoRoot 'docs\02-设计\线上存档')
    Search-Dir '② 本机资料夹（柠檬记APP-本机资料）' (Join-Path (Split-Path -Parent $RepoRoot) '柠檬记APP-本机资料')
    Search-Dir '② 仓库工作区（不含 .git 和 node_modules）' $RepoRoot

    if (Get-Command git -ErrorAction SilentlyContinue) {
        $r = Search-Output 'git' @('log', '-p', '--all', '--text', '--no-color', '--no-ext-diff') $RepoRoot
        if ($r.code -ne 0) { Warn "③ git 历史：git log 出错（退出码 $($r.code)），没查完" } else { Report '③ git 历史（全部分支）' $r.hit 'git log -p --all' 0 0 }
    } else { Warn '③ git 历史：没装 git，跳过' }

    foreach ($h in @(
            (Join-Path $env:APPDATA 'Microsoft\Windows\PowerShell\PSReadLine'),
            (Join-Path $env:APPDATA 'Microsoft\PowerShell\PSReadLine'))) {
        Search-Dir "④ PowerShell 历史（$(Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $h)))）" $h
    }

    if ($CiRuns -eq 0) { Say '  ⑤ CI 日志：按 -CiRuns 0 跳过' }
    elseif (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Warn '⑤ CI 日志：没装 gh，跳过（要查的话装好 gh 并 gh auth login 后重跑）' }
    else {
        $list = Search-Output 'gh' @('auth', 'status') $RepoRoot
        if ($list.code -ne 0) { Warn '⑤ CI 日志：gh 没登录，跳过' }
        else {
            $ids = @(& gh run list --limit $CiRuns --json databaseId --jq '.[].databaseId' 2>$null)
            $hit = 0; $fail = 0
            foreach ($id in $ids) {
                if ($id -notmatch '\A\d+\z') { continue }
                $r = Search-Output 'gh' @('run', 'view', $id, '--log') $RepoRoot
                if ($r.code -ne 0) { $fail++ } elseif ($r.hit -gt 0) { $hit++ }
            }
            Report "⑤ CI 日志（最近 $($ids.Count) 次运行）" $hit '按次数计' 0 $fail
        }
    }

    Say ''
    if ($script:total -eq 0) {
        Write-Host '结果：全部没找到。在聊天里说「泄漏检查没找到」，并把这个窗口截图存到 柠檬记APP-本机资料（不进仓库）。' -ForegroundColor Green
    } else {
        Write-Host "结果：一共找到 $($script:total) 处。在聊天里说「泄漏检查找到 $($script:total) 处」（不要贴任何值），等主持人一起看怎么处理。" -ForegroundColor Yellow
    }
}
catch {
    throw "已停止：$([string]$_.Exception.Message)"
}
finally {
    $k1 = $null; $k2 = $null; $script:needles = @()
    Clear-Clip
    [GC]::Collect()
    $Error.Clear()
    Write-Host '已清剪贴板、清掉内存里的值。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
