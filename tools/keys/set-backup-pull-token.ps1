<#
.SYNOPSIS
  生成 BACKUP_PULL_TOKEN（架构 8.4、第 6 节 backup-manifest 行、第 10 节；B7a 复审第 8 条）：本机生成，经 Supabase 管理接口写进函数 secret，
  同时写进本机 Windows 凭据管理器 lemomemo.backup.pull（pull.ps1 读这一条）。由产品负责人本人在自己电脑的 PowerShell 窗口里运行，AI 不经手明文。

.DESCRIPTION
  backup-manifest 拿 Authorization: Bearer <BACKUP_PULL_TOKEN> 和自己的 BACKUP_PULL_TOKEN 定长比较；pull.ps1 从凭据管理器读同一个值。
  两边必须一样，所以由本脚本一次设好两边。做的事（按顺序，任何一步不过就停）：
    1. 开头检查（tools/keys/safe-window.ps1，和其他密钥脚本同一份，tests/build/keys-guard-sync.test.ts 核对）：Windows 剪贴板历史关着、
       系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略、本窗口没在记 transcript；关掉本窗口的历史记录；
    2. 粘贴一把临时的 Supabase 管理令牌（Read-Host -AsSecureString，屏幕不显示，读完清剪贴板）；
    3. GET /v1/projects/{ref} 核对项目名（预览 lemomemo-preview、正式 lemomemo-prod）和地区（首尔），防止贴错环境；
    4. GET /v1/projects/{ref}/secrets 记下现有 secrets 的名字（只取 name 字段、不打印响应）；
    5. 在本机内存里生成 32 字节随机值（.NET RandomNumberGenerator），写成 64 位小写十六进制；
    6. POST /v1/projects/{ref}/secrets 写成 BACKUP_PULL_TOKEN（值只在这个 HTTPS 请求正文里出现一次）；写完 GET 核对名字在、原有的 secrets 一个没少；
    7. 只有正式（prod）：写进凭据管理器 lemomemo.backup.pull（tools/keys/cred.ps1 的 Write-LemoCred，Win32 CredWriteW，不经 cmdkey），
       读回来核对一样（不打印）。预览没有本机拉取（pull.ps1 只认 lemomemo.com），只写函数 secret；
    8. 显示下次轮换的日期（今天 + 90 天）。pull.ps1 每次读凭据管理器里这一条的写入时刻，满 90 天在 失败原因.txt 里提示轮换。
  屏幕上只显示「已写入」和名字，任何时候都不打印值、令牌；不写任何文件；不用剪贴板放值。
  出错只打印状态码和对方的错误说明；写 secrets 那一次出错时连对方的说明也不打印；所有报错打印前把值和令牌换成 ***；
  接口请求不跟随跳转（-MaximumRedirection 0）；结束时清掉 $Error。
  第 6 步发出以后、第 7 步没做完，红字提示「函数侧的 BACKUP_PULL_TOKEN 已换、本机凭据管理器还没换好，请立刻重跑本脚本」：
  这时 pull.ps1 会被 401 拒掉（不会出安全问题，只是当天拉不下来），重跑一次两边一起换即可。
  不另存（R-220；负责人 11-26 定：这把只读备份令牌存凭据管理器，是 R-220 的例外）：丢了就重新运行本脚本，两边一起换。

  轮换（每 90 天一次，或怀疑泄露时马上做；上线与回滚手册第七节「备份拉取令牌 BACKUP_PULL_TOKEN 每 90 天轮换」）：
    1. 新建临时管理令牌（见下）；2. 运行本脚本 -Target prod（旧值立刻作废）；3. 删掉临时管理令牌；
    4. 运行一次 pull.ps1（不带参数），看到「已写心跳 backup-pull」、退出码 0 才算换好。

  临时管理令牌（R-220：不另存，用完删）：Supabase › Account › Access Tokens › 新建项目级令牌（Scoped PAT），
  **只选这个项目**（预览 lemomemo-preview 或正式 lemomemo-prod），到期设 1 天，权限只勾下面两项，其余一律不给：
    - Edge Function Secrets：Read-write（写入并核对；Bulk create secrets、List all secrets）
    - Project Settings：Read          （核对项目名；Get project）
  权限名 2026-11-26 对着 Supabase 官方文档核过（控制台的令牌页面本人没打开看过，第一次跑预览时再看一眼）：
    - 令牌指南 https://supabase.com/docs/guides/platform/personal-access-tokens
      原文：Edge Function Secrets「Read: List all secrets; Read-write: Bulk create secrets, Bulk delete secrets」；
      Project Settings 的 Read 管「Get project」。
    - 接口参考里本脚本调的三个接口各要的细粒度权限（原文 "The fine-grained token must include the following permissions"）：
      GET  /v1/projects/{ref}          project_admin_read            https://supabase.com/docs/reference/api/v1-get-project
      GET  /v1/projects/{ref}/secrets  edge_functions_secrets_read   https://supabase.com/docs/reference/api/v1-list-all-secrets
      POST /v1/projects/{ref}/secrets  edge_functions_secrets_write  https://supabase.com/docs/reference/api/v1-bulk-create-secrets
    - 文档没写 Read-write 是否连带 Read（令牌指南里 MCP 的 create_edge_function_secret 写的是两项都要）：
      要是读名单回 403，响应里的 missing_permissions 会列出缺哪一项（官方更新日志
      https://supabase.com/changelog/scoped-personal-access-tokens-ga 原文「A 403 lists the permissions the token lacks」），照它补勾。

