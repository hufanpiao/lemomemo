<#
.SYNOPSIS
  设邀请注册要用的三个 Edge Function secret：RESEND_API_KEY、TURNSTILE_SECRET、SIGNUP_HASH_SECRET
  （架构 8.4、0.38 第 19 条；明早清单第 24 条、验收清单 D3）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，AI 不经手明文。

.DESCRIPTION
  invite-signup 缺这三个里的任何一个都回 500 misconfigured（RESEND_API_KEY、TURNSTILE_SECRET 在 index.ts 入口查，SIGNUP_HASH_SECRET 在 core.ts 查）。
  account、account-purge 也读 RESEND_API_KEY，account-purge 也读 SIGNUP_HASH_SECRET。
  本脚本做的事（按顺序，任何一步不过就停）：
    1. 开头检查（和其他密钥脚本同一段、逐字相同，tests/build/keys-guard-sync.test.ts 核对）：Windows 剪贴板历史关着、
       系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略、本窗口没在记 transcript；关掉本窗口的历史记录；
    2. 粘贴一把临时的 Supabase 管理令牌（Read-Host -AsSecureString，屏幕不显示，读完清剪贴板）；
    3. GET /v1/projects/{ref} 核对项目名（预览 lemomemo-preview、正式 lemomemo-prod）和地区（首尔），防止贴错环境；
    4. GET /v1/projects/{ref}/secrets 记下现有 secrets 的名字（只取 name 字段、不打印响应：列表响应里可能带着值或摘要）。
       三个名字里已经有的**不覆盖**，除非用 -Rotate 点名要换；三个都有、又没点名换，就什么都不写；
    5. 要写的才问：RESEND_API_KEY、TURNSTILE_SECRET 由负责人粘贴（Read-Host -AsSecureString，读完清剪贴板），
       做格式粗检（Resend 以 re_ 开头；Turnstile 正式密钥以 0x4 开头、至少 33 个字符（挡住约 24 个字符的 Site Key），
       1x / 2x / 3x 开头的是 Cloudflare 的测试密钥，拒收），
       格式不对当场重贴，最多 3 次，只报长度和开头对不对；
       SIGNUP_HASH_SECRET 在本机用 RandomNumberGenerator 生成 32 字节、写成 64 个小写十六进制字符
       （函数只要求非空：_shared/email-hash.ts 把它按 UTF-8 当 HMAC-SHA256 的密钥；架构 8.4 定 32 字节随机）；
    6. POST /v1/projects/{ref}/secrets 一次写入（值只在这个 HTTPS 请求正文里出现一次），马上清掉内存里的变量；
       写完 GET 核对要写的名字都在、三个名字都在、原有的 secrets 一个没少。
  不用 supabase CLI：`supabase secrets set` 只能把值写在命令行参数里或先写进 env 文件，两样都违反「值不进命令行参数、不落盘」。
  屏幕上只显示「已写入」和名字，任何时候都不打印值、令牌；不写任何文件；不用剪贴板放值。
  出错只打印状态码和对方的错误说明；写 secrets 那一次出错时连对方的说明也不打印（响应里可能带明文）；
  所有报错打印前把值和令牌换成 ***；接口请求不跟随跳转（-MaximumRedirection 0）；结束时清掉 $Error。
  不另存（R-220）：丢了就到 Resend、Cloudflare 重新生成，加 -Rotate 重跑。

  临时管理令牌（R-220：不另存，用完删）：Supabase › Account › Access Tokens › 新建项目级令牌（Scoped PAT），
  **只选这个项目**（预览 lemomemo-preview 或正式 lemomemo-prod），到期设 1 天，权限只勾下面两项，其余一律不给：
    - Edge Function Secrets：Read-write（写入并核对；Bulk create secrets、List all secrets）
    - Project Settings：Read          （核对项目名；Get project）
  权限名照 Supabase 官方文档和 set-cron-secret.ps1 写，**没有在真实的令牌页面上核对过**，第一次跑预览时确认。

.PARAMETER Target
  preview 或 prod。

.PARAMETER Rotate
  要换掉的名字，逗号分隔：RESEND_API_KEY、TURNSTILE_SECRET、SIGNUP_HASH_SECRET，或 all（三个都换）。不写就只补没有的。
  换 SIGNUP_HASH_SECRET 的后果：还在 10 分钟里的注册要重来、注册限流计数归零（架构 8.4），没有别的影响。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-signup-secrets.ps1" -Target preview

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-signup-secrets.ps1" -Target preview -Rotate RESEND_API_KEY
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'prod')][string]$Target,
    # 用 -File 运行时逗号分隔的列表会作为一个字符串传进来，所以这里收字符串、下面自己拆
    [ValidatePattern('\A(RESEND_API_KEY|TURNSTILE_SECRET|SIGNUP_HASH_SECRET|all)(,(RESEND_API_KEY|TURNSTILE_SECRET|SIGNUP_HASH_SECRET|all))*\z')][string]$Rotate,
    # 只给测试用（tests/build/set-signup-secrets.test.ts）：把管理接口指向本机假服务。只接受官方地址或 http://127.0.0.1:端口（\A…\z 整串匹配），
    # 令牌不会被发到别的主机；本机地址还要另设环境变量 LEMO_TEST_API=1 才生效。LEMO_TEST_API 只限测试使用，不要在本机长期设着
    [Parameter(DontShow = $true)][ValidatePattern('\A(https://api\.supabase\.com|http://127\.0\.0\.1:\d{1,5})\z')][string]$ApiBase = 'https://api.supabase.com'
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

