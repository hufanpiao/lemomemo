<#
.SYNOPSIS
  设 pg_cron 调函数用的密钥：值在数据库里生成，写进数据库 Vault（cron_secret、functions_url），再读回写进 Edge Function secret CRON_SECRET
  （架构 0.38 第 46 条、第 6 节「pg_cron 怎么带 CRON_SECRET 调函数」、8.4；R-228 负责人定方案 A）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，AI 不经手明文。

.DESCRIPTION
  pg_cron 任务每次运行时从 vault.decrypted_secrets 读 cron_secret、functions_url，用 net.http_post 调 cron 函数（带 x-cron-secret）；
  函数侧拿 x-cron-secret 和自己的 CRON_SECRET 做常量时间比较。两边必须是同一个值，所以由本脚本一次设好两边。
  本脚本做的事（按顺序，任何一步不过就停）：
    1. 开头检查（和其他密钥脚本同一段、逐字相同，tests/build/keys-guard-sync.test.ts 核对）：Windows 剪贴板历史关着、
       系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略、本窗口没在记 transcript；关掉本窗口的历史记录；
    2. 粘贴一把临时的 Supabase 管理令牌（Read-Host -AsSecureString，屏幕不显示，读完清剪贴板）；
    3. GET /v1/projects/{ref} 核对项目名（预览 lemomemo-preview、正式 lemomemo-prod）和地区（首尔），防止贴错环境；
    4. GET /v1/projects/{ref}/secrets 记下现有 secrets 的名字（只看名字）。这个列表接口的响应里可能带着各 secret 的值或摘要，
       脚本只取 name 字段、不打印响应（第 7 步写完后的核对同样只取名字）；
    5. 经 POST /v1/projects/{ref}/database/query 执行一个 do 块：值在数据库里生成（encode(extensions.gen_random_bytes(32), 'hex')，
       32 字节随机、64 个十六进制字符），写进 Vault 的 cron_secret（不存在 create、已存在 update）；functions_url
       （https://<ref>.supabase.co/functions/v1，不是密钥，按 ref 拼出来）同样写进 Vault。**发出去的 SQL 文本里没有任何密钥值**，
       查询日志、pg_stat_statements 里只会有这段不含值的文字；
    6. 再经同一接口 select 读回 cron_secret（这个 HTTPS 响应里有明文，只在本进程内存里短暂存在）和 functions_url，核对格式；
    7. POST /v1/projects/{ref}/secrets 写成 CRON_SECRET（明文在这个 HTTPS 请求正文里出现一次），马上清掉内存里的变量；
       写完 GET 核对名字在、原有的 secrets 一个没少。
  不用 supabase CLI：`supabase secrets set` 只能把值写在命令行参数里或先写进 env 文件，两样都违反「值不进命令行参数、不落盘」（同 set-fn-role-passwords.ps1）。
  屏幕上只显示「已写入」和名字，任何时候都不打印 CRON_SECRET、令牌；不写任何文件；不用剪贴板放值。
  出错只打印状态码和对方的错误说明；读回值那一次、写 secrets 那一次出错时连对方的说明也不打印（响应里可能带明文）；
  所有报错打印前把值和令牌换成 ***；接口请求不跟随跳转（-MaximumRedirection 0）；结束时清掉 $Error。
  第 5 步发出以后任何一步没完成，都会用红字提示「数据库 Vault 的 cron_secret 已换、函数侧的 CRON_SECRET 还没换好，请立刻重跑本脚本」：
  这时 cron 带新值调函数会被 401 拒掉（不会出安全问题，只是 cron 任务停摆），重跑一次两边一起换即可。
  不另存（R-220）：丢了就重新运行本脚本，两边一起换。

  临时管理令牌（R-220：不另存，用完删）：Supabase › Account › Access Tokens › 新建项目级令牌（Scoped PAT），
  **只选这个项目**（预览 lemomemo-preview 或正式 lemomemo-prod），到期设 1 天，权限只勾下面三项，其余一律不给：
    - Database：Read-write            （在数据库里生成值、写 Vault、读回；Run a query）
    - Edge Function Secrets：Read-write（写入并核对 CRON_SECRET；Bulk create secrets、List all secrets）
    - Project Settings：Read          （核对项目名；Get project）
  权限名和 database/query 接口的用法照 Supabase 官方文档写，**没有在真实的令牌页面和真实项目上核对过**，第一次跑预览时确认。
  这把令牌带 Database 读写，约等于整个数据库的最高权限：跑完马上删，不要等 1 天到期，删令牌在关窗口之前做。
  剩下的风险：仅就我们这一侧而言，值在 database/query 的 HTTPS 响应里出现一次、在 secrets 的 HTTPS 请求里出现一次
  （Supabase 平台侧是否记录请求、响应正文我们控制不了）；
  PowerShell 的字符串没法逐字节清零，值会在本进程内存里短暂存在（用完即置空），最后要关窗口。

