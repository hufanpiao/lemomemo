<#
.SYNOPSIS
  生成 Web Push 用的 VAPID 密钥对（P-256），把私钥 VAPID_PRIVATE_KEY、公钥 VAPID_PUBLIC_KEY 和 VAPID_SUBJECT 写进对应 Supabase 项目的 Edge Function secrets，
  打印公钥给负责人填 GitHub 仓库变量（B2 任务单 O-1、架构审 M9；R-282、R-283）。由产品负责人本人在自己电脑的 PowerShell 窗口里运行，AI 不经手私钥。

.DESCRIPTION
  私钥格式（BE-1 第 1 天定，M9）：VAPID_PRIVATE_KEY 是一行 JWK JSON
    {"kty":"EC","crv":"P-256","d":"…","x":"…","y":"…"}
  d、x、y 都是 32 字节的 base64url（43 个字符，不带“=”）。公钥是 0x04‖x‖y 的 base64url（87 个字符），是公开值。
  本脚本做的事（按顺序，任何一步不过就停）：
    1. 开头检查（和其他密钥脚本同一段、逐字相同）：Windows 剪贴板历史关着、系统没开 PowerShell 的 transcript / 模块日志 /
       脚本块日志策略、本窗口没在记 transcript；关掉本窗口的历史记录；
    2. 粘贴一把临时的 Supabase 管理令牌（Read-Host -AsSecureString，屏幕不显示，读完清剪贴板）；
    3. GET /v1/projects/{ref} 核对项目名（预览 lemomemo-preview、正式 lemomemo-prod）和地区（首尔），防止贴错环境；
    4. GET /v1/projects/{ref}/secrets 记下现有 secrets 的名字（只取 name 字段，不打印响应）；
    5. 在本机内存里生成 P-256 密钥对（.NET ECDsa，nistP256），取 D、Q.X、Q.Y 转成 base64url，拼成上面那一行 JWK；
       校验三个值都是 32 字节；**成对自检**：从拼好的 JWK 里重新解出 d、x、y，用 d 签一条随机消息、只用 x、y 验签，
       验不过、或改一个字节后居然验得过，就停（Deno 导入 JWK 时不检查 x、y 和 d 是否成对，错了要到推送服务回 401/403 才发现）；
    6. POST /v1/projects/{ref}/secrets 一次写入三项：VAPID_PRIVATE_KEY（私钥 JWK）、VAPID_PUBLIC_KEY（公钥，87 个字符）、
       VAPID_SUBJECT（-Subject 的值），马上清掉内存里的变量；写完 GET 核对三个名字都在、原有的 secrets 一个没少；
       顺带只拿两个公开值（VAPID_PUBLIC_KEY、VAPID_SUBJECT）和接口返回的 value 比，屏幕上只报“接口返回：明文 / 摘要 / 不清楚”，
       不打印任何值，私钥那一项不参与比较（安全审查 O1-S3，回答 O1-P1 的“列表接口给的是明文还是摘要”）。
       VAPID_PUBLIC_KEY 是安全审查 C-9 要的：push-dispatch 启动时拿它和私钥 JWK 里的 x、y 逐字节比对，不过就回 500、一条都不发；
       三项必须同一个请求写入，不能只换其中一项；
    7. 打印公钥（和写进 VAPID_PUBLIC_KEY 的是同一串，87 个字符，公开值），负责人把它填进 GitHub 仓库变量：预览 PREVIEW_VAPID_PUBLIC_KEY、正式 PROD_VAPID_PUBLIC_KEY；
       构建时注入 VITE_PUBLIC_VAPID_KEY。公钥是构建时编进网页的，**改了变量要重新部署**才生效。
  不用 supabase CLI：`supabase secrets set` 只能把值写在命令行参数里或先写进 env 文件，两样都违反“值不进命令行参数、不落盘”。
  私钥只在本进程内存里和那一次 HTTPS 请求正文里出现；不进命令行参数、不写任何文件（包括临时文件）、不进 PowerShell 历史、
  不用剪贴板放值；屏幕上只显示“已写入”和名字，任何时候都不打印私钥、令牌。
  出错只打印状态码和对方的错误说明；写 secrets 那一次出错时连对方的说明也不打印（响应里可能回显请求正文）；
  所有报错打印前把私钥、令牌换成 ***；接口请求不跟随跳转（-MaximumRedirection 0）；结束时清掉 $Error。
  第 6 步发出以后没完成，会用红字提示“VAPID_PRIVATE_KEY 可能已换、公钥还没拿到，请立刻重跑本脚本”：
  这时新私钥可能已在函数里、网页里还是旧公钥，推送会被推送服务拒掉（401/403，push-dispatch 只加 push_fail_count、不删订阅），
  重跑一次、按新打印的公钥改 GitHub 变量并重新部署即可。
  不另存（R-282）：私钥丢了就重新运行本脚本换一对，步骤见 docs/00-团队/负责人-VAPID密钥-步骤.md 的“换钥匙”一节。

  临时管理令牌（R-220：不另存，用完删）：Supabase › Account › Access Tokens › 新建项目级令牌（Scoped PAT），
  **只选这个项目**（预览 lemomemo-preview 或正式 lemomemo-prod），到期设 1 天，权限只勾下面两项，其余一律不给：
    - Edge Function Secrets：Read-write（写入并核对 VAPID_PRIVATE_KEY、VAPID_PUBLIC_KEY、VAPID_SUBJECT；Bulk create secrets、List all secrets）
    - Project Settings：Read          （核对项目名；Get project）
  权限名照 Supabase 官方文档写，**没有在真实的令牌页面上核对过**，第一次跑预览时确认。跑完马上删令牌，删令牌在关窗口之前做。
  剩下的风险：PowerShell 的字符串没法逐字节清零，私钥会在本进程内存里短暂存在（用完即置空），最后要关窗口；
  Supabase 平台侧是否记录请求正文我们控制不了；临时令牌能**读**、改、删这个项目的所有函数 secrets，跑完马上删（安全审查 O1-S2）。
  正式那次（-Target prod，B7a 前）运行前必须满足两个前提（安全审查 O1-P1、O1-P2），见步骤文档“正式那次运行前”一节。