.PARAMETER Target
  preview 或 prod。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记\柠檬记APP\tools\keys\set-backup-pull-token.ps1" -Target prod
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'prod')][string]$Target,
    # 只给测试用（tests/build/set-backup-pull-token.test.ts）：把管理接口指向本机假服务。只接受官方地址或 http://127.0.0.1:端口（\A…\z 整串匹配），
    # 令牌不会被发到别的主机；本机地址还要另设环境变量 LEMO_TEST_API=1 才生效。LEMO_TEST_API 只限测试使用，不要在本机长期设着
    [Parameter(DontShow = $true)][ValidatePattern('\A(https://api\.supabase\.com|http://127\.0\.0\.1:\d{1,5})\z')][string]$ApiBase = 'https://api.supabase.com'
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8   # 先设好，下面的报错才不是乱码

# 只许用 -File 运行：点源（. 脚本）或把内容粘贴进窗口跑，脚本里的变量（值、令牌）会留在窗口的会话里（照搬 login-token-tests.ps1）
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

if ($ApiBase -ne 'https://api.supabase.com' -and $env:LEMO_TEST_API -ne '1') {
    throw '已停止：-ApiBase 只给测试用，正式运行不要带这个参数'
}

if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { }
}

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ✘ $msg" -ForegroundColor Yellow }
# 报错打印前，把内存里的 BACKUP_PULL_TOKEN 和令牌换成 ***（变量还没建时跳过，StrictMode 下不报错）
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    foreach ($n in 'value', 'sbTok') {
        $v = Get-Variable -Name $n -Scope Script -ValueOnly -ErrorAction SilentlyContinue
        if ($v -is [string] -and $v.Length -ge 8) { $s = $s.Replace($v, '***') }
    }
    return $s
}
function Fail([string]$msg) { throw "已停止：$(Hide-Secrets $msg)" }