.PARAMETER Target
  preview 或 prod。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-cron-secret.ps1" -Target preview
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'prod')][string]$Target,
    # 只给测试用（tests/build/set-cron-secret.test.ts）：把管理接口指向本机假服务。只接受官方地址或 http://127.0.0.1:端口（\A…\z 整串匹配），
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
# 报错打印前，把内存里的 CRON_SECRET 和令牌换成 ***（变量还没建时跳过，StrictMode 下不报错）
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    foreach ($n in 'cron', 'sbTok') {
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
# -NoDetail：只打印状态码，不回显对方的响应正文（读回值、写 secrets 时用：响应里可能带着 CRON_SECRET 明文）。
# -MaximumRedirection 0：不跟随跳转，带着令牌的请求不会被转到别的地址
function Invoke-Api([string]$method, [string]$uri, [hashtable]$headers, [string]$json, [switch]$NoDetail) {
    try {
        if ($json) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0 -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) }
        return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0
    } catch {
        $code = ''; $detail = ''
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($NoDetail) {
            $detail = '（不显示对方的说明：里面可能带着 CRON_SECRET）'
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

# 经 Management API 执行一条 SQL（POST /v1/projects/{ref}/database/query）；返回行的数组
function Invoke-Sql([string]$api, [hashtable]$headers, [string]$sql, [switch]$NoDetail) {
    $json = @{ query = $sql } | ConvertTo-Json -Compress
    return As-List (Invoke-Api POST "$api/database/query" $headers $json -NoDetail:$NoDetail)
}

# 写 Vault 的 do 块：cron_secret 的值在数据库里生成（SQL 文本里没有值）；functions_url 不是密钥，直接写。都是不存在 create、已存在 update
function Get-WriteSql([string]$functionsUrl) {
    if ($functionsUrl -cnotmatch '\Ahttps://[a-z0-9]{20}\.supabase\.co/functions/v1\z') { Fail 'functions_url 格式不对' }
    return @(
        '-- 柠檬记：pg_cron 调函数用的 cron_secret（值在库里生成）、functions_url（tools/keys/set-cron-secret.ps1）',
        'do $lemo$',
        "declare v text := encode(extensions.gen_random_bytes(32), 'hex');",
        'begin',
        "  if exists (select 1 from vault.secrets where name = 'cron_secret') then",
        "    perform vault.update_secret((select id from vault.secrets where name = 'cron_secret'), v);",
        '  else',
        "    perform vault.create_secret(v, 'cron_secret');",
        '  end if;',
        "  if exists (select 1 from vault.secrets where name = 'functions_url') then",
        "    perform vault.update_secret((select id from vault.secrets where name = 'functions_url'), '$functionsUrl');",
        '  else',
        "    perform vault.create_secret('$functionsUrl', 'functions_url');",
        '  end if;',
        'end $lemo$;'
    ) -join "`n"
}
$ReadSql = "select name, decrypted_secret, (select count(*) from vault.secrets s where s.name = d.name) as n from vault.decrypted_secrets d where name in ('cron_secret', 'functions_url') order by name"

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $supaName = 'lemomemo-preview'; $ref = 'yoeqwhygehbaftkppati'
} else {
    $label = '正式'; $supaName = 'lemomemo-prod'; $ref = 'uvlnwawwsdfihziaielj'
}
$functionsUrl = "https://$ref.supabase.co/functions/v1"
$RERUN = '数据库 Vault 的 cron_secret 已换、函数侧的 CRON_SECRET 还没换好（cron 调函数会被 401 拒掉），请立刻重跑本脚本'

$cron = $null; $sbTok = $null; $sbH = $null; $body = $null; $rows = $null
$vaultWritten = $false; $secretDone = $false
try {
    Step "给$label 环境设 CRON_SECRET：先检查"
    Assert-SafeWindow
    # ref 不是密钥，直接写在脚本里（环境清单-v4 记着同样的值）；下面会用临时令牌核对项目名，不对就停
    Ok "$label Project ref 已自动填好"
    $api = "$ApiBase/v1/projects/$ref"

    Step '粘贴临时管理令牌（只用来写这一次）'
    $sbTok = Read-Token "Supabase 令牌（只管 $supaName）" '刚临时生成的项目级令牌：只选这个项目、1 天到期，权限只勾 Database 读写、Edge Function Secrets 读写、Project Settings 只读，用完删掉'
    $sbH = @{ Authorization = "Bearer $sbTok" }

    Step '核对项目（防止贴错环境）'
    $proj = Invoke-Api GET $api $sbH ''
    $projName = Get-Prop $proj 'name'
    if ($projName -ne $supaName) { Fail "这个 Supabase 项目叫「$projName」，不是 $supaName。是不是贴成了另一个环境的令牌？" }
    $region = Get-Prop $proj 'region'
    if ($region -ne 'ap-northeast-2') { Fail "Supabase 项目不在首尔（$region）" }
    Ok "Supabase 项目：$projName（首尔）"

    $before = Get-SecretNames $api $sbH
    $had = if ($before -contains 'CRON_SECRET') { '已有，这次换新' } else { '还没有，这次新建' }
    Ok "现有 $($before.Count) 个 secrets（只看名字）；CRON_SECRET $had"

    Step '在数据库里生成新值，写进 Vault（cron_secret、functions_url）'
    $vaultWritten = $true   # 请求一发出去就当作可能已换（对方可能换了但回包丢了）
    $null = Invoke-Sql $api $sbH (Get-WriteSql $functionsUrl)
    Ok '已写进 Vault（值在数据库里生成，发出去的 SQL 里没有值）'

    Step '读回 cron_secret（不显示）'
    $rows = Invoke-Sql $api $sbH $ReadSql -NoDetail
    $byName = @{}
    foreach ($r in $rows) { $byName[[string](Get-Prop $r 'name')] = $r }
    # 先把值放进 $cron（Hide-Secrets 的替换名单），再做后面的核对：核对出错时报错里即使带出值也会被换成 ***
    if ($byName.ContainsKey('cron_secret')) { $cron = [string](Get-Prop $byName['cron_secret'] 'decrypted_secret') }
    foreach ($n in 'cron_secret', 'functions_url') {
        if (-not $byName.ContainsKey($n)) { Fail "Vault 里没有 $n" }
        if ([string](Get-Prop $byName[$n] 'n') -ne '1') { Fail "Vault 里 $n 不止一条（$(Get-Prop $byName[$n] 'n') 条）。请在聊天里告诉运维" }
    }
    if ([string](Get-Prop $byName['functions_url'] 'decrypted_secret') -ne $functionsUrl) { Fail 'Vault 里的 functions_url 和本项目对不上' }
    $byName = $null; $rows = $null
    if ($cron -cnotmatch '\A[0-9a-f]{64}\z') {   # -c：区分大小写（PowerShell 的 -match 默认不分）
        $len = $cron.Length
        $cron = $null
        Fail "读回的 cron_secret 格式不对（应为 64 个十六进制字符，收到 $len 个字符）"
    }
    Ok '已读回（64 个十六进制字符，只在内存里）'

    Step "写入 Supabase：$supaName › Edge Functions › Secrets › CRON_SECRET"
    $body = ConvertTo-Json -InputObject @(@{ name = 'CRON_SECRET'; value = $cron }) -Compress
    $null = Invoke-Api POST "$api/secrets" $sbH $body -NoDetail
    $body = $null; $cron = $null
    $have = Get-SecretNames $api $sbH
    if ($have -notcontains 'CRON_SECRET') { Fail 'Supabase 上没有 CRON_SECRET' }
    $lost = @($before | Where-Object { $have -notcontains $_ })
    if ($lost.Count) { Fail "写入后原有的 secrets 不见了：$($lost -join '、')。请在聊天里告诉运维" }
    $secretDone = $true
    Ok "已写入 CRON_SECRET；原有的 $($before.Count) 个 secrets 都在"

    Say ''
    Say "全部写好。在聊天里说「$label 的 CRON_SECRET 设好了」。"
    Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
}
catch {
    # 所有报错打印前都去掉值和令牌；Vault 已换、函数侧没换好时，用红字明确告诉负责人要马上重跑
    $msg = Hide-Secrets ([string]$_.Exception.Message)
    if ($vaultWritten -and -not $secretDone) {
        $msg = "$RERUN。$msg"
        Write-Host "  ✘ $msg" -ForegroundColor Red
    }
    throw $msg
}
finally {
    $cron = $null; $sbTok = $null; $sbH = $null; $body = $null; $rows = $null; $byName = $null
    Clear-Clip
    [GC]::Collect()
    $Error.Clear()   # 自动变量 $Error 里的报错记录可能带着值的片段（例如对方回显的正文），一并清掉
    Write-Host '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