.PARAMETER Target
  preview 或 prod。

.PARAMETER Subject
  VAPID_SUBJECT（R-283）：默认 https://lemomemo.com。苹果不认（第一次推送测试回 403）时，当天改用 lemomemo.com 的 mailto: 地址重跑本脚本，
  例如 -Subject mailto:ops@lemomemo.com。只接受小写开头的 https:// 网址（不带端口）或 mailto: 地址（公开值，可以写在命令行里）。
  校验用的正则和后端 supabase/functions/_shared/push/vapid.ts 的 SUBJECT 一致、区分大小写（-cmatch），
  tests/build/set-vapid-keys.test.ts 直接从 vapid.ts 读出正则来比对（代码审查 M1、安全审查 O1-S5）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-vapid-keys.ps1" -Target preview

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-vapid-keys.ps1" -Target preview -Subject https://lemomemo.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'prod')][string]$Target,
    # VAPID_SUBJECT：https:// 网址或 mailto: 地址；格式在下面用 -cmatch 查（ValidatePattern 不分大小写，代码审查 M1）；不是密钥
    [ValidateLength(1, 200)]
    [string]$Subject = 'https://lemomemo.com',
    # 只给测试用：把管理接口指向本机假服务。只接受官方地址或 http://127.0.0.1:端口（\A…\z 整串匹配），
    # 令牌不会被发到别的主机；本机地址还要另设环境变量 LEMO_TEST_API=1 才生效。LEMO_TEST_API 只限测试使用，不要在本机长期设着
    [Parameter(DontShow = $true)][ValidatePattern('\A(https://api\.supabase\.com|http://127\.0\.0\.1:\d{1,5})\z')][string]$ApiBase = 'https://api.supabase.com'
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8   # 先设好，下面的报错才不是乱码

