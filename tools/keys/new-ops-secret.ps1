<#
.SYNOPSIS
  生成一把 OPS_SECRET（架构 8.4、第 6 节 usage-report）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，不经过 Claude。

.DESCRIPTION
  OPS_SECRET 是监控 Worker lemo-ops 和服务器函数 usage-report 之间的共享密钥：
  lemo-ops 每次来取用量都带上 x-ops-secret，usage-report 对上了才回数据（至少 32 字节，_shared/http.ts）。
  正式环境两处要放同一个值：Supabase 正式项目的函数 secret、lemo-ops 的 wrangler secret。
  预览环境没有 lemo-ops，只在要测 usage-report 时给预览项目设一把（值和正式的不同）。

  做的事（按顺序，任何一步不过就停）：
    1. 检查：Windows 剪贴板历史是关的、本窗口没有在记录 transcript、系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略
       （和 new-proxy-secret.ps1、publish.ps1 同一段检查，逐字相同；R-223 起不检查 Claude 是否在运行）；
    2. 在本机内存里生成 32 字节随机值（.NET RandomNumberGenerator），写成 64 位小写十六进制；
    3. 在屏幕上显示一次，同时显示它的 SHA-256（不是密钥，用来核对 Supabase 页面上的 Digest）；
       你粘贴进 Supabase（函数 secret），正式环境再粘贴进上线与回滚手册第三节“第一次部署前设六个密钥”那段命令问 OPS_SECRET 的地方；
       不用另存（R-220），丢了重新运行本脚本，两处一起换；
    4. 你按回车以后：清屏（含滚动记录）、清剪贴板、清掉内存里的值。

  不写任何文件、不进命令行参数、不交给任何 cmdlet（只用 .NET 的 [Console]::WriteLine 显示，模块日志记不到），
  所以不会留在 PowerShell 历史、transcript 或事件日志里。脚本本身不联网、不登录任何账号。
  中途出错或关了窗口：重新运行一次，生成一把新的，两处都换成新值（旧值作废即可，它不加密任何数据）。

.PARAMETER Target
  production（正式：Supabase 项目 lemomemo-prod ＋ lemo-ops）或 preview（预览：只有 Supabase 项目 lemomemo-preview）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记\柠檬记APP\tools\keys\new-ops-secret.ps1" -Target production
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

# 安全窗口检查（剪贴板历史、transcript、PowerShell 日志策略）：十二个密钥脚本共用 tools/keys/safe-window.ps1（B7a 评审第 16 条；tests/build/keys-guard-sync.test.ts 核对）
$SafeWindow = Join-Path $PSScriptRoot 'safe-window.ps1'
if (-not (Test-Path -LiteralPath $SafeWindow -PathType Leaf)) { throw "已停止：缺少 $SafeWindow（安全窗口检查），请从仓库完整取出 tools\keys 目录" }
. $SafeWindow

function Assert-SafeWindow {
    # 10-29 负责人定（R-223）：不再检查 Claude 是否在运行
    Assert-NoRecording
}

if ($Target -eq 'preview') {
    $label = '预览'; $supa = 'lemomemo-preview'
} else {
    $label = '正式'; $supa = 'lemomemo-prod'
}

$bytes = $null
$value = $null
$shown = $false
try {
    Say ''
    Say "== 生成 $label 环境的 OPS_SECRET：先检查 =="
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
    Say "== $label 环境的 OPS_SECRET（只显示这一次，按回车后清屏） =="
    Say ''
    Say '  值（64 位，只有 0～9 和 a～f）：'
    Say ''
    $shown = $true
    [Console]::WriteLine("      $value")
    Say ''
    Say "  SHA-256（不是密钥，用来核对 Supabase 页面上的 Digest）：$digest"
    Say ''
    if ($Target -eq 'production') {
        Say '  两处要一模一样（不用另存，丢了重新运行本脚本、两处一起换，R-220）：'
        Say "    1. Supabase › $supa › Edge Functions › Secrets：Name 填 OPS_SECRET，Value 粘贴，保存；"
        Say '    2. 另开一个 PowerShell 窗口，照上线与回滚手册第三节“第一次部署前设六个密钥”那段命令设 lemo-ops 的密钥，'
        Say '       问到 OPS_SECRET 时粘贴同一个值（问到其他几项照手册填）。'
    } else {
        Say '  预览环境没有 lemo-ops，只放一处（不用另存，丢了重新运行本脚本，R-220）：'
        Say "    Supabase › $supa › Edge Functions › Secrets：Name 填 OPS_SECRET，Value 粘贴，保存。"
    }
    Say '  复制方法：用鼠标选中上面那一行的值（不要带前后的空格），按回车或右键复制。'
    Say '  不要截图、不要发给 Claude 或任何人。'
    Say ''
    $null = Read-Host '  都做好了按回车（会清屏、清剪贴板）'
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
        Write-Host "已清屏、清剪贴板。$label 环境的 OPS_SECRET 只在你刚才放的地方。" -ForegroundColor Green
        Write-Host '最后关掉这个 PowerShell 窗口，在聊天里说“OPS_SECRET（' -NoNewline
        Write-Host $label -NoNewline
        Write-Host '）做好了”。'
    }
}