# 粘贴令牌后、结束时清剪贴板（剪贴板里只会有负责人粘贴的令牌，脚本不往剪贴板里放任何东西）
function Clear-Clip {
    try { Set-Clipboard -Value ' ' } catch { }
    try { Add-Type -AssemblyName System.Windows.Forms } catch { }
    try { [System.Windows.Forms.Clipboard]::Clear() } catch { }
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

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 粘贴令牌：屏幕不显示，读完清剪贴板；网页复制可能带零宽字符、不换行空格，统一去掉；
# 格式不对时当场重贴（最多 3 次），只报长度和是不是以 sbp_ 开头（同 set-fn-role-passwords.ps1）
function Read-Token([string]$label, [string]$where) {
    Say ''
    Say "请粘贴：$label"
    Say "  （$where。屏幕上不显示，粘贴后按回车。）"
    for ($try = 1; $try -le 3; $try++) {
        $sec = Read-Host -AsSecureString '  粘贴到这里'
        Clear-Clip
        $plain = To-Plain $sec
        $sec.Dispose()
        $plain = $plain -replace '[\s\u00A0\u200B-\u200D\u2060\uFEFF]', ''
        if ($plain -match '^sbp_[A-Za-z0-9_]{20,}$') {
            Ok "$label 已收到（剪贴板已清空）"
            return $plain
        }
        $len = $plain.Length
        $head = if ($plain.StartsWith('sbp_')) { '以 sbp_ 开头' } else { '不是以 sbp_ 开头' }
        $plain = $null
        Warn "格式不对（要以 sbp_ 开头）：收到 $len 个字符，$head。多半复制错了或没复制全"
        if ($try -lt 3) { Say '  请回到网页重新复制，再粘贴一次：' }
    }
    Fail "$label 连续 3 次格式不对，已停止"
}

# 调接口；出错时只打印状态码和对方的错误说明。
# -NoDetail：只打印状态码，不回显对方的响应正文（写 secrets 时用：响应里可能带着 BACKUP_PULL_TOKEN 明文）。
# -MaximumRedirection 0：不跟随跳转，带着令牌的请求不会被转到别的地址
function Invoke-Api([string]$method, [string]$uri, [hashtable]$headers, [string]$json, [switch]$NoDetail) {
    try {
        if ($json) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0 -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) }
        return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0
    } catch {
        $code = ''; $detail = ''
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($NoDetail) {
            $detail = '（不显示对方的说明：里面可能带着 BACKUP_PULL_TOKEN）'
        } else {
            try { $detail = [string]$_.ErrorDetails.Message } catch { }
            # 正文是 JSON 时只取 message / msg / error（pwsh 7 会把原文重新排版、引号转成 "）；解析不了就用原文
            try {
                $j = $detail | ConvertFrom-Json -ErrorAction Stop
                if ($j -is [psobject]) {
                    foreach ($k in 'message', 'msg', 'error') {
                        $p = $j.PSObject.Properties[$k]
                        if ($p -and $p.Value -is [string] -and $p.Value) { $detail = $p.Value; break }
                    }
                }
            } catch { }
            if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
        }
        Fail "$method $([Uri]$uri | ForEach-Object { $_.Host + $_.AbsolutePath }) 失败（HTTP $code）：$detail"
    }
}

# PowerShell 5.1 的 Invoke-RestMethod 会把 JSON 数组当成一个对象交出来，这里统一摊平成数组；空响应得到空数组
function As-List($r) {
    if ($null -eq $r -or ($r -is [string] -and $r -eq '')) { return ,@() }
    return ,@($r | ForEach-Object { $_ })
}

# StrictMode 下读不存在的属性会报错：缺字段时返回 $null
function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj -or $obj -isnot [psobject]) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

function Get-SecretNames([string]$api, [hashtable]$headers) {
    return ,@((As-List (Invoke-Api GET "$api/secrets" $headers '')) | ForEach-Object { [string](Get-Prop $_ 'name') })
}

# 凭据管理器读写（tools/keys/cred.ps1；pull.ps1 读同一条 lemomemo.backup.pull）
. (Join-Path $PSScriptRoot 'cred.ps1')
$CredTarget = 'lemomemo.backup.pull'

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $supaName = 'lemomemo-preview'; $ref = 'yoeqwhygehbaftkppati'
} else {
    $label = '正式'; $supaName = 'lemomemo-prod'; $ref = 'uvlnwawwsdfihziaielj'
}
$RERUN = '函数侧的 BACKUP_PULL_TOKEN 已换、本机凭据管理器还没换好（pull.ps1 会被 401 拒掉），请立刻重跑本脚本'

