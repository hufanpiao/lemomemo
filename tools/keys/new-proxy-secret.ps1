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
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记\柠檬记APP\tools\keys\new-proxy-secret.ps1" -Target preview
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