if ($ApiBase -ne 'https://api.supabase.com' -and $env:LEMO_TEST_API -ne '1') {
    throw '已停止：-ApiBase 只给测试用，正式运行不要带这个参数'
}

if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { }
}

$NAMES = @('RESEND_API_KEY', 'TURNSTILE_SECRET', 'SIGNUP_HASH_SECRET')
$rotateSet = @()
if ($Rotate) {
    $rotateSet = @($Rotate -split ',')
    # ValidatePattern 不分大小写：这里再按大写原样核对一遍（-cnotcontains 区分大小写）
    foreach ($n in $rotateSet) {
        if ($n -cne 'all' -and $NAMES -cnotcontains $n) { throw "已停止：-Rotate 只认 RESEND_API_KEY、TURNSTILE_SECRET、SIGNUP_HASH_SECRET、all（大写原样，逗号分隔），收到「$n」" }
    }
    if ($rotateSet -contains 'all') { $rotateSet = $NAMES }
}

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ✘ $msg" -ForegroundColor Yellow }
# 报错打印前，把内存里的值和令牌换成 ***（变量还没建时跳过，StrictMode 下不报错）
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    foreach ($n in 'resendKey', 'turnstileKey', 'hashKey', 'sbTok') {
        $v = Get-Variable -Name $n -Scope Script -ValueOnly -ErrorAction SilentlyContinue
        if ($v -is [string] -and $v.Length -ge 8) { $s = $s.Replace($v, '***') }
    }
    return $s
}
function Fail([string]$msg) { throw "已停止：$(Hide-Secrets $msg)" }

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

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 粘贴一个值：屏幕不显示，读完清剪贴板；网页复制可能带零宽字符、不换行空格，统一去掉；
# 格式不对时当场重贴（最多 3 次），只报长度和开头对不对（$hint 是开头的写法，$extra 返回额外的说明或空串）
function Read-Value([string]$label, [string]$where, [string]$pattern, [string]$prefix, [scriptblock]$extra) {
    Say ''
    Say "请粘贴：$label"
    Say "  （$where。屏幕上不显示，粘贴后按回车。）"
    for ($try = 1; $try -le 3; $try++) {
        $sec = Read-Host -AsSecureString '  粘贴到这里'
        Clear-Clip
        $plain = To-Plain $sec
        $sec.Dispose()
        $plain = $plain -replace '[\s\u00A0\u200B-\u200D\u2060\uFEFF]', ''
        $why = if ($extra) { [string](& $extra $plain) } else { '' }
        if (-not $why -and $plain -cmatch $pattern) {
            Ok "$label 已收到（剪贴板已清空）"
            return $plain
        }
        $len = $plain.Length
        $head = if ($plain.StartsWith($prefix)) { "以 $prefix 开头" } else { "不是以 $prefix 开头" }
        $plain = $null
        if ($why) { Warn "$why（收到 $len 个字符）" } else { Warn "格式不对（要以 $prefix 开头）：收到 $len 个字符，$head。多半复制错了或没复制全" }
        if ($try -lt 3) { Say '  请回到网页重新复制，再粘贴一次：' }
    }
    Fail "$label 连续 3 次格式不对，已停止"
}

# Supabase 令牌（同 set-cron-secret.ps1：sbp_ 开头）
function Read-Token([string]$label, [string]$where) {
    return Read-Value $label $where '\Asbp_[A-Za-z0-9_]{20,}\z' 'sbp_' $null
}

# 调接口；出错时只打印状态码和对方的错误说明。
# -NoDetail：只打印状态码，不回显对方的响应正文（写 secrets 时用：响应里可能带着明文）。
# -MaximumRedirection 0：不跟随跳转，带着令牌的请求不会被转到别的地址
function Invoke-Api([string]$method, [string]$uri, [hashtable]$headers, [string]$json, [switch]$NoDetail) {
    try {
        if ($json) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0 -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) }
        return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0
    } catch {
        $code = ''; $detail = ''
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($NoDetail) {
            $detail = '（不显示对方的说明：里面可能带着值）'
        } else {
            try { $detail = [string]$_.ErrorDetails.Message } catch { }
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

# 只取 name 字段（列表响应里可能带着值或摘要，一律不碰）
function Get-SecretNames([string]$api, [hashtable]$headers) {
    return ,@((As-List (Invoke-Api GET "$api/secrets" $headers '')) | ForEach-Object { [string](Get-Prop $_ 'name') })
}

# SIGNUP_HASH_SECRET：本机 RandomNumberGenerator 生成 32 字节，写成 64 个小写十六进制字符
function New-HashSecret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [Array]::Clear($bytes, 0, $bytes.Length)
    return $hex
}

# Turnstile：1x / 2x / 3x 开头的是 Cloudflare 文档里的测试密钥（总是通过、总是失败、令牌已用过），不能当正式密钥
$TurnstileExtra = {
    param($v)
    if ($v -cmatch '\A[123]x0{20,}') { return '这是 Cloudflare 的测试密钥（1x / 2x / 3x 开头），不能用；请到 Turnstile 小组件的设置里复制 Secret Key' }
    return ''
}

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $supaName = 'lemomemo-preview'; $ref = 'yoeqwhygehbaftkppati'; $site = 'preview.lemomemo.com'
} else {
    $label = '正式'; $supaName = 'lemomemo-prod'; $ref = 'uvlnwawwsdfihziaielj'; $site = 'lemomemo.com'
}