# 只许用 -File 运行：点源（. 脚本）或把内容粘贴进窗口跑，脚本里的变量（私钥、令牌）会留在窗口的会话里（照搬 set-cron-secret.ps1）
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
# 测试模式只许对着本机假服务：LEMO_TEST_API=1 会放宽上面的 & 调用检查，不能拿它对着官方接口跑（安全审查 O1-S6）
if ($env:LEMO_TEST_API -eq '1' -and $ApiBase -eq 'https://api.supabase.com') {
    throw '已停止：环境变量 LEMO_TEST_API=1 只给测试用（本机假服务），不能对着官方接口运行。请关掉这个窗口、新开一个 PowerShell 再运行'
}
if (-not $byFile -and $env:LEMO_TEST_API -ne '1') {
    throw '已停止：请用 powershell -NoProfile -ExecutionPolicy Bypass -File <脚本路径> 运行（不要在已打开的窗口里用 & 调用）'
}

# VAPID_SUBJECT 的格式：和后端 vapid.ts 的 SUBJECT 同一个正则（JS 的 ^…$ 写成 \A…\z），区分大小写：
# 只收小写的 https://（主机后不许带端口）和 mailto:，只许可见 ASCII、不许空白（代码审查 M1、安全审查 O1-S5）
$SubjectRe = '\A(?:https://[a-z0-9-]+(?:[.][a-z0-9-]+)+(?:/[A-Za-z0-9._~/-]*)?|mailto:[A-Za-z0-9._+-]+@[a-z0-9-]+(?:[.][a-z0-9-]+)+)\z'
if ($Subject -cnotmatch $SubjectRe) {
    throw '已停止：-Subject 格式不对。只接受小写开头的 https:// 网址（不带端口）或 mailto: 地址，例如 https://lemomemo.com 或 mailto:ops@lemomemo.com'
}

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
# 负责人误带 -Verbose、-Debug 时也不多打印请求细节（安全审查 O1-S7；Invoke-RestMethod 另外带 -Verbose:$false，同 publish.ps1）
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
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
# 报错打印前，把内存里的私钥 JWK、私钥 d、写 secrets 的请求正文和令牌换成 ***（变量还没建时跳过，StrictMode 下不报错；body 是安全审查 O1-S1）
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    foreach ($n in 'body', 'jwk', 'dB64', 'sbTok') {
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

function Assert-SafeWindow {
    # 10-29 负责人定（R-223）：不再检查 Claude 是否在运行
    Assert-NoRecording
}

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 粘贴令牌：屏幕不显示，读完清剪贴板；网页复制可能带零宽字符、不换行空格，统一去掉；
# 格式不对时当场重贴（最多 3 次），只报长度和是不是以 sbp_ 开头（同 set-cron-secret.ps1）
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
# -NoDetail：只打印状态码，不回显对方的响应正文（写 secrets 时用：响应里可能回显带私钥的请求正文）。
# -MaximumRedirection 0：不跟随跳转，带着令牌的请求不会被转到别的地址
function Invoke-Api([string]$method, [string]$uri, [hashtable]$headers, [string]$json, [switch]$NoDetail) {
    try {
        if ($json) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0 -Verbose:$false -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) }
        return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0 -Verbose:$false
    } catch {
        $code = ''; $detail = ''
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($NoDetail) {
            $detail = '（不显示对方的说明：里面可能带着私钥）'
        } else {
            try { $detail = [string]$_.ErrorDetails.Message } catch { }
            # 正文是 JSON 时只取 message / msg / error；解析不了就用原文
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

# 安全审查 O1-S3：列表接口 GET /secrets 返回的 value 是明文还是摘要（O1-P1 要的答案）。
# 只拿两个公开值（VAPID_PUBLIC_KEY、VAPID_SUBJECT）去比：和原值相等是“明文”，等于原值 UTF-8 的 SHA-256 十六进制是“摘要”，
# 都不是、缺这一项、两项结论不一样都算“不清楚”。私钥那一项不参与比较；只返回这三个词之一，不返回、不打印任何值
function Get-ValueKind($items, [hashtable]$known) {
    $kinds = @()
    foreach ($n in $known.Keys) {
        $it = @($items | Where-Object { [string](Get-Prop $_ 'name') -ceq $n })
        $v = if ($it.Count -eq 1) { Get-Prop $it[0] 'value' } else { $null }
        $it = $null
        if ($v -isnot [string] -or -not $v) { $kinds += '不清楚'; continue }
        if ($v -ceq $known[$n]) { $kinds += '明文'; continue }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hex = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$known[$n])) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
        if ($v -ieq $hex) { $kinds += '摘要' } else { $kinds += '不清楚' }
        $v = $null
    }
    $u = @($kinds | Sort-Object -Unique)
    if ($u.Count -eq 1) { return [string]$u[0] }
    return '不清楚'
}