$value = $null; $sbTok = $null; $sbH = $null; $body = $null; $bytes = $null; $back = $null
$posted = $false; $allDone = $false
try {
    Step "给$label 环境生成 BACKUP_PULL_TOKEN：先检查"
    Assert-SafeWindow
    Ok "$label Project ref 已自动填好"
    $api = "$ApiBase/v1/projects/$ref"

    Step '粘贴临时管理令牌（只用来写这一次）'
    $sbTok = Read-Token "Supabase 令牌（只管 $supaName）" '刚临时生成的项目级令牌：只选这个项目、1 天到期，权限只勾 Edge Function Secrets 读写、Project Settings 只读，用完删掉'
    $sbH = @{ Authorization = "Bearer $sbTok" }

    Step '核对项目（防止贴错环境）'
    $proj = Invoke-Api GET $api $sbH ''
    $projName = Get-Prop $proj 'name'
    if ($projName -ne $supaName) { Fail "这个 Supabase 项目叫「$projName」，不是 $supaName。是不是贴成了另一个环境的令牌？" }
    $region = Get-Prop $proj 'region'
    if ($region -ne 'ap-northeast-2') { Fail "Supabase 项目不在首尔（$region）" }
    Ok "Supabase 项目：$projName（首尔）"

    $before = Get-SecretNames $api $sbH
    $had = if ($before -contains 'BACKUP_PULL_TOKEN') { '已有，这次换新（旧值作废）' } else { '还没有，这次新建' }
    Ok "现有 $($before.Count) 个 secrets（只看名字）；BACKUP_PULL_TOKEN $had"

    Step '在本机生成新值（32 字节随机，只在内存里）'
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $value = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    [Array]::Clear($bytes, 0, $bytes.Length)
    if ($value -cnotmatch '\A[0-9a-f]{64}\z') { Fail '生成的值格式不对' }
    Ok '已生成（64 个十六进制字符）'

    Step "写入 Supabase：$supaName › Edge Functions › Secrets › BACKUP_PULL_TOKEN"
    $body = ConvertTo-Json -InputObject @(@{ name = 'BACKUP_PULL_TOKEN'; value = $value }) -Compress
    $posted = $true   # 请求一发出去就当作可能已换（对方可能换了但回包丢了）
    $null = Invoke-Api POST "$api/secrets" $sbH $body -NoDetail
    $body = $null
    $have = Get-SecretNames $api $sbH
    if ($have -notcontains 'BACKUP_PULL_TOKEN') { Fail 'Supabase 上没有 BACKUP_PULL_TOKEN' }
    $lost = @($before | Where-Object { $have -notcontains $_ })
    if ($lost.Count) { Fail "写入后原有的 secrets 不见了：$($lost -join '、')。请在聊天里告诉运维" }
    Ok "已写入 BACKUP_PULL_TOKEN；原有的 $($before.Count) 个 secrets 都在"

    if ($Target -eq 'prod') {
        Step "写进本机 Windows 凭据管理器：$CredTarget"
        Write-LemoCred $CredTarget 'lemomemo' $value
        $back = Read-LemoCred $CredTarget
        if (-not $back -or $back.Secret -cne $value) { $back = $null; Fail "凭据管理器里的 $CredTarget 读回来对不上" }
        $back = $null
        Ok "已写进 $CredTarget（读回核对一样）"
    } else {
        Ok '预览没有本机拉取（pull.ps1 只认 lemomemo.com），不写凭据管理器'
    }
    $value = $null
    $allDone = $true

    Say ''
    Say "全部写好。下次轮换：$((Get-Date).AddDays(90).ToString('yyyy-MM-dd'))（90 天；pull.ps1 到时会在 失败原因.txt 里提示）。"
    if ($Target -eq 'prod') { Say '再运行一次 tools\backup\pull.ps1（不带参数），看到「已写心跳 backup-pull」、退出码 0 才算换好。' }
    Say "在聊天里说「$label 的 BACKUP_PULL_TOKEN 设好了」。"
    Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
}
catch {
    $msg = Hide-Secrets ([string]$_.Exception.Message)
    if ($posted -and -not $allDone -and $Target -eq 'prod') {
        $msg = "$RERUN。$msg"
        Write-Host "  ✘ $msg" -ForegroundColor Red
    }
    throw $msg
}
finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    $value = $null; $sbTok = $null; $sbH = $null; $body = $null; $back = $null
    Clear-Clip
    [GC]::Collect()
    $Error.Clear()   # 自动变量 $Error 里的报错记录可能带着值的片段，一并清掉
    Write-Host '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
