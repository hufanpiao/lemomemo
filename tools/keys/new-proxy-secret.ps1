<#
.SYNOPSIS
  生成一把 PROXY_SECRET（架构 0.31 第 11 条、8.4）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，不经过 Claude。

.DESCRIPTION
  PROXY_SECRET 是 /sb 转发层（Cloudflare Pages Functions）和服务器函数（Supabase Edge Functions）之间的共享密钥：
  转发层每个请求带上 x-proxy-secret，函数一侧对上了才相信 x-client-ip、x-lemo-geo。预览、正式各一把，值不同。

  做的事（按顺序，任何一步不过就停）：
    1. 检查：Claude 已完全退出（Claude 能读终端里的内容；进程名 claude*，以及命令行带 claude-code / @anthropic-ai 的 node.exe）、
       Windows 剪贴板历史是关的、本窗口没有在记录 transcript、系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略
       （和 set-r2-tokens.ps1、publish.ps1 同一段检查，逐字相同）；
    2. 在本机内存里生成 32 字节随机值（.NET RandomNumberGenerator），写成 64 位小写十六进制；
    3. 在屏幕上显示一次，同时显示它的 SHA-256（不是密钥，用来核对 Supabase 页面上的 Digest）；
       你照负责人B0网页操作清单第 ⑧ 节：粘贴进 Cloudflare Pages（加密变量）→ 粘贴进 Supabase（函数 secret）；
       不用另存（R-220），丢了重新运行本脚本；
    4. 你按回车以后：清屏（含滚动记录）、清剪贴板、清掉内存里的值。

  不写任何文件、不进命令行参数、不交给任何 cmdlet（只用 .NET 的 [Console]::WriteLine 显示，模块日志记不到），
  所以不会留在 PowerShell 历史、transcript 或事件日志里。脚本本身不联网、不登录任何账号。
  中途出错或关了窗口：重新运行一次，生成一把新的，两个地方都换成新值（旧值作废即可，它不加密任何数据）。

.PARAMETER Target
  preview（预览：Pages 项目 lemomemo-preview、Supabase 项目 lemomemo-preview）
  或 production（正式：Pages 项目 lemomemo、Supabase 项目 lemomemo-prod）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\new-proxy-secret.ps1" -Target preview
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'production')][string]$Target
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 本窗口之后输入的命令不存盘（值本来就不是输入的，这一步是多一道保险）
if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { }
}

function Say([string]$msg) { Write-Host $msg }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Fail([string]$msg) { throw "已停止：$msg" }

function Clear-Clip {
    try { Set-Clipboard -Value ' ' } catch { }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Clipboard]::Clear()
    } catch { }
    try {
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory()
    } catch { }
}

# ==== 安全窗口检查：开始（tools/keys/new-proxy-secret.ps1、set-r2-tokens.ps1、set-fn-role-passwords.ps1、login-token-tests.ps1、set-cron-secret.ps1、set-signup-secrets.ps1、tools/release/publish.ps1 七处逐字相同，tests/build/keys-guard-sync.test.ts 核对；改一处七处一起改）====
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

function Assert-SafeWindow {
    # 10-29 负责人定（R-223）：不再检查 Claude 是否在运行
    Assert-NoRecording
}

if ($Target -eq 'preview') {
    $label = '预览'; $pages = 'lemomemo-preview'; $supa = 'lemomemo-preview'
} else {
    $label = '正式'; $pages = 'lemomemo'; $supa = 'lemomemo-prod'
}
$entry = "柠檬记 PROXY_SECRET $label"

$bytes = $null
$value = $null
$shown = $false
try {
    Say ''
    Say "== 生成 $label 环境的 PROXY_SECRET：先检查 =="
    Assert-SafeWindow

    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $value = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    [Array]::Clear($bytes, 0, $bytes.Length)
    if ($value.Length -ne 64) { Fail '生成的值长度不对' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }

    Say ''
    Say "== $label 环境的 PROXY_SECRET（只显示这一次，按回车后清屏） =="
    Say ''
    Say '  值（64 位，只有 0～9 和 a～f）：'
    Say ''
    $shown = $true
    [Console]::WriteLine("      $value")
    Say ''
    Say "  SHA-256（不是密钥，用来核对 Supabase 页面上的 Digest）：$digest"
    Say ''
    Say '  照负责人B0网页操作清单第 ⑧ 节做，两处要一模一样（不用另存，丢了重新运行本脚本，R-220）：'
    Say "    1. Cloudflare › Workers & Pages › $pages › 设置 › 变量和机密 › Production：PROXY_SECRET，类型选「密钥 / Secret」（加密），粘贴；"
    Say "    2. Supabase › $supa › Edge Functions › Secrets：Name 填 PROXY_SECRET，Value 粘贴，保存。"
    Say '  复制方法：用鼠标选中上面那一行的值（不要带前后的空格），按回车或右键复制。'
    Say '  不要截图、不要发给 Claude 或任何人。'
    Say ''
    $null = Read-Host '  两处都做好了按回车（会清屏、清剪贴板）'
}
finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    $value = $null
    Remove-Variable -Name value -ErrorAction SilentlyContinue
    if ($shown) {
        Clear-Clip
        Clear-Host
        # 连滚动记录一起清（Windows Terminal、新版控制台认这个转义序列）
        [Console]::Write("$([char]27)[3J")
        [GC]::Collect()
        Write-Host "已清屏、清剪贴板。$label 环境的 PROXY_SECRET 只在你刚才放的三个地方。" -ForegroundColor Green
        Write-Host '最后关掉这个 PowerShell 窗口，在聊天里说“PROXY_SECRET（' -NoNewline
        Write-Host $label -NoNewline
        Write-Host '）做好了”。'
    }
}