# ───────────────────────── VAPID 密钥对 ─────────────────────────
$CurveP256 = [System.Security.Cryptography.ECCurve+NamedCurves]::nistP256
$Sha256 = [System.Security.Cryptography.HashAlgorithmName]::SHA256

function To-B64Url([byte[]]$b) { return [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function From-B64Url([string]$s) {
    $t = $s.Replace('-', '+').Replace('_', '/')
    switch ($t.Length % 4) { 2 { $t += '==' } 3 { $t += '=' } }
    return [Convert]::FromBase64String($t)
}

# 用 x、y 拼一个只有公钥的 ECDsa（验签用）
function New-PublicEc([byte[]]$x, [byte[]]$y) {
    $pt = New-Object System.Security.Cryptography.ECPoint
    $pt.X = $x; $pt.Y = $y
    $pp = New-Object System.Security.Cryptography.ECParameters
    $pp.Curve = $CurveP256; $pp.Q = $pt
    $ec = [System.Security.Cryptography.ECDsa]::Create()
    $ec.ImportParameters($pp)
    return $ec
}

# 生成一对，返回私钥 JWK 那一行。d、x、y 必须都是 32 字节；D 的字节数组用完清零
function New-VapidJwk {
    try {
        $ec = [System.Security.Cryptography.ECDsa]::Create($CurveP256)
    } catch {
        Fail '这台电脑的 .NET 不支持 P-256 曲线（要 .NET Framework 4.7 以上）。请在聊天里告诉运维'
    }
    try {
        $p = $ec.ExportParameters($true)
        try {
            foreach ($pair in @(@('d', $p.D), @('x', $p.Q.X), @('y', $p.Q.Y))) {
                $n = if ($null -eq $pair[1]) { 0 } else { $pair[1].Length }
                if ($n -ne 32) { Fail "生成的 $($pair[0]) 不是 32 字节（$n 字节）。什么都没写，请重新运行一次；再失败就在聊天里告诉运维" }
            }
            return '{"kty":"EC","crv":"P-256","d":"' + (To-B64Url $p.D) + '","x":"' + (To-B64Url $p.Q.X) + '","y":"' + (To-B64Url $p.Q.Y) + '"}'
        } finally {
            if ($null -ne $p.D) { [Array]::Clear($p.D, 0, $p.D.Length) }
        }
    } finally {
        $ec.Dispose()
    }
}

# 成对自检：从 JWK 文本里重新解出 d、x、y（和函数侧读到的是同一串），用 d 签、只用 x、y 验。
# 通过就返回公钥（0x04‖x‖y 的 base64url，87 个字符）；不通过就停，什么都没写
$JwkRe = '\A\{"kty":"EC","crv":"P-256","d":"([A-Za-z0-9_-]{43})","x":"([A-Za-z0-9_-]{43})","y":"([A-Za-z0-9_-]{43})"\}\z'
function Test-VapidPair([string]$jwkText) {
    $m = [regex]::Match($jwkText, $JwkRe)
    if (-not $m.Success) { Fail '私钥 JWK 的格式不对（要一行 {"kty":"EC","crv":"P-256","d","x","y"}，三个值各 43 个 base64url 字符）' }
    $script:dB64 = $m.Groups[1].Value
    $d = From-B64Url $script:dB64
    $x = From-B64Url $m.Groups[2].Value
    $y = From-B64Url $m.Groups[3].Value
    $m = $null
    $signer = $null; $verifier = $null; $pp = $null
    try {
        foreach ($pair in @(@('d', $d), @('x', $x), @('y', $y))) {
            if ($pair[1].Length -ne 32) { Fail "成对自检：$($pair[0]) 解出来不是 32 字节（$($pair[1].Length) 字节）" }
        }
        # 签名方：只用 d 和曲线（Q 也照 JWK 给，CNG 要求成套导入；是否成对由下面的验签判断）
        $pt = New-Object System.Security.Cryptography.ECPoint
        $pt.X = $x; $pt.Y = $y
        $pp = New-Object System.Security.Cryptography.ECParameters
        $pp.Curve = $CurveP256; $pp.Q = $pt; $pp.D = $d
        $signer = [System.Security.Cryptography.ECDsa]::Create()
        try { $signer.ImportParameters($pp) } catch { Fail '成对自检：私钥导不进去（d 和 x、y 不成对或不在曲线上）。没有写入任何东西，请重新运行一次；再失败就在聊天里告诉运维' }
        $verifier = New-PublicEc $x $y
        $msg = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($msg) } finally { $rng.Dispose() }
        $sig = $signer.SignData($msg, $Sha256)
        $good = $verifier.VerifyData($msg, $sig, $Sha256)
        $msg[0] = $msg[0] -bxor 1
        $bad = $verifier.VerifyData($msg, $sig, $Sha256)
        if (-not $good -or $bad) { Fail '成对自检没过：用私钥签的消息，用公钥验不过（或改过的消息也验得过）。没有写入任何东西，请重新运行一次；再失败就在聊天里告诉运维' }
        $raw = New-Object byte[] 65
        $raw[0] = 4
        [Array]::Copy($x, 0, $raw, 1, 32)
        [Array]::Copy($y, 0, $raw, 33, 32)
        $pub = To-B64Url $raw
        # 和 D1-7 的 p256dh 同一写法（安全审查 O1-S4）；deploy-preview 的“VAPID 公钥核对”、测试同改
        if ($pub -cnotmatch '\AB[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]\z') { Fail "公钥格式不对（应为 87 个字符，收到 $($pub.Length) 个）" }
        return $pub
    } finally {
        [Array]::Clear($d, 0, $d.Length)
        if ($null -ne $pp -and $null -ne $pp.D) { [Array]::Clear($pp.D, 0, $pp.D.Length) }
        if ($signer) { $signer.Dispose() }
        if ($verifier) { $verifier.Dispose() }
    }
}

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $supaName = 'lemomemo-preview'; $ref = 'yoeqwhygehbaftkppati'; $ghVar = 'PREVIEW_VAPID_PUBLIC_KEY'
} else {
    $label = '正式'; $supaName = 'lemomemo-prod'; $ref = 'uvlnwawwsdfihziaielj'; $ghVar = 'PROD_VAPID_PUBLIC_KEY'
}
$RERUN = 'VAPID_PRIVATE_KEY 可能已换、公钥还没拿到（网页里还是旧公钥，推送会被拒），请立刻重跑本脚本'