$resendKey = $null; $turnstileKey = $null; $hashKey = $null; $sbTok = $null; $sbH = $null; $body = $null; $items = $null
try {
    Step "给$label 环境设注册用的三个 secret：先检查"
    Assert-SafeWindow
    # ref 不是密钥，直接写在脚本里（环境清单-v4 记着同样的值）；下面会用临时令牌核对项目名，不对就停
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
    Ok "现有 $($before.Count) 个 secrets（只看名字）"
    $todo = @()
    foreach ($n in $NAMES) {
        if ($before -notcontains $n) { $todo += $n; Say "  $n：还没有，这次新建" }
        elseif ($rotateSet -contains $n) { $todo += $n; Say "  $n：已有，按 -Rotate 换新" }
        else { Say "  $n：已有，不覆盖（要换的话加 -Rotate $n）" }
    }
    if ($todo.Count -eq 0) {
        Say ''
        Say "三个都已经有了，这次什么都没写。在聊天里说「$label 的注册密钥本来就都在」。"
        Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
        return
    }

    if ($todo -contains 'RESEND_API_KEY') {
        Step '粘贴 Resend 密钥（RESEND_API_KEY）'
        $resendKey = Read-Value 'Resend API 密钥' "Resend › API Keys 里新建的那把：权限选 Sending access、域名只选 lemomemo.com，以 re_ 开头" '\Are_[A-Za-z0-9_]{16,}\z' 're_' $null
    }
    if ($todo -contains 'TURNSTILE_SECRET') {
        Step '粘贴 Turnstile 密钥（TURNSTILE_SECRET）'
        $turnstileKey = Read-Value 'Turnstile Secret Key' "Cloudflare › Turnstile › 给 $site 用的那个小组件 › Settings 里的 Secret Key（不是 Site Key），以 0x4 开头" '\A0x4[A-Za-z0-9_-]{30,}\z' '0x4' $TurnstileExtra
    }
    if ($todo -contains 'SIGNUP_HASH_SECRET') {
        Step '生成 SIGNUP_HASH_SECRET（本机随机 32 字节，不显示）'
        $hashKey = New-HashSecret
        if ($hashKey -cnotmatch '\A[0-9a-f]{64}\z') { Fail 'SIGNUP_HASH_SECRET 生成得不对' }
        Ok '已生成（64 个十六进制字符，只在内存里）'
    }

    Step "写入 Supabase：$supaName › Edge Functions › Secrets（$($todo -join '、')）"
    $items = @()
    if ($resendKey) { $items += @{ name = 'RESEND_API_KEY'; value = $resendKey } }
    if ($turnstileKey) { $items += @{ name = 'TURNSTILE_SECRET'; value = $turnstileKey } }
    if ($hashKey) { $items += @{ name = 'SIGNUP_HASH_SECRET'; value = $hashKey } }
    if ($items.Count -ne $todo.Count) { Fail '要写的值没凑齐' }
    $body = ConvertTo-Json -InputObject @($items) -Compress
    $null = Invoke-Api POST "$api/secrets" $sbH $body -NoDetail
    $body = $null; $items = $null; $resendKey = $null; $turnstileKey = $null; $hashKey = $null

    $have = Get-SecretNames $api $sbH
    $miss = @($NAMES | Where-Object { $have -notcontains $_ })
    if ($miss.Count) { Fail "写入后 Supabase 上还是没有：$($miss -join '、')" }
    $lost = @($before | Where-Object { $have -notcontains $_ })
    if ($lost.Count) { Fail "写入后原有的 secrets 不见了：$($lost -join '、')。请在聊天里告诉运维" }
    Ok "已写入 $($todo -join '、')；三个名字都在，原有的 $($before.Count) 个 secrets 都在"

    Say ''
    Say "全部写好。在聊天里说「$label 的注册密钥设好了」，然后再试一次用邀请码注册。"
    Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
}
catch {
    throw (Hide-Secrets ([string]$_.Exception.Message))
}
finally {
    $resendKey = $null; $turnstileKey = $null; $hashKey = $null; $sbTok = $null; $sbH = $null; $body = $null; $items = $null
    Clear-Clip
    [GC]::Collect()
    $Error.Clear()   # 自动变量 $Error 里的报错记录可能带着值的片段（例如对方回显的正文），一并清掉
    Write-Host '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
