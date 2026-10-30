<#
.SYNOPSIS
  用测试账号登录预览环境，拿到的访问令牌只留在本脚本的内存里，由脚本自己逐项跑那些「要登录令牌才能测」的检查：
  由产品负责人本人在自己电脑的 PowerShell 窗口里运行，不经过 Claude（AI 不看、不经手明文令牌）。

.DESCRIPTION
  覆盖的清单项（屏幕上每项只打印「通过 / 不符合 / 跳过」和状态码、错误码）：
    P2（authenticated 一半）  docs/03-评审/B0/后端-B0实测清单.md P2：用登录令牌经 REST 读 private 的每张表、调每个 private 函数，
                               一律 42501 或 404；只有迁移里 grant 给 authenticated 的（白名单）放行。表和函数的名单在运行时从
                               supabase/migrations/*.sql 读出来（不手抄）。白名单里 5 个函数（purge_deleted_impl、record_consent_impl、
                               files_authorize_impl、report_tz_impl、remove_device_impl）经 POST 带「一定报错、什么都不改」的参数调；其余函数一律经
                               GET /rpc/（PostgREST 放在只读事务里跑，写不了任何东西）带按类型填的占位参数调，不传 null（null 会盖掉参数默认值）。
                               白名单函数回 404 PGRST202：触发器函数（迁移里 returns trigger，PostgREST 不暴露）算正常；其他判不符合
                               （预览缺迁移或没部署），列出函数名。
    S1                         S1 安全复审必改（TC-B1-111 真库那一半）：登录后只报访问令牌 payload 里 amr 的形状（是不是数组、每项的 method 名），
                               用登录令牌调 private.is_active（GET，只读）应为 true；用刷新令牌换一次新令牌，再核一遍。不打印令牌本身。
                               is_active 为 false 时提示测试账号可能没有 profile 行，打印补行的 SQL（带预览库检查、可重复执行），不等待、照常往下。
    R2-9                       docs/09-路线图/B0-R2任务单.md 第五节第 9 项：经 preview.lemomemo.com/files 上传一张 1×1 的 webp、
                               签 view 链接、取回来逐字节相同；不带签名、改过的签名都被拒；同一路径再传一次 409（不覆盖）。
    R2-6                       第 6 项：/files 的 GET 响应 cf-cache-status 必须是 DYNAMIC 或 BYPASS（webp 取两次，pptx 取一次）。
    R2-2                       第 2 项：10 MB（10485760 字节）附件经 /files 上传成功，R2 回的 etag 等于内容的 MD5（整份写进去了）。
    R2-3                       第 3 项：微软查看器能读 /files 的 ms 链接。要负责人给一个本机 .pptx（内容不敏感）；file-check 还没有，
                               中途要负责人在 SQL Editor 把这一行手动标成已检查（脚本会打印那一句 SQL）；脚本打开浏览器，负责人看了回答 y / n；
                               可选再测「链接只剩 60 秒时打开」（要等约 4 分钟），作为「最短稳定时长」的参考。
    TC-B1-112                  docs/06-测试/测试用例-v4.md TC-B1-112 ②③（B1 接手清单 S2）：**这是测防线，不是真设密码**——
                               用登录令牌 PUT /auth/v1/user 设一个只在内存里的随机密码（直连 supabase.co、经 preview.lemomemo.com/sb 各一次），
                               然后用这个密码 grant_type=password 登录，应 400 invalid_credentials（库里的触发器 guard_no_password 把密码置空了）；
                               再请负责人在 SQL Editor 查带密码的行数应为 0。顺带记录设密码后本会话还在不在（安全第四轮 L3）。
    P8（可选，要 -P8Function） 实测清单 P8：调一个只调 requireActiveUser 的测试函数，中间由负责人在 SQL Editor 依次做「停用 / 注销冷静期 /
                               查会话变慢 / 吊销会话」并恢复，依次应为 200、403 account_disabled、403 account_pending_deletion（带 purge_after）、
                               503 try_later、401 session_revoked。预览上还没有这个测试函数时整项记「跳过」。

  登录方式（架构 15.6、5.6「已有用户登录」）：邮箱验证码。脚本调 GoTrue /auth/v1/otp 发码（create_user = false），负责人在邮箱里看到 6 位
  验证码后粘贴进 Read-Host -AsSecureString（屏幕不显示），脚本调 /auth/v1/verify 换会话。Supabase 开了人机验证（CAPTCHA）时脚本发不了码，
  会提示改在 Supabase 控制台 › Authentication › Users › 这个邮箱 › Send magic link 发码（邮件里同样有 6 位验证码），后面照常。
  令牌（access_token、refresh_token）、验证码、测试用的随机密码只在本进程内存里：不打印、不写文件、不进命令行参数；报错打印前一律换成 ***；
  脚本结束时调 /auth/v1/logout 让这次的会话作废，再清变量、清剪贴板。所有接口请求都不跟随跳转（-MaximumRedirection 0）。

  要用到的公开值（都不是密钥）：预览项目 ref yoeqwhygehbaftkppati（环境清单-v4）、预览站 https://preview.lemomemo.com、
  publishable key（sb_publishable_…，前端本来就公开）：脚本先从预览站的页面脚本里自动找，找不到再请负责人从
  Supabase › Project Settings › API Keys 复制粘贴；版本号读仓库根目录 VERSION（上传要带 X-App-Version）。
  测试数据：在测试账号下建 1 条随手记、1 张图、1～2 个附件，测完把这些行标成已删除（进「最近删除」；中途出错时在 finally 里补做）；
  预览 R2 桶里会留下这几个测试对象（客户端没有删除接口），路径（用户 id 写成 <测试账号>）列在结果摘要里，
  B4 手动清理（B1 接手清单已登记）。
  改库的 SQL（P8 各步和恢复、TC-B1-112 清空密码、R2-3 标已检查）开头都带一段检查：库里必须有这个测试账号、而且只有测试账号
  （邮箱含 +lemotest@ 或以 @lemomemo.test 结尾），否则 raise exception、整段不执行——误贴进正式库（有真实用户、没有测试账号）会直接报错。
  P8 改到一半出错或脚本中途停下时，会醒目打印还没恢复的那几步的恢复 SQL，等负责人执行并确认。
  只能用 powershell -File 运行（点源或粘贴进窗口运行会被拒绝：变量会留在窗口里）。
  环境变量 LEMO_TEST_API 只给自动测试用（让脚本接受指向 127.0.0.1 的假服务、放过 -File 检查）：不要在本机长期设着，
  正式运行前确认没设（PowerShell 里 $env:LEMO_TEST_API 应为空）。
  开头会先请负责人在 SQL Editor 单独执行一遍预览库检查；报错就停（预览库里有非测试账号，先找主持人），
  免得到了要清空密码、要恢复 P8 的时候才发现检查段执行不了。

  负责人的步骤：
    1. 新开一个 PowerShell 窗口（不用退出 Claude，R-223）；
    2. 运行下面的命令（预览测试账号默认 hufanp+lemotest@gmail.com，换账号加 -Email）；
    3. 去邮箱看验证码，粘贴到脚本里；中途按提示在 Supabase SQL Editor 执行脚本打印的 SQL、回答 y / n；
    4. 最后把「结果摘要」那一段整段复制给主持人（里面没有令牌、密码、验证码），然后关掉这个窗口。

.PARAMETER Email
  测试账号邮箱（预览项目里已有、能收信）。

.PARAMETER PptxPath
  第 3 项用的本机 .pptx 文件；不给就在运行中询问，直接回车则跳过第 3 项。

.PARAMETER P8Function
  预览上只调 requireActiveUser 的测试函数名（小写字母、数字、-）；不给则 P8 记「跳过」。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\login-token-tests.ps1"
#>
[CmdletBinding()]
param(
    [ValidatePattern('\A[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}\z')][string]$Email = 'hufanp+lemotest@gmail.com',
    [string]$PptxPath = '',
    [ValidatePattern('\A([a-z0-9-]{1,40})?\z')][string]$P8Function = '',
    # 以下只给测试用（tests/build/login-token-tests-run.test.ts）：把接口指向本机假服务。只接受官方地址或 http://127.0.0.1:端口（\A…\z 整串匹配），
    # 本机地址还要另设环境变量 LEMO_TEST_API=1 才生效；令牌不会被发到别的主机
    [Parameter(DontShow = $true)][ValidatePattern('\A(https://yoeqwhygehbaftkppati\.supabase\.co|http://127\.0\.0\.1:\d{1,5})\z')][string]$SupabaseBase = 'https://yoeqwhygehbaftkppati.supabase.co',
    [Parameter(DontShow = $true)][ValidatePattern('\A(https://preview\.lemomemo\.com|http://127\.0\.0\.1:\d{1,5})\z')][string]$SiteBase = 'https://preview.lemomemo.com',
    [Parameter(DontShow = $true)][ValidateRange(1, 299)][int]$MsRemainSeconds = 60,
    # 只给测试用：访问令牌用了多少秒就先换新的（正式运行 420 秒；测试传 0，每次请求前都换，走一遍刷新路径）
    [Parameter(DontShow = $true)][ValidateRange(0, 540)][int]$RefreshAfterSeconds = 420
)

# 只许用 -File 运行：点源（. 脚本）或把内容粘贴进窗口跑，脚本里的变量（令牌）会留在窗口的会话里
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
$cmdArgs = $null

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptVersion = '1'
if (($SupabaseBase -ne 'https://yoeqwhygehbaftkppati.supabase.co' -or $SiteBase -ne 'https://preview.lemomemo.com') -and $env:LEMO_TEST_API -ne '1') {
    throw '已停止：-SupabaseBase、-SiteBase 只给测试用，正式运行不要带这两个参数'
}

if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { }
}

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ✘ $msg" -ForegroundColor Yellow }

# 内存里的秘密（访问令牌、刷新令牌、验证码、测试密码）：报错和结果打印前一律换成 ***
$script:secretVals = New-Object System.Collections.Generic.List[string]
function Add-Secret([string]$v) { if ($v -and $v.Length -ge 6) { $script:secretVals.Add($v) } }
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    $list = Get-Variable -Name secretVals -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if ($null -eq $list) { return $s }
    foreach ($v in @($list)) {
        if (-not $v) { continue }
        # 纯数字（验证码）只换整词：免得把状态码、计数里碰巧相同的数字串换掉
        if ($v -match '\A\d+\z') { $s = [regex]::Replace($s, '(?<!\d)' + $v + '(?!\d)', '***') }
        else { $s = $s.Replace($v, '***') }
    }
    return $s
}
function Fail([string]$msg) { throw "已停止：$(Hide-Secrets $msg)" }

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

# ───────────────────────── 小工具 ─────────────────────────

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# StrictMode 下读不存在的属性会报错：缺字段时返回 $null
function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj -or $obj -isnot [psobject] -or $obj -is [array]) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

function J($o) { return (ConvertTo-Json -InputObject $o -Compress -Depth 6) }
function New-Id { return [guid]::NewGuid().ToString('D').ToLowerInvariant() }
function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Now-S { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function Hex([byte[]]$b) { return (($b | ForEach-Object { $_.ToString('x2') }) -join '') }
function Sha256Hex([byte[]]$b) { $h = [Security.Cryptography.SHA256]::Create(); try { return Hex $h.ComputeHash($b) } finally { $h.Dispose() } }
function Md5Hex([byte[]]$b) { $h = [Security.Cryptography.MD5]::Create(); try { return Hex $h.ComputeHash($b) } finally { $h.Dispose() } }
function Same-Bytes([byte[]]$a, [byte[]]$b) {
    if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length) { return $false }
    return (Sha256Hex $a) -eq (Sha256Hex $b)
}

# 测试用的随机密码：24 字节随机 → base64url，再补大小写、数字、符号各一个（不管托管版有没有密码强度要求都能提交）
function New-ProbePassword {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $s = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') + 'Aa1!'
    [Array]::Clear($bytes, 0, $bytes.Length)
    return $s
}

function Decode-JwtPayload([string]$jwt) {
    $parts = $jwt.Split('.')
    if ($parts.Count -ne 3) { return $null }
    $s = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
    try { return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) | ConvertFrom-Json) } catch { return $null }
}

# 发一个请求，不论成功失败都交回 {Status, Headers, Bytes, Text, Json, Code, Reason}；不跟随跳转。
# 不在这里打印任何东西：调用处只打印状态码和错误码（Code：GoTrue 的 error_code、PostgREST 和 /files 的 code、函数的 error）
function Invoke-Http([string]$method, [string]$uri, [hashtable]$headers, $body, [string]$contentType) {
    if ($null -eq $headers) { $headers = @{} }
    $p = @{ Method = $method; Uri = $uri; Headers = $headers; TimeoutSec = 300; ErrorAction = 'Stop' }
    if ($null -ne $body) {
        if ($body -is [string]) {
            $p.Body = [Text.Encoding]::UTF8.GetBytes($body)
            if (-not $contentType) { $contentType = 'application/json; charset=utf-8' }
        } else {
            $p.Body = [byte[]]$body
        }
    }
    if ($contentType) { $p.ContentType = $contentType }
    if ($PSVersionTable.PSVersion.Major -ge 7) { $p.SkipHttpErrorCheck = $true }
    $status = 0; $hdr = @{}; $bytes = [byte[]]@(); $text = ''
    try {
        $r = Invoke-WebRequest @p -MaximumRedirection 0 -UseBasicParsing
        $status = [int]$r.StatusCode
        foreach ($k in @($r.Headers.Keys)) { $hdr[[string]$k] = (@($r.Headers[$k]) -join ', ') }
        if ($null -ne $r.RawContentStream) { $bytes = $r.RawContentStream.ToArray() }
        $text = [Text.Encoding]::UTF8.GetString($bytes)
    } catch {
        $err = $_
        $resp = $null
        try { $resp = $err.Exception.Response } catch { }
        if ($null -ne $resp) {
            try { $status = [int]$resp.StatusCode } catch { }
            try { foreach ($k in @($resp.Headers.AllKeys)) { $hdr[[string]$k] = [string]$resp.Headers[$k] } } catch { }
        }
        try { if ($null -ne $err.ErrorDetails) { $text = [string]$err.ErrorDetails.Message } } catch { }
        # PS 5.1 下 ErrorDetails 大多是空的：改从响应流读错误体（UTF-8，读完就关；读不到就保持为空，不抛出）。
        # 这里不打印：错误体只用来解析错误码，打印处（Rec、Warn）照样先过 Hide-Secrets
        if (-not $text -and $null -ne $resp) {
            $rs = $null; $sr = $null
            try {
                $rs = $resp.GetResponseStream()
                if ($null -ne $rs) {
                    try { if ($rs.CanSeek) { $rs.Position = 0 } } catch { }
                    $sr = New-Object System.IO.StreamReader($rs, [Text.Encoding]::UTF8)
                    $text = [string]$sr.ReadToEnd()
                }
            } catch { $text = '' }
            finally {
                if ($null -ne $sr) { try { $sr.Dispose() } catch { } }
                if ($null -ne $rs) { try { $rs.Dispose() } catch { } }
            }
        }
    }
    $json = $null
    if ($text) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
    $code = ''
    foreach ($k in 'error_code', 'code', 'error') {
        $v = Get-Prop $json $k
        if ($null -ne $v -and "$v" -ne '' -and ($v -is [string] -or $v -is [int] -or $v -is [long])) { $code = [string]$v; break }
    }
    $reason = [string](Get-Prop $json 'reason')
    return [pscustomobject]@{ Status = $status; Headers = $hdr; Bytes = $bytes; Text = $text; Json = $json; Code = $code; Reason = $reason }
}

function Hdr($resp, [string]$name) {
    foreach ($k in @($resp.Headers.Keys)) { if ([string]::Equals([string]$k, $name, [StringComparison]::OrdinalIgnoreCase)) { return [string]$resp.Headers[$k] } }
    return ''
}

# 一个响应的简短描述：HTTP 状态码 + 错误码（+ /files 的 reason）；状态码 0 表示没连上
function D($resp) {
    if ($resp.Status -eq 0) { return '没连上（HTTP 0）' }
    $s = "HTTP $($resp.Status)"
    if ($resp.Code) { $s += " $($resp.Code)" }
    if ($resp.Reason) { $s += "/$($resp.Reason)" }
    return $s
}

# ───────────────────────── 结果记录 ─────────────────────────
$script:results = New-Object System.Collections.ArrayList
function Rec([string]$id, [string]$state, [string]$what, [string]$detail) {
    $detail = Hide-Secrets $detail
    [void]$script:results.Add([pscustomobject]@{ Id = $id; State = $state; What = $what; Detail = $detail })
    $line = "  [$state] $id $what$(if ($detail) { '：' + $detail })"
    $color = switch ($state) { '通过' { 'Green' } '不符合' { 'Red' } default { 'Yellow' } }
    Write-Host $line -ForegroundColor $color
}

function Ask-YesNo([string]$q) {
    for ($i = 1; $i -le 3; $i++) {
        $a = ([string](Read-Host "  $q（输入 y 或 n 后回车）")).Trim().ToLowerInvariant()
        if (@('y', 'yes', '是') -contains $a) { return $true }
        if (@('n', 'no', '否') -contains $a) { return $false }
        Warn '只认 y 或 n'
    }
    Fail '连续 3 次没有回答 y 或 n，已停止'
}

function Show-Sql([string]$why, [string[]]$sql) {
    Say ''
    Say "  请打开 Supabase › lemomemo-preview › SQL Editor，执行下面的 SQL（$why）："
    Say '  （整段全选执行：粘贴后按 Ctrl+A 全选再运行，不要只选中一部分；开头的检查段要和后面一起执行才有用）'
    foreach ($l in $sql) { Write-Host "      $l" -ForegroundColor White }
}
function Wait-Sql([string]$why, [string[]]$sql) {
    Show-Sql $why $sql
    $null = Read-Host '  执行完后按回车继续'
}

# 改库 SQL 的开头：只有预览库能过。判断：库里有这个测试账号，而且所有账号都是测试账号（+lemotest@ 或 @lemomemo.test）。
# 正式库有真实用户、没有测试账号，贴进去会 raise、整段（SQL Editor 一次执行的是一个事务）都不生效
function Guard-Sql {
    return @(
        'do $guard$ begin',
        "  if not exists (select 1 from auth.users where email = '$Email')",
        "     or exists (select 1 from auth.users where email not like '%+lemotest@%' and email not like '%@lemomemo.test') then",
        "    raise exception 'lemo: 不是预览库（或库里有非测试账号），整段已拒绝执行';",
        '  end if;',
        'end $guard$;')
}

# ─────────── P8 改过、还没恢复的地方（出错或中途停下时打印恢复 SQL） ───────────
$script:p8Dirty = [ordered]@{ pending = $false; disabled = $false; slow = $false }
$script:p8Orig = $null
function P8-Who { return "(select id from auth.users where email = '$Email')" }
function P8-RestoreSql([string]$which) {
    $who = P8-Who
    switch ($which) {
        'pending' { return @("delete from private.pending_deletions where user_id = $who;", "update public.profiles set disabled_at = null, disabled_reason = null where user_id = $who;") }
        'disabled' { return @("select private.admin_set_disabled($who, false);") }
        'slow' { return @($script:p8Orig -split "`r?`n") }
    }
}
function Restore-P8([string]$why) {
    $todo = @($script:p8Dirty.Keys | Where-Object { $script:p8Dirty[$_] })
    if ($todo.Count -eq 0) { return }
    $names = @{ pending = '注销冷静期'; disabled = '停用'; slow = 'session_alive 改慢' }
    $sql = @(Guard-Sql)
    foreach ($k in $todo) { $sql += P8-RestoreSql $k }
    Write-Host ''
    Write-Host "  ！！！ P8 改过的库还没恢复（$why）：$(($todo | ForEach-Object { $names[$_] }) -join '、') ！！！" -ForegroundColor Red
    Wait-Sql '恢复 P8 改过的地方，必须执行' $sql
    $ok = Ask-YesNo '上面的恢复 SQL 执行成功了吗'
    foreach ($k in $todo) { $script:p8Dirty[$k] = $false }
    $list = ($todo | ForEach-Object { $names[$_] }) -join '、'
    if ($ok) { Rec 'P8-恢复' '通过' '恢复 P8 改过的库' "已恢复：$list" }
    else { Rec 'P8-恢复' '不符合' '恢复 P8 改过的库' "负责人回答没执行成功：$list。请马上在聊天里告诉后端" }
}

# ─────────── 测试行（标成已删除）和留在桶里的对象 ───────────
$script:made = @{ notes = @(); note_images = @(); note_files = @() }
$script:leftover = New-Object System.Collections.ArrayList
$script:cleaned = $false
function Add-Leftover([string]$bucket, [string]$path) { [void]$script:leftover.Add("$bucket/" + $path.Replace($script:uid, '<测试账号>')) }
function Cleanup-TestRows {
    if ($script:cleaned -or $script:made.notes.Count -eq 0 -or -not $script:acc) { return }
    $script:cleaned = $true
    $nowMs = Now-Ms; $cleanBad = @()
    foreach ($id in $script:made.note_images) { $r = Invoke-Http PATCH "$SupabaseBase/rest/v1/note_images?id=eq.$id" ((User-Headers) + @{ Prefer = 'return=minimal' }) (J @{ deleted_at = $nowMs }) ''; if ($r.Status -ne 204) { $cleanBad += "图片 $(D $r)" } }
    foreach ($id in $script:made.note_files) { $r = Invoke-Http PATCH "$SupabaseBase/rest/v1/note_files?id=eq.$id" ((User-Headers) + @{ Prefer = 'return=minimal' }) (J @{ deleted_at = $nowMs; updated_at = $nowMs }) ''; if ($r.Status -ne 204) { $cleanBad += "附件 $(D $r)" } }
    foreach ($id in $script:made.notes) { $r = Invoke-Http PATCH "$SupabaseBase/rest/v1/notes?id=eq.$id" ((User-Headers) + @{ Prefer = 'return=minimal' }) (J @{ deleted_at = $nowMs; updated_at = $nowMs }) ''; if ($r.Status -ne 204) { $cleanBad += "随手记 $(D $r)" } }
    if ($cleanBad.Count) { Warn "测试行没全部标成已删除：$($cleanBad -join '；')（不影响结果，可在 App 里手动删）" }
    else { Ok "测试用的随手记、图片、附件行已标成已删除；预览 R2 桶里留了 $($script:leftover.Count) 个测试对象（路径见结果摘要，B4 手动清）" }
}

# ───────────────────────── 登录和令牌 ─────────────────────────
$script:acc = $null; $script:rtok = $null; $script:tokAt = $null; $script:uid = $null; $script:pk = $null

function Base-Headers { return @{ apikey = $script:pk } }

function Set-Session($json) {
    $a = [string](Get-Prop $json 'access_token')
    $r = [string](Get-Prop $json 'refresh_token')
    if (-not $a -or -not $r) { Fail '登录接口的返回里没有 access_token / refresh_token' }
    $script:acc = $a; $script:rtok = $r; $script:tokAt = Get-Date
    Add-Secret $a; Add-Secret $r
}

# 访问令牌 600 秒过期（jwt_expiry）：用了 7 分钟就先换一把
function Refresh-Now {
    $r = Invoke-Http POST "$SupabaseBase/auth/v1/token?grant_type=refresh_token" (Base-Headers) (J @{ refresh_token = $script:rtok })
    if ($r.Status -ne 200) { Fail "换新令牌失败（$(D $r)）" }
    Set-Session $r.Json
}
function Ensure-Fresh {
    if ($null -eq $script:tokAt -or ((Get-Date) - $script:tokAt).TotalSeconds -lt $RefreshAfterSeconds) { return }
    Refresh-Now
    if ($RefreshAfterSeconds -ge 60) { Say '  （访问令牌快到 10 分钟了，已用刷新令牌换了一把新的）' }
}

# S1：只报 amr 的形状（是不是数组、每项的 method 名），并用这把令牌调 private.is_active（GET，只读事务）
function Probe-Amr {
    $c = Decode-JwtPayload $script:acc
    $amr = $null
    if ($null -ne $c -and $c.PSObject.Properties['amr']) { $amr = $c.PSObject.Properties['amr'].Value }
    $isArr = $amr -is [array]
    $methods = @()
    $strItems = @()
    if ($isArr) {
        foreach ($x in $amr) {
            # 两种形状：{method, timestamp} 对象，或裸字符串（GoTrue 有的版本这样发）；裸字符串单独报，照样核对有没有 password
            if ($x -is [string]) { $m = $x; $isStr = $true } else { $m = [string](Get-Prop $x 'method'); $isStr = $false }
            if ($m -notmatch '\A[a-z_]{1,32}\z') { $m = '（不是普通名字）' }
            $methods += $m
            if ($isStr) { $strItems += $m }
        }
    }
    $shape = if ($null -eq $amr) { '没有 amr' } elseif ($isArr) { "数组 $($methods.Count) 项，method：$(if ($methods.Count) { $methods -join '、' } else { '无' })$(if ($strItems.Count) { '（其中字符串项：' + ($strItems -join '、') + '）' })" } else { "不是数组（$($amr.GetType().Name)）" }
    $h = User-Headers; $h['Accept-Profile'] = 'private'
    $r = Invoke-Http GET "$SupabaseBase/rest/v1/rpc/is_active" $h $null ''
    # 写明 is_active 实际返回了什么：true、false，或者错误码
    $body = ([string]$r.Text).Trim()
    $active = $r.Status -eq 200 -and $body -eq 'true'
    $inactive = $r.Status -eq 200 -and $body -eq 'false'
    $desc = if ($active) { 'is_active = true' }
        elseif ($inactive) { 'is_active = false' }
        elseif ($r.Status -eq 200) { "is_active 返回的不是 true/false（$(if ($body.Length -gt 40) { $body.Substring(0, 40) + '…' } else { $body })）" }
        else { "is_active 调用出错（$(D $r)）" }
    $c = $null; $amr = $null; $h = $null
    return [pscustomobject]@{ Shape = $shape; IsArray = $isArr; Methods = $methods; Active = $active; Inactive = $inactive; ActiveDesc = $desc }
}

function User-Headers {
    Ensure-Fresh
    return @{ apikey = $script:pk; Authorization = "Bearer $($script:acc)" }
}
function Files-Headers {
    Ensure-Fresh
    return @{ Authorization = "Bearer $($script:acc)" }
}

function Find-PublishableKey {
    $page = Invoke-Http GET "$SiteBase/app/" @{} $null ''
    if ($page.Status -ne 200) { return $null }
    $srcs = @([regex]::Matches($page.Text, '(?:src|href)="(/app/assets/[A-Za-z0-9._-]+\.js)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique | Select-Object -First 12)
    foreach ($s in $srcs) {
        $js = Invoke-Http GET "$SiteBase$s" @{} $null ''
        if ($js.Status -ne 200) { continue }
        $m = [regex]::Match($js.Text, 'sb_publishable_[A-Za-z0-9_-]{20,}')
        if ($m.Success) { return $m.Value }
    }
    return $null
}

# ───────────────────────── 主流程 ─────────────────────────
$noteId = $null; $made = $script:made
$version = $null; $viaMagic = $false; $viaLink = $false
$v = $null; $h = $null; $set = $null; $login = $null; $claims = $null
try {
    Step '登录令牌测试（预览 lemomemo-preview）：先检查这个窗口'
    Assert-SafeWindow

    Step '先确认 SQL Editor 连的是预览库、库里只有测试账号'
    Wait-Sql '只是检查，不改任何东西；后面清空密码、恢复 P8 的兜底都靠这一段' @(Guard-Sql)
    if (-not (Ask-YesNo '执行结果是成功、没有报错（Success. No rows returned）吗')) {
        Fail '预览库里有非测试账号（或者 SQL Editor 连的不是预览库），先找主持人；没有跑任何测试'
    }
    Ok '预览库检查能通过'

    $verFile = Join-Path $PSScriptRoot '..\..\VERSION'
    $version = ([IO.File]::ReadAllText($verFile)).Trim()
    if ($version -notmatch '\A\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?\z') { Fail 'VERSION 文件的格式不对' }
    $migDir = Join-Path $PSScriptRoot '..\..\supabase\migrations'
    $sqlText = (@(Get-ChildItem -Path $migDir -Filter '*.sql' | Sort-Object Name | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n")
    Ok "版本 $version；读了 supabase/migrations 里的迁移（用来列 private 的表和函数）"

    Step '取 publishable key（公开值）'
    $script:pk = Find-PublishableKey
    if ($script:pk) {
        Ok '从预览站的页面脚本里找到了 publishable key'
    } else {
        Say '  预览站页面里没找到。请到 Supabase › lemomemo-preview › Project Settings › API Keys，复制 Publishable key（sb_publishable_ 开头，是公开值）'
        for ($i = 1; $i -le 3 -and -not $script:pk; $i++) {
            $v = ([string](Read-Host '  粘贴到这里')).Trim()
            if ($v -match '\A(sb_publishable_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\z') { $script:pk = $v } else { Warn "格式不对（收到 $($v.Length) 个字符），要 sb_publishable_ 开头" }
        }
        if (-not $script:pk) { Fail '没拿到 publishable key' }
        Ok '已收到 publishable key'
    }

    Step "登录测试账号 $Email（邮箱验证码）"
    $send = Invoke-Http POST "$SupabaseBase/auth/v1/otp" (Base-Headers) (J @{ email = $Email; create_user = $false })
    if ($send.Status -eq 429) {
        Warn "发码太频繁（$(D $send)）：同一邮箱 60 秒内只能发一次"
        $null = Read-Host '  等 60 秒后按回车重发'
        $send = Invoke-Http POST "$SupabaseBase/auth/v1/otp" (Base-Headers) (J @{ email = $Email; create_user = $false })
    }
    if ($send.Status -eq 200) {
        Ok '验证码已发出，请去邮箱查收（10 分钟内有效）'
    } elseif ($send.Code -match '(?i)captcha' -or $send.Text -match '(?i)captcha') {
        Warn "Supabase 开了人机验证，脚本发不了码（$(D $send)）"
        Say '  请到 Supabase › lemomemo-preview › Authentication › Users，找到这个邮箱 › 右边「…」› Send magic link；邮件里同样有 6 位验证码'
        $null = Read-Host '  发完后按回车继续'
        $viaMagic = $true
    } else {
        Fail "发验证码失败（$(D $send)）。账号不在预览项目里时是 422 otp_disabled / signup_disabled"
    }
    for ($try = 1; $try -le 3 -and -not $script:acc; $try++) {
        # 默认邮件模板（没配自定义 SMTP 改不了）只有登录链接、没有 6 位码：也收链接，取出 token（哈希）换会话；链接不要点开，点开就用掉了
        $sec = Read-Host -AsSecureString '  粘贴邮件里的 6 位验证码；邮件里只有登录链接时，右键链接“复制链接地址”粘贴（别点开链接）。屏幕上不显示，粘贴后回车'
        Clear-Clip
        $otp = (To-Plain $sec) -replace '\s', ''
        $sec.Dispose()
        $hash = $null
        if ($otp -notmatch '\A\d{6,10}\z') {
            Add-Secret $otp
            $u = $otp -replace '&amp;', '&'
            Add-Secret $u
            # 每解一次都登记：解到一半的链接也不许出现在屏幕上
            for ($k = 0; $k -lt 3; $k++) { $u = [uri]::UnescapeDataString($u); Add-Secret $u }
            if ($u -match '[?&]token=([A-Za-z0-9_-]{20,})') { $hash = $Matches[1] }
            $Matches = $null
            $u = $null
            if ($hash) {
                # 链接里的 token 带 pkce_ 前缀；verify 收的 token_hash 不带（和 GoTrue 一致）。两种形态都登记
                Add-Secret $hash
                $hash = $hash -replace '\Apkce_', ''
                Add-Secret $hash
                if ($hash.Length -lt 20) { $hash = $null }
            }
            if (-not $hash) { Warn "应是 6 位数字或登录链接（收到 $($otp.Length) 个字符）"; $otp = $null; continue }
        }
        Add-Secret $otp
        if ($hash) {
            Add-Secret $hash
            $v = Invoke-Http POST "$SupabaseBase/auth/v1/verify" (Base-Headers) (J @{ type = 'email'; token_hash = $hash })
            if ($v.Status -ne 200) { $v = Invoke-Http POST "$SupabaseBase/auth/v1/verify" (Base-Headers) (J @{ type = 'magiclink'; token_hash = $hash }) }
            $hash = $null
            if ($v.Status -eq 200) { $viaLink = $true }
        } else {
            $v = Invoke-Http POST "$SupabaseBase/auth/v1/verify" (Base-Headers) (J @{ type = 'email'; email = $Email; token = $otp })
        }
        $otp = $null
        if ($v.Status -eq 200) { Set-Session $v.Json } else { Warn "验证码或登录链接没通过（$(D $v)）" }
    }
    if (-not $script:acc) { Fail '验证码或登录链接连续 3 次没通过，已停止（没有拿到令牌）' }
    $claims = Decode-JwtPayload $script:acc
    $script:uid = [string](Get-Prop $claims 'sub')
    if ($script:uid -notmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z') { Fail '令牌里的用户 id 格式不对' }
    if (-not [string](Get-Prop $claims 'session_id')) { Fail '令牌里没有 session_id（files_authorize、requireActiveUser 都靠它），请在聊天里告诉后端' }
    $claims = $null
    Ok '已登录（令牌只在本脚本内存里，不显示）'

    # ─────────── S1：amr 的形状（TC-B1-111 真库那一半） ───────────
    Step 'S1：访问令牌里 amr 的形状（只报形状，不打印令牌）'
    try {
        $a1 = Probe-Amr
        Refresh-Now
        $a2 = Probe-Amr
        $how = if ($viaMagic) { '控制台 magic link 发的码' } else { '脚本发的 otp' }
        if ($viaLink) { $how += '，用邮件里的登录链接（token_hash）换的会话' }
        $detail = "登录（$how）：$($a1.Shape)，$($a1.ActiveDesc)；刷新一次后：$($a2.Shape)，$($a2.ActiveDesc)；$(if ($viaMagic) { '脚本发 otp 那条路未测' } elseif ($viaLink) { '6 位码那条路未测（默认邮件模板里没有码）' } else { 'magiclink 未测' })"
        $okS1 = $a1.IsArray -and $a2.IsArray -and $a1.Active -and $a2.Active -and $a1.Methods.Count -gt 0 -and $a2.Methods.Count -gt 0 -and
            ($a1.Methods -notcontains 'password') -and ($a2.Methods -notcontains 'password')
        $noProfile = $a1.Inactive -or $a2.Inactive
        if ($noProfile) { $detail += '。is_active 返回 false：测试账号可能没有 public.profiles 行（修复 SQL 打印在 S1 这一行的下面）' }
        if ($okS1) { Rec 'S1' '通过' 'amr 形状' $detail } else { Rec 'S1' '不符合' 'amr 形状' $detail }
        if ($noProfile) {
            # 控制台邀请建的账号没经过 invite-signup，就没有 profile 行；按 invite-signup 的写法补（user_id、ui_locale），可重复执行。脚本不改库、不等待
            Write-Host ''
            Write-Host '  ！！！ is_active 返回 false：测试账号可能没有 public.profiles 行（控制台邀请建的账号没经过 invite-signup）！！！' -ForegroundColor Red
            Show-Sql '补测试账号的 profile 行；可以重复执行，已有就不插。脚本不等这一步，照常往下跑；执行后重跑本脚本再核 S1' (@(Guard-Sql) + @(
                    "insert into public.profiles (user_id, ui_locale)",
                    "select u.id, 'zh-CN' from auth.users u",
                    "where u.email = '$Email'",
                    "  and not exists (select 1 from public.profiles p where p.user_id = u.id);"))
            # 另一种可能：profile 行在，但已经被停用。只读诊断，不改任何东西、不需要预览库检查段
            Say '  另一种可能：profile 行在，但已经被停用。可以另外单独执行下面这条只读查询看看（不改任何东西）：'
            Write-Host "      select disabled_at, disabled_reason from public.profiles p join auth.users u on u.id = p.user_id where u.email = '$Email';" -ForegroundColor White
        }
    } catch { Rec 'S1' '不符合' 'amr 形状' "中途出错：$($_.Exception.Message)" }

    # ─────────── P2：authenticated 读 private ───────────
    Step 'P2（authenticated 一半）：用登录令牌读 private 的每张表、调每个函数'
    try {
        $tables = @([regex]::Matches($sqlText, '(?im)^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?private\.([a-z_][a-z0-9_]*)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        $fnArgs = [ordered]@{}
        foreach ($m in [regex]::Matches($sqlText, '(?is)create\s+(?:or\s+replace\s+)?function\s+private\.([a-z_][a-z0-9_]*)\s*\(([^)]*)\)')) { $fnArgs[$m.Groups[1].Value] = $m.Groups[2].Value }
        $white = @([regex]::Matches($sqlText, '(?im)^\s*grant\s+execute\s+on\s+function\s+private\.([a-z_][a-z0-9_]*)\s*\([^)]*\)\s+to\s+([^;]+);') | Where-Object { $_.Groups[2].Value -match '(?i)\bauthenticated\b' } | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        if ($tables.Count -lt 1 -or $fnArgs.Count -lt 1) { Fail '没从迁移里读出 private 的表或函数' }
        # 触发器函数（迁移里 returns trigger）：PostgREST 不暴露，回 404 PGRST202 是正常的
        $trigFns = @([regex]::Matches($sqlText, '(?is)create\s+(?:or\s+replace\s+)?function\s+private\.([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*returns\s+trigger\b') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        $white404Trig = @(); $white404Missing = @()
        # 白名单里会改数据的函数：用「一定报错或什么都不改」的参数调
        $nilId = '00000000-0000-0000-0000-000000000000'
        $safeArgs = @{
            purge_deleted_impl   = @{ p_items = @() }                                         # 空数组：一行也不删
            record_consent_impl  = @{ p_ver = 'lemo-probe-not-a-version'; p_revoke = $false }  # 版本对不上就报错
            files_authorize_impl = @{ p_op = 'probe'; p_items = $null }                       # bad_op，限流计数之前就报错
            report_tz_impl       = @{ p_tz = 'Lemo/Not_A_Zone'; p_device = $nilId; p_platform = 'web' }   # bad_tz，写任何东西之前就报错
            remove_device_impl   = @{ p_device = $nilId }                                     # 没有这台设备：device_not_found，什么都不删
        }
        # GET /rpc/ 的占位参数：按类型给一个不会命中任何行的值（不传 null，免得盖掉参数默认值）
        $placeholder = {
            param([string]$type)
            $t = $type.ToLowerInvariant()
            if ($t.EndsWith('[]')) { return '{}' }
            if ($t -eq 'uuid') { return $nilId }
            if ($t -in 'jsonb', 'json') { return '[]' }
            if ($t -in 'boolean', 'bool') { return 'false' }
            if ($t -in 'int', 'integer', 'int4', 'bigint', 'int8', 'smallint', 'int2', 'numeric', 'real', 'double') { return '0' }
            if ($t -in 'timestamptz', 'timestamp', 'date') { return '1970-01-01T00:00:00Z' }
            return 'lemo-probe'
        }
        $bad = @(); $tCodes = @{}
        foreach ($t in $tables) {
            $h = User-Headers; $h['Accept-Profile'] = 'private'
            $r = Invoke-Http GET "$SupabaseBase/rest/v1/$($t)?select=*&limit=1" $h $null ''
            $okT = ($r.Code -eq '42501' -and @(401, 403) -contains $r.Status) -or ($r.Status -eq 404 -and $r.Code -like 'PGRST*')
            $tCodes[(D $r)] = 1 + [int]$tCodes[(D $r)]
            if (-not $okT) { $bad += "表 $t $(D $r)" }
        }
        $nWhite = 0; $nOther = 0; $fCodes = @{}; $wCodes = @{}
        foreach ($name in @($fnArgs.Keys)) {
            if ($safeArgs.ContainsKey($name)) {
                $h = User-Headers; $h['Content-Profile'] = 'private'
                $r = Invoke-Http POST "$SupabaseBase/rest/v1/rpc/$name" $h (J $safeArgs[$name]) ''
            } else {
                $qs = @()
                foreach ($a in ($fnArgs[$name] -split ',')) {
                    $tok = @(($a.Trim() -split '\s+') | Where-Object { $_ })
                    if ($tok.Count -ge 2 -and @('in', 'out', 'inout', 'variadic') -contains $tok[0].ToLowerInvariant()) { $tok = @($tok[1..($tok.Count - 1)]) }
                    if ($tok.Count -ge 2) { $qs += "$($tok[0])=$([Uri]::EscapeDataString((& $placeholder $tok[1])))" }
                }
                $h = User-Headers; $h['Accept-Profile'] = 'private'
                $r = Invoke-Http GET "$SupabaseBase/rest/v1/rpc/$($name)$(if ($qs.Count) { '?' + ($qs -join '&') })" $h $null ''
            }
            if ($white -contains $name) {
                $nWhite++
                $wCodes[(D $r)] = 1 + [int]$wCodes[(D $r)]
                if ($r.Code -eq '42501' -or $r.Status -eq 0) { $bad += "白名单函数 $name 被拒 $(D $r)" }
                elseif ($r.Status -eq 404 -and $r.Code -eq 'PGRST202') {
                    if ($trigFns -contains $name) { $white404Trig += $name } else { $white404Missing += $name }
                }
            } else {
                $nOther++
                $fCodes[(D $r)] = 1 + [int]$fCodes[(D $r)]
                $okF = ($r.Code -eq '42501' -and @(401, 403) -contains $r.Status) -or ($r.Status -eq 404 -and $r.Code -eq 'PGRST202')
                if (-not $okF) { $bad += "函数 $name $(D $r)" }
            }
        }
        $fmt = { param($h) (@($h.Keys | Sort-Object | ForEach-Object { "$_ ×$($h[$_])" }) -join '，') }
        if ($white404Missing.Count) { $bad += "白名单函数回 404 PGRST202（预览缺迁移或没部署）：$($white404Missing -join '、')" }
        $detail = "private $($tables.Count) 张表（$(& $fmt $tCodes)）；白名单外函数 $nOther 个（$(& $fmt $fCodes)）；白名单函数 $nWhite 个（$(& $fmt $wCodes)）"
        if ($white404Trig.Count) { $detail += "；白名单里的触发器函数回 404（PostgREST 不暴露，正常）：$($white404Trig -join '、')" }
        if ($bad.Count) { Rec 'P2' '不符合' 'authenticated 读 private' "$detail。不符合的：$($bad -join '；')" }
        else { Rec 'P2' '通过' 'authenticated 读 private' $detail }
    } catch { Rec 'P2' '不符合' 'authenticated 读 private' "中途出错：$($_.Exception.Message)" }

    # ─────────── 建一条随手记（R2 各项共用） ───────────
    Step 'R2 第 9、6 项：经 /files 上传图片、签名、取回'
    $nowMs = Now-Ms
    $noteId = New-Id
    $r = Invoke-Http POST "$SupabaseBase/rest/v1/notes" ((User-Headers) + @{ Prefer = 'return=minimal' }) (J @{ id = $noteId; title = 'login-token-tests 自动建的测试随手记（可删）'; body = ''; created_at = $nowMs; updated_at = $nowMs }) ''
    if ($r.Status -ne 201) { $noteId = $null; Rec 'R2-9' '不符合' '建测试随手记' (D $r) }
    else { $made.notes += $noteId }

    $cacheSeen = @()
    if ($noteId) {
        try {
            # 1×1 的 webp（RIFF????WEBP 开头，VP8L 无损）
            $webp = [Convert]::FromBase64String('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==')
            $imgId = New-Id
            $imgPath = "$($script:uid)/$noteId/$imgId.webp"
            $r = Invoke-Http POST "$SupabaseBase/rest/v1/note_images" ((User-Headers) + @{ Prefer = 'return=minimal' }) (J @{ id = $imgId; note_id = $noteId; bucket = 'images'; path = $imgPath; bytes = $webp.Length; mime = 'image/webp'; width = 1; height = 1 }) ''
            if ($r.Status -ne 201) { throw "建图片行失败（$(D $r)）" }
            $made.note_images += $imgId
            $put = Invoke-Http PUT "$SiteBase/files/v1/o/images/$imgPath" ((Files-Headers) + @{ 'X-App-Version' = $version }) $webp 'image/webp'
            if ($put.Status -ne 200) { throw "上传失败（$(D $put)）" }
            Add-Leftover 'images' $imgPath
            $sign = Invoke-Http POST "$SiteBase/files/v1/sign" (Files-Headers) (J @{ items = @(@{ bucket = 'images'; path = $imgPath; purpose = 'view' }) }) ''
            $it = @(Get-Prop $sign.Json 'items')
            $item = if ($it.Count -ge 1) { $it[0] } else { $null }
            if ($sign.Status -ne 200 -or (Get-Prop $item 'ok') -ne $true) { throw "签名失败（$(D $sign)，单项 $([string](Get-Prop $item 'reason'))）" }
            $url = [string](Get-Prop $item 'url'); $sig = [string](Get-Prop $item 'sig')
            if ($url -ne "$SiteBase/files/v1/o/images/$imgPath" -or -not $sig) { throw '签名返回的链接不是本站 /files/v1/o/images/<路径>，或没有 sig' }
            $g1 = Invoke-Http GET $url @{ 'X-Files-Sig' = $sig } $null ''
            $g2 = Invoke-Http GET $url @{ 'X-Files-Sig' = $sig } $null ''
            $noSig = Invoke-Http GET $url @{} $null ''
            $badSig = Invoke-Http GET $url @{ 'X-Files-Sig' = ($sig -replace '.$', $(if ($sig.EndsWith('A')) { 'B' } else { 'A' })) } $null ''
            $again = Invoke-Http PUT "$SiteBase/files/v1/o/images/$imgPath" ((Files-Headers) + @{ 'X-App-Version' = $version }) $webp 'image/webp'
            $ct = Hdr $g1 'Content-Type'
            $okGet = $g1.Status -eq 200 -and (Same-Bytes $g1.Bytes $webp) -and $ct -like 'image/webp*'
            $detail = "上传 $(D $put)；签名 $(D $sign)；带签名取回 $(D $g1)（$(if (Same-Bytes $g1.Bytes $webp) { '逐字节相同' } else { '内容不同' })，$ct）；不带签名 $(D $noSig)；改过的签名 $(D $badSig)；同一路径再传 $(D $again)"
            if ($okGet -and $noSig.Status -eq 403 -and $badSig.Status -eq 403 -and $again.Status -eq 409) { Rec 'R2-9' '通过' '上传、签名、取回（显示）' $detail }
            else { Rec 'R2-9' '不符合' '上传、签名、取回（显示）' $detail }
            $cacheSeen += [pscustomobject]@{ What = 'webp 第 1 次'; Val = (Hdr $g1 'cf-cache-status') }
            $cacheSeen += [pscustomobject]@{ What = 'webp 第 2 次'; Val = (Hdr $g2 'cf-cache-status') }
        } catch { Rec 'R2-9' '不符合' '上传、签名、取回（显示）' "中途出错：$($_.Exception.Message)" }
    }

    # ─────────── R2 第 2 项：10 MB 附件 ───────────
    Step 'R2 第 2 项：10 MB 附件经 /files 上传'
    if (-not $noteId) { Rec 'R2-2' '跳过' '10 MB 附件上传' '测试随手记没建成' }
    else {
        try {
            $size = 10485760
            $big = New-Object byte[] $size
            $rng = [Random]::new(20261029)
            $rng.NextBytes($big)
            $head = [Text.Encoding]::ASCII.GetBytes("%PDF-1.4`n% lemo 10MB probe`n")
            [Array]::Copy($head, $big, $head.Length)
            $fid = New-Id
            $fpath = "$($script:uid)/$noteId/$fid.pdf"
            $nowMs = Now-Ms
            $r = Invoke-Http POST "$SupabaseBase/rest/v1/note_files" ((User-Headers) + @{ Prefer = 'return=minimal' }) (J @{ id = $fid; note_id = $noteId; kind = 'pdf'; path = $fpath; name = 'lemo-10mb-probe.pdf'; mime = 'application/pdf'; bytes = $size; sha256 = (Sha256Hex $big); created_at = $nowMs; updated_at = $nowMs }) ''
            if ($r.Status -ne 201) { throw "建附件行失败（$(D $r)）" }
            $made.note_files += $fid
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $put = Invoke-Http PUT "$SiteBase/files/v1/o/files/$fpath" ((Files-Headers) + @{ 'X-App-Version' = $version }) $big 'application/pdf'
            $sw.Stop()
            $etag = ([string](Get-Prop $put.Json 'etag')).Trim('"')
            if (-not $etag) { $etag = (Hdr $put 'ETag').Trim('"') }
            $md5 = Md5Hex $big
            $big = $null
            $detail = "$(D $put)，用时 $([math]::Round($sw.Elapsed.TotalSeconds, 1)) 秒，etag $(if ($etag -eq $md5) { '等于内容 MD5' } elseif ($etag) { '不等于内容 MD5' } else { '没有' })"
            if ($put.Status -eq 200) { Add-Leftover 'files' $fpath }
            if ($put.Status -eq 200 -and $etag -eq $md5) { Rec 'R2-2' '通过' '10 MB 附件上传' $detail } else { Rec 'R2-2' '不符合' '10 MB 附件上传' $detail }
        } catch { Rec 'R2-2' '不符合' '10 MB 附件上传' "中途出错：$($_.Exception.Message)" }
    }

    # ─────────── R2 第 3 项：微软查看器 ───────────
    Step 'R2 第 3 项：微软查看器读 /files 的 ms 链接'
    if (-not $noteId) { Rec 'R2-3' '跳过' '微软查看器' '测试随手记没建成' }
    else {
        if (-not $PptxPath) {
            Say '  要一个本机 .pptx 文件（内容不敏感，会传到预览桶里；10 MB 以内）。'
            $PptxPath = ([string](Read-Host '  输入它的完整路径（直接回车 = 跳过第 3 项）')).Trim().Trim([char]34, [char]39)
        }
        if (-not $PptxPath) { Rec 'R2-3' '跳过' '微软查看器' '没给 .pptx 文件' }
        elseif (-not (Test-Path -LiteralPath $PptxPath -PathType Leaf) -or [IO.Path]::GetExtension($PptxPath).ToLowerInvariant() -ne '.pptx') { Rec 'R2-3' '跳过' '微软查看器' '给的路径不是一个 .pptx 文件' }
        else {
            try {
                $ppt = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $PptxPath).ProviderPath)
                if ($ppt.Length -lt 1 -or $ppt.Length -gt 10485760) { throw '.pptx 不能是空的，也不能超过 10 MB' }
                $pid2 = New-Id
                $ppath = "$($script:uid)/$noteId/$pid2.pptx"
                $pmime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                $nowMs = Now-Ms
                $r = Invoke-Http POST "$SupabaseBase/rest/v1/note_files" ((User-Headers) + @{ Prefer = 'return=minimal' }) (J @{ id = $pid2; note_id = $noteId; kind = 'pptx'; path = $ppath; name = 'lemo-ms-probe.pptx'; mime = $pmime; bytes = $ppt.Length; sha256 = (Sha256Hex $ppt); created_at = $nowMs; updated_at = $nowMs }) ''
                if ($r.Status -ne 201) { throw "建附件行失败（$(D $r)）" }
                $made.note_files += $pid2
                $put = Invoke-Http PUT "$SiteBase/files/v1/o/files/$ppath" ((Files-Headers) + @{ 'X-App-Version' = $version }) $ppt $pmime
                if ($put.Status -ne 200) { throw "上传失败（$(D $put)）" }
                Add-Leftover 'files' $ppath
                $pre = Invoke-Http POST "$SiteBase/files/v1/sign" (Files-Headers) (J @{ items = @(@{ bucket = 'files'; path = $ppath; purpose = 'ms' }) }) ''
                $preItem = @(Get-Prop $pre.Json 'items')
                $preReason = if ($preItem.Count) { [string](Get-Prop $preItem[0] 'reason') } else { '' }
                Wait-Sql 'file-check 还没有，把这份测试 PPT 手动标成「已检查」；只改这一行' (@(Guard-Sql) + @("update public.note_files set check_status = 'ok' where id = '$pid2' and check_status = 'pending';"))
                $signMs = {
                    $s = Invoke-Http POST "$SiteBase/files/v1/sign" (Files-Headers) (J @{ items = @(@{ bucket = 'files'; path = $ppath; purpose = 'ms' }) }) ''
                    $its = @(Get-Prop $s.Json 'items')
                    $one = if ($its.Count -ge 1) { $its[0] } else { $null }
                    if ($s.Status -ne 200 -or (Get-Prop $one 'ok') -ne $true) { throw "签 ms 链接失败（$(D $s)，单项 $([string](Get-Prop $one 'reason'))；SQL 执行了吗？）" }
                    $u = [string](Get-Prop $one 'url')
                    if (-not $u.StartsWith("$SiteBase/files/v1/o/files/${ppath}?")) { throw 'ms 链接不是本站 /files/v1/o/files/<路径>?…' }
                    return [pscustomobject]@{ Url = $u; E = [long](Get-Prop $one 'e') }
                }
                $ms = & $signMs
                $g = Invoke-Http GET $ms.Url @{} $null ''
                $cacheSeen += [pscustomobject]@{ What = 'pptx'; Val = (Hdr $g 'cf-cache-status') }
                if ($g.Status -ne 200 -or -not (Same-Bytes $g.Bytes $ppt)) { throw "脚本自己用 ms 链接取回失败（$(D $g)）" }
                Say '  马上用浏览器打开微软查看器（链接 5 分钟后失效；它会留在浏览器历史里，指向的是这份测试 PPT）'
                Start-Process ('https://view.officeapps.live.com/op/view.aspx?src=' + [Uri]::EscapeDataString($ms.Url))
                $shown = Ask-YesNo '浏览器里微软查看器显示出这份 PPT 了吗'
                $detail = "签名前未检查时 $(D $pre)/$preReason；脚本取回 $(D $g) 逐字节相同；立刻打开：$(if ($shown) { '能显示' } else { '不能显示' })"
                if ($shown -and (Ask-YesNo "再测「链接只剩 $MsRemainSeconds 秒时打开」吗（要等约 $([math]::Max(0, 300 - $MsRemainSeconds)) 秒）")) {
                    $ms2 = & $signMs
                    $wait = $ms2.E - (Now-S) - $MsRemainSeconds
                    while ($wait -gt 0) {
                        Write-Host "    还要等 $wait 秒…" -ForegroundColor DarkGray
                        Start-Sleep -Seconds ([math]::Min(30, $wait))
                        $wait = $ms2.E - (Now-S) - $MsRemainSeconds
                    }
                    Start-Process ('https://view.officeapps.live.com/op/view.aspx?src=' + [Uri]::EscapeDataString($ms2.Url))
                    $shown2 = Ask-YesNo "这次（链接只剩约 $MsRemainSeconds 秒）还能显示吗"
                    $detail += "；剩 $MsRemainSeconds 秒时打开：$(if ($shown2) { '能显示' } else { '不能显示' })"
                }
                if ($shown -and $preReason -eq 'not_checked') { Rec 'R2-3' '通过' '微软查看器' $detail } else { Rec 'R2-3' '不符合' '微软查看器' $detail }
            } catch { Rec 'R2-3' '不符合' '微软查看器' "中途出错：$($_.Exception.Message)" }
        }
    }

    # ─────────── R2 第 6 项：cf-cache-status ───────────
    if ($cacheSeen.Count -eq 0) { Rec 'R2-6' '跳过' 'cf-cache-status' '前面没有成功取回过对象' }
    else {
        $list = ($cacheSeen | ForEach-Object { "$($_.What) $(if ($_.Val) { $_.Val } else { '（没有这个头）' })" }) -join '；'
        $allOk = @($cacheSeen | Where-Object { @('DYNAMIC', 'BYPASS') -notcontains ([string]$_.Val).ToUpperInvariant() }).Count -eq 0
        if ($allOk) { Rec 'R2-6' '通过' 'cf-cache-status 是 DYNAMIC 或 BYPASS' $list } else { Rec 'R2-6' '不符合' 'cf-cache-status 是 DYNAMIC 或 BYPASS' $list }
    }

    # ─────────── 收拾测试行（标成已删除；中途出错时 finally 里补做） ───────────
    # 放在 TC-B1-112、P8 之前：P8 会吊销本会话，之后就改不了了
    Cleanup-TestRows

    # ─────────── TC-B1-112：设密码无效（测防线） ───────────
    Step 'TC-B1-112：设密码无效（这是测防线，不是真设密码）'
    try {
        $parts = @()
        $allOk = $true
        $blocked = $false
        $needClear = @()
        foreach ($via in @(@{ Name = '直连 supabase.co'; Base = $SupabaseBase }, @{ Name = '经 /sb'; Base = "$SiteBase/sb" })) {
            $pw = New-ProbePassword
            Add-Secret $pw
            $set = Invoke-Http PUT "$($via.Base)/auth/v1/user" (User-Headers) (J @{ password = $pw }) ''
            $login = Invoke-Http POST "$($via.Base)/auth/v1/token?grant_type=password" (Base-Headers) (J @{ email = $Email; password = $pw })
            $pw = $null
            $setOk = $set.Status -ge 200 -and $set.Status -lt 300
            $parts += "$($via.Name)：设密码 $(D $set)，密码登录 $(D $login)"
            $leak = [string](Get-Prop $login.Json 'access_token')
            if ($leak) {
                Add-Secret $leak
                $allOk = $false
                # 万一真用密码登进去了：马上让那个会话作废
                $null = Invoke-Http POST "$SupabaseBase/auth/v1/logout?scope=local" @{ apikey = $script:pk; Authorization = "Bearer $leak" } '{}' ''
                $parts += "$($via.Name) 密码登录拿到了令牌（已立即退出那个会话）"
                $needClear += "$($via.Name) 用密码登录拿到了令牌"
                $leak = $null
            } elseif ($login.Status -eq 429 -or $login.Code -match '(?i)captcha') {
                $blocked = $true
                if ($setOk) { $needClear += "$($via.Name) 设密码成功，但密码登录被 $(if ($login.Status -eq 429) { '429 限流' } else { '人机验证' }) 挡住，看不出密码是不是真的空" }
            } elseif (-not ($login.Status -eq 400 -and @('invalid_credentials', 'invalid_grant') -contains $login.Code)) {
                $allOk = $false
            }
        }
        $set = $null; $login = $null
        $me = Invoke-Http GET "$SupabaseBase/auth/v1/user" (User-Headers) $null ''
        $parts += "设密码后本会话 $(if ($me.Status -eq 200) { '还在' } else { '已失效 ' + (D $me) })"
        $countSql = @("select count(*) as with_password from auth.users where coalesce(encrypted_password, '') <> '';")
        Wait-Sql '核对库里没有带密码的账号' $countSql
        $zero = Ask-YesNo '结果 with_password 是 0 吗'
        $parts += "库里带密码的行：$(if ($zero) { '0' } else { '不是 0' })"
        if (-not $zero) { $allOk = $false; $needClear += 'with_password 不是 0' }
        if ($needClear.Count) {
            Write-Host ''
            Write-Host '  ！！！ 测试账号可能真的有了密码，必须马上清空 ！！！' -ForegroundColor Red
            Write-Host "  原因：$($needClear -join '；')" -ForegroundColor Red
            Wait-Sql '清空测试账号的密码，必须执行' (@(Guard-Sql) + @("update auth.users set encrypted_password = '' where email = '$Email';"))
            Wait-Sql '复查：带密码的行应为 0' $countSql
            $zero2 = Ask-YesNo '复查结果 with_password 是 0 吗'
            $parts += "已打印清空密码的 SQL（原因：$($needClear -join '；')），复查 with_password：$(if ($zero2) { '0' } else { '仍不是 0' })"
            if (-not $zero2) { $allOk = $false }
        }
        if (-not $allOk) { Rec 'TC-B1-112' '不符合' '设密码无效' ($parts -join '；') }
        elseif ($blocked) { Rec 'TC-B1-112' '跳过' '设密码无效' (($parts -join '；') + '；密码登录被 429 或人机验证挡在前面，判断不了 invalid_credentials（库里为 0 那一半已查）') }
        else { Rec 'TC-B1-112' '通过' '设密码无效' ($parts -join '；') }
    } catch { Rec 'TC-B1-112' '不符合' '设密码无效' "中途出错：$($_.Exception.Message)" }

    # ─────────── P8：requireActiveUser 的真实路径（可选） ───────────
    Step 'P8：requireActiveUser 的真实路径'
    if (-not $P8Function) { Rec 'P8' '跳过' 'requireActiveUser 真实路径' '没给 -P8Function：预览上要先部署一个只调 requireActiveUser 的测试函数' }
    else {
        try {
            $call = { Invoke-Http POST "$SupabaseBase/functions/v1/$P8Function" (User-Headers) '{}' '' }
            $who = P8-Who
            $g = @(Guard-Sql)
            $steps = @()
            $okAll = $true
            $c1 = & $call
            if ($c1.Status -eq 404 -and -not $c1.Code) { Rec 'P8' '跳过' 'requireActiveUser 真实路径' "预览上没有函数 $P8Function（$(D $c1)）" }
            else {
                $steps += "正常 $(D $c1)"; if ($c1.Status -ne 200) { $okAll = $false }

                # 标记在打印 SQL 之前就立起来：负责人可能已经执行了，之后哪一步出错都要恢复
                $script:p8Dirty.disabled = $true
                Wait-Sql '停用测试账号' ($g + @("select private.admin_set_disabled($who, true);"))
                $c = & $call; $steps += "停用后 $(D $c)"; if (-not ($c.Status -eq 403 -and $c.Code -eq 'account_disabled')) { $okAll = $false }
                Wait-Sql '解除停用' ($g + (P8-RestoreSql 'disabled'))
                $script:p8Dirty.disabled = $false

                $script:p8Dirty.pending = $true
                Wait-Sql '让测试账号进入注销冷静期' ($g + @(
                    "insert into private.pending_deletions (user_id, purge_after) values ($who, now() + interval '7 days');",
                    "update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = $who;"))
                $c = & $call; $pa = [string](Get-Prop $c.Json 'purge_after')
                $steps += "冷静期 $(D $c)$(if ($pa) { '（带 purge_after）' } else { '（没有 purge_after）' })"
                if (-not ($c.Status -eq 403 -and $c.Code -eq 'account_pending_deletion' -and $pa)) { $okAll = $false }
                Wait-Sql '撤销冷静期' ($g + (P8-RestoreSql 'pending'))
                $script:p8Dirty.pending = $false

                # 查会话临时变慢 3 秒（超过 requireActiveUser 的 2 秒超时）：函数体照迁移原文，只在开头加 pg_sleep；测完用原文恢复
                $defs = @([regex]::Matches($sqlText, '(?is)create\s+(?:or\s+replace\s+)?function\s+private\.session_alive\(.*?\$\$\s*;'))
                if ($defs.Count -eq 0) { $steps += '变慢一步：迁移里没找到 session_alive 的定义，没测'; $okAll = $false }
                else {
                    $script:p8Orig = [regex]::Replace($defs[$defs.Count - 1].Value, '(?is)\Acreate\s+(?:or\s+replace\s+)?function', 'create or replace function')
                    $slow = ([regex]'(?s)(as\s+\$\$\s*select\s+)').Replace($script:p8Orig, '$1(select true from pg_sleep(3)) and ', 1)
                    $script:p8Dirty.slow = $true
                    Wait-Sql '让查会话临时变慢 3 秒（测完马上恢复）' ($g + @($slow -split "`r?`n"))
                    $c = & $call; $steps += "查会话变慢 $(D $c)"; if (-not ($c.Status -eq 503 -and $c.Code -eq 'try_later')) { $okAll = $false }
                    Wait-Sql '恢复查会话（照迁移原文）' ($g + (P8-RestoreSql 'slow'))
                    $script:p8Dirty.slow = $false
                    $c = & $call; $steps += "恢复后 $(D $c)"; if ($c.Status -ne 200) { $okAll = $false }
                }

                Wait-Sql '吊销测试账号最新的会话（就是本脚本这一个）' ($g + @(
                    "insert into private.revoked_sessions (session_id, user_id) select s.id, s.user_id from auth.sessions s where s.user_id = $who order by s.created_at desc limit 1;"))
                $c = & $call; $steps += "吊销后 $(D $c)"; if (-not ($c.Status -eq 401 -and $c.Code -eq 'session_revoked')) { $okAll = $false }
                Say '  （吊销记录留着无妨，这个会话脚本结束时会退出；要清可以整段执行下面的 SQL，不清也行）'
                foreach ($l in ($g + @("delete from private.revoked_sessions where user_id = $who;"))) { Write-Host "      $l" -ForegroundColor White }
                if ($okAll) { Rec 'P8' '通过' 'requireActiveUser 真实路径' ($steps -join '；') } else { Rec 'P8' '不符合' 'requireActiveUser 真实路径' ($steps -join '；') }
            }
        } catch {
            Rec 'P8' '不符合' 'requireActiveUser 真实路径' "中途出错：$($_.Exception.Message)"
            Restore-P8 'P8 中途出错'
        }
    }
}
catch {
    $msg = Hide-Secrets ([string]$_.Exception.Message)
    Write-Host "  ✘ $msg" -ForegroundColor Red
    Rec '脚本' '不符合' '没有跑完' $msg
}
finally {
    # P8 改过还没恢复的（脚本中途停下、恢复那一步本身出错）：先打印恢复 SQL 再等确认；等不到也已经打印在屏幕上了
    try { Restore-P8 '脚本中途停下' } catch { Write-Host "  ✘ 上面打印的 P8 恢复 SQL 还没确认执行，请务必执行：$(Hide-Secrets ([string]$_.Exception.Message))" -ForegroundColor Red }
    # 中途出错时补做：测试行标成已删除
    try { Cleanup-TestRows } catch { Warn '补做「测试行标成已删除」没成功（不影响结果，可在 App 里手动删）' }
    # 让这次的会话作废（令牌就算留在内存里也没用了）
    $logoutNote = ''
    if ($script:acc) {
        $lo = $null
        try { $lo = Invoke-Http POST "$SupabaseBase/auth/v1/logout?scope=local" @{ apikey = $script:pk; Authorization = "Bearer $($script:acc)" } '{}' '' } catch { }
        if ($null -eq $lo -or $lo.Status -lt 200 -or $lo.Status -ge 300) {
            $logoutNote = "注意：这次的登录会话没有成功退出（$(if ($null -eq $lo) { '可能按了 Ctrl+C 中途停下' } else { D $lo })），访问令牌最多 10 分钟后自动过期；要马上作废，到 Supabase › Authentication › Users › 这个邮箱 › Sign out user"
            Write-Host "  ✘ $logoutNote" -ForegroundColor Yellow
        }
        $lo = $null
    }
    $script:acc = $null; $script:rtok = $null; $otp = $null; $pw = $null; $leak = $null
    $hash = $null; $u = $null; $sec = $null; $Matches = $null
    $v = $null; $h = $null; $set = $null; $login = $null; $claims = $null
    Clear-Clip

    # 结果摘要：只有状态、状态码、错误码，没有令牌、密码、验证码、用户 id
    $n = @{ '通过' = 0; '不符合' = 0; '跳过' = 0 }
    foreach ($x in $script:results) { $n[$x.State] = 1 + [int]$n[$x.State] }
    Write-Host ''
    Write-Host '==== 结果摘要（不含令牌、密码、验证码，可整段复制给主持人）====' -ForegroundColor Cyan
    $lines = @("login-token-tests.ps1 第 $ScriptVersion 版；预览 lemomemo-preview；$(Get-Date -Format 'yyyy-MM-dd HH:mm')（本机时间）；版本 $version")
    foreach ($x in $script:results) { $lines += "[$($x.State)] $($x.Id) $($x.What)$(if ($x.Detail) { '：' + $x.Detail })" }
    $lines += "合计：通过 $($n['通过'])，不符合 $($n['不符合'])，跳过 $($n['跳过'])"
    if ($logoutNote) { $lines += $logoutNote }
    if ($script:leftover.Count) { $lines += "预览 R2 桶里留下的测试对象（$($script:leftover.Count) 个，B4 手动清）：$($script:leftover -join '；')" }
    foreach ($l in $lines) { Write-Host (Hide-Secrets $l) }
    Write-Host '==== 摘要结束 ====' -ForegroundColor Cyan
    $script:secretVals = $null
    $Error.Clear()
    [GC]::Collect()
    Write-Host '已退出这次的登录会话、清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