$jwk = $null; $dB64 = $null; $sbTok = $null; $sbH = $null; $body = $null; $pub = $null; $after = $null
$sent = $false; $secretDone = $false
try {
    Step "给$label 环境设 VAPID 密钥：先检查"
    Assert-SafeWindow
    # ref 不是密钥，直接写在脚本里（同 set-cron-secret.ps1）；下面会用临时令牌核对项目名，不对就停
    Ok "$label Project ref 已自动填好；VAPID_SUBJECT 用 $Subject"
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
    $had = if ($before -contains 'VAPID_PRIVATE_KEY') { '已有，这次换新（换钥匙：写完改 GitHub 变量、重新部署）' } else { '还没有，这次新建' }
    Ok "现有 $($before.Count) 个 secrets（只看名字）；VAPID_PRIVATE_KEY $had"

    Step '在本机内存里生成 P-256 密钥对，做成对自检（不显示私钥）'
    $jwk = New-VapidJwk
    $pub = Test-VapidPair $jwk
    Ok 'd、x、y 都是 32 字节；私钥签、公钥验通过，改一个字节验不过'

    Step "写入 Supabase：$supaName › Edge Functions › Secrets › VAPID_PRIVATE_KEY、VAPID_PUBLIC_KEY、VAPID_SUBJECT"
    # 三项同一个请求写入：私钥和服务器侧公钥必须同时换（C-9 启动自检逐字节比对）
    $body = ConvertTo-Json -InputObject @(@{ name = 'VAPID_PRIVATE_KEY'; value = $jwk }, @{ name = 'VAPID_PUBLIC_KEY'; value = $pub }, @{ name = 'VAPID_SUBJECT'; value = $Subject }) -Compress
    $sent = $true   # 请求一发出去就当作可能已换（对方可能换了但回包丢了）
    $null = Invoke-Api POST "$api/secrets" $sbH $body -NoDetail
    $body = $null; $jwk = $null; $dB64 = $null
    # 写完再读一次列表：核对名字，顺带判断 value 是明文还是摘要（O1-S3）；响应对象读完就置空（明文时里面有私钥）
    $after = As-List (Invoke-Api GET "$api/secrets" $sbH '')
    $have = @($after | ForEach-Object { [string](Get-Prop $_ 'name') })
    $valueKind = Get-ValueKind $after @{ VAPID_PUBLIC_KEY = $pub; VAPID_SUBJECT = $Subject }
    $after = $null
    foreach ($n in 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT') {
        if ($have -notcontains $n) { Fail "Supabase 上没有 $n" }
    }
    $lost = @($before | Where-Object { $have -notcontains $_ })
    if ($lost.Count) { Fail "写入后原有的 secrets 不见了：$($lost -join '、')。请在聊天里告诉运维" }
    $secretDone = $true
    Ok "已写入 VAPID_PRIVATE_KEY、VAPID_PUBLIC_KEY、VAPID_SUBJECT；原有的 $($before.Count) 个 secrets 都在"
    Ok "接口返回：$valueKind"
    Say '    （列表接口 GET /secrets 的 value 是明文还是摘要；只拿公钥和 VAPID_SUBJECT 两个公开值比过，私钥不参与。把这一行告诉主持人，记进环境清单，安全审查 O1-P1）'

    Step "公钥（公开值，不是密钥；和刚写进 VAPID_PUBLIC_KEY 的是同一串）：填进 GitHub 仓库变量 $ghVar"
    Say ''
    [Console]::WriteLine("      $pub")
    Say ''
    Say "  共 $($pub.Length) 个字符，以 B 开头。GitHub › 仓库 › Settings › Secrets and variables › Actions › Variables："
    Say "  名字 $ghVar，值粘贴上面那一行（不要带前后的空格）。已有就点编辑、换成这一行。"
    Say '  公钥是构建时编进网页的：改完变量要重新部署（步骤文档里写了怎么做），网页才用上新公钥。'
    Say '  私钥不另存（R-282）：丢了就重新运行本脚本换一对。'
    Say ''
    Say "全部写好。在聊天里说「$label 的 VAPID 密钥设好了」，并把上面的公钥填进 GitHub 变量 $ghVar。"
    Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
}
catch {
    # 所有报错打印前都去掉私钥和令牌；写 secrets 的请求已发出、没核对完时，用红字明确告诉负责人要马上重跑
    $msg = Hide-Secrets ([string]$_.Exception.Message)
    if ($sent -and -not $secretDone) {
        $msg = "$RERUN。$msg"
        Write-Host "  ✘ $msg" -ForegroundColor Red
    }
    throw $msg
}
finally {
    $jwk = $null; $dB64 = $null; $sbTok = $null; $sbH = $null; $body = $null; $after = $null
    Clear-Clip
    [GC]::Collect()
    $Error.Clear()   # 自动变量 $Error 里的报错记录可能带着值的片段，一并清掉
    Write-Host '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
