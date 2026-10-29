<#
.SYNOPSIS
  给 fn_vault、fn_ai 两个低权限数据库角色设登录密码，并写成 Edge Function secrets FN_VAULT_DB_URL、FN_AI_DB_URL
  （架构 6.2、8.4；0.23 安全复核 A4：迁移只建 nologin 角色、不带密码）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，不经过 Claude。

.DESCRIPTION
  两个角色由迁移 supabase/migrations/0001_core.sql 开头建好（nologin noinherit）。本脚本做的事（按顺序，任何一步不过就停）：
    1. 开头检查（和 new-proxy-secret.ps1、set-r2-tokens.ps1、publish.ps1 同一段、逐字相同，tests/build/keys-guard-sync.test.ts 核对）：
       没有 Claude 在运行（进程名 claude*，以及命令行带 claude-code / @anthropic-ai 的 node.exe）、Windows 剪贴板历史关着、
       系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略、本窗口没在记 transcript；关掉本窗口的历史记录；
    2. 粘贴一把临时的 Supabase 管理令牌（Read-Host -AsSecureString，屏幕不显示，读完清剪贴板）；
    3. GET /v1/projects/{ref} 核对项目名（预览 lemomemo-preview、正式 lemomemo-prod）和地区（首尔），防止贴错环境；
    4. 经 SQL 接口查 pg_roles：fn_vault、fn_ai 都在，superuser、bypassrls、createrole、replication、createdb 都是 false；
       查 pg_auth_members：两个角色不属于任何角色；否则停；
    5. GET /v1/projects/{ref}/config/database/pooler 取 Supavisor 事务模式（pool_mode = transaction）的 db_host、db_port；
       核对 identifier = ref、db_user = postgres.<ref>（fn 角色的用户名照这个格式写成 <角色>.<ref>），对不上就停；
    5a. 改密码之前先试令牌能不能写 secrets：写一个占位的 LEMO_PROBE、再用 DELETE /v1/projects/{ref}/secrets 删掉、核对删掉了；
    6. 在本机内存里给两个角色各生成一个密码（32 字节随机，转成 43 个 URL 安全字符 A～Z a～z 0～9 - _，放进连接串不用转义）；
    7. 在本机算出 PostgreSQL 的 SCRAM-SHA-256 校验串（RFC 5802 / 7677，4096 轮，16 字节随机盐），
       经 POST /v1/projects/{ref}/database/query 执行 alter role … with login password 「校验串」。
       **明文密码不发给 SQL 接口**：Supabase 的查询日志、pg_stat_statements 里只会有校验串（从校验串推不回 32 字节随机密码）；
    8. 再查一次 pg_roles，两个角色 rolcanlogin 都是 true；
    9. 把连接串 postgresql://fn_vault.<ref>:<密码>@<db_host>:<db_port>/postgres?sslmode=require（fn_ai 同理；_shared/db.ts 另外写死 ssl: 'require'）经 POST /v1/projects/{ref}/secrets
       写成 FN_VAULT_DB_URL、FN_AI_DB_URL（明文密码只在这一个 HTTPS 请求正文里出现一次）；写完 GET 核对两个名字在、原有的名字一个没少。
  屏幕上只显示「已写入」和名字，任何时候都不打印密码、连接串、令牌；不写任何文件；出错只打印状态码和对方的错误说明
  （写 secrets 出错时连对方的说明也不打印，只打印状态码；所有报错打印前把密码和令牌换成 ***）；接口请求不跟随跳转。
  第 7 步以后任何一步失败，都会提示「角色密码已改、secrets 未写，请立刻重跑本脚本」：这时函数用旧连接串连不上，重跑一次即可。
  不用 supabase CLI：`supabase secrets set` 只能把值写在命令行参数里或先写进 env 文件，两样都违反「值不进命令行参数、不落盘」。
  密码不另存（R-220）：丢了就重新运行本脚本，生成新密码、两处一起换。重新运行会让旧连接串立刻失效，
  已经在跑的函数下次启动时读到新的 secrets（中间几秒内的请求可能失败一次，用户重试即可）。

  临时管理令牌（R-220：不另存，用完删）：Supabase › Account › Access Tokens › 新建项目级令牌（Scoped PAT），
  **只选这个项目**（预览 lemomemo-preview 或正式 lemomemo-prod），到期设 1 天（24 小时），权限只勾下面四项，其余一律不给：
    - Database：Read-write          （执行 alter role；SQL 接口 Run a query）
    - Connection Pooling：Read      （读连接池地址；Get pooler config）
    - Edge Function Secrets：Read-write（写入并核对 secrets；Bulk create secrets、List all secrets）
    - Project Settings：Read        （核对项目名；Get project）
  权限名以 Supabase 2026-10 官方「Personal access tokens」文档的权限表为准，页面上的写法若略有不同以页面为准（未在真实令牌页面上实测）。
  不要 Cloudflare 令牌。
  剩下的风险：PowerShell 的字符串没法逐字节清零，值会在本进程内存里留到窗口关掉（和 publish.ps1 一样），所以最后要关窗口。

.PARAMETER Target
  preview 或 production。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-fn-role-passwords.ps1" -Target preview
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'production')][string]$Target,
    # 只给测试用（tests/build/set-fn-role-passwords.test.ts）：把管理接口指向本机假服务。只接受官方地址或 http://127.0.0.1:端口（\A…\z 整串匹配：
    # 不认 $ 前的换行、结尾斜杠、evil 后缀、@ 主机），令牌不会被发到别的主机；本机地址还要另设环境变量 LEMO_TEST_API=1 才生效（安全审查低 6）
    [Parameter(DontShow = $true)][ValidatePattern('\A(https://api\.supabase\.com|http://127\.0\.0\.1:\d{1,5})\z')][string]$ApiBase = 'https://api.supabase.com'
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
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
# 报错打印前，把内存里的两个密码和令牌换成 ***（安全审查中 2；变量还没建时跳过，StrictMode 下不报错）
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    $vals = @()
    $p = Get-Variable -Name pw -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if ($p -is [hashtable]) { $vals += @($p.Values) }
    $vals += Get-Variable -Name sbTok -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    foreach ($v in $vals) { if ($v -is [string] -and $v.Length -ge 8) { $s = $s.Replace($v, '***') } }
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

# ==== 安全窗口检查：开始（tools/keys/new-proxy-secret.ps1、set-r2-tokens.ps1、set-fn-role-passwords.ps1、login-token-tests.ps1、set-cron-secret.ps1、tools/release/publish.ps1 六处逐字相同，tests/build/keys-guard-sync.test.ts 核对；改一处六处一起改）====
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

# 粘贴一项：屏幕不显示，读完清剪贴板；按格式粗查（不打印内容）
function Read-Value([string]$label, [string]$where, [string]$pattern, [string]$hint) {
    Say ''
    Say "请粘贴：$label"
    Say "  （$where。屏幕上不显示，粘贴后按回车。）"
    # 网页“单击以复制”可能带零宽字符、不换行空格，统一去掉；格式不对时当场重贴（最多 3 次），只报长度和非十六进制字符个数，不显示值（10-28 实测）
    for ($try = 1; $try -le 3; $try++) {
        $sec = Read-Host -AsSecureString '  粘贴到这里'
        Clear-Clip
        $plain = To-Plain $sec
        $sec.Dispose()
        $plain = $plain -replace '[\s\u00A0\u200B-\u200D\u2060\uFEFF]', ''
        if ($plain -match $pattern) {
            Ok "$label 已收到（剪贴板已清空）"
            return $plain
        }
        # 本脚本只读一把令牌：格式不对时只报长度和是不是以 sbp_ 开头，不列字符编码（安全审查低 5）
        $len = $plain.Length
        $head = if ($plain.StartsWith('sbp_')) { '以 sbp_ 开头' } else { '不是以 sbp_ 开头' }
        $plain = $null
        Warn "格式不对（要 $hint）：收到 $len 个字符，$head。多半复制错了或没复制全"
        if ($try -lt 3) { Say '  请回到网页重新复制这一项，再粘贴一次：' }
    }
    Fail "$label 连续 3 次格式不对，已停止"
}

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
# 32 字节随机 → base64url 去掉结尾的 =（43 个字符，只有 A～Z a～z 0～9 - _），放进连接串的密码位置不用转义
function New-UrlSafePassword {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $s = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Array]::Clear($bytes, 0, $bytes.Length)
    return $s
}

function New-RandomBytes([int]$n) {
    $bytes = New-Object byte[] $n
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ,$bytes
}

# PBKDF2-HMAC-SHA256（RFC 8018 5.2），只算第一块：输出 32 字节，正好是 SCRAM-SHA-256 要的长度。
# .NET Framework 的 Rfc2898DeriveBytes 要 4.7.2 以上才有按 SHA256 算的重载，这里直接用 HMACSHA256 自己实现，不挑版本
function Get-Pbkdf2Sha256([byte[]]$password, [byte[]]$salt, [int]$iterations) {
    $hmac = [Security.Cryptography.HMACSHA256]::new($password)
    try {
        $block = New-Object byte[] ($salt.Length + 4)
        [Array]::Copy($salt, $block, $salt.Length)
        $block[$salt.Length + 3] = 1   # 块序号 INT(1)，大端 4 字节
        $u = $hmac.ComputeHash($block)
        $t = [byte[]]$u.Clone()
        for ($i = 2; $i -le $iterations; $i++) {
            $u = $hmac.ComputeHash($u)
            for ($j = 0; $j -lt $t.Length; $j++) { $t[$j] = $t[$j] -bxor $u[$j] }
        }
        [Array]::Clear($u, 0, $u.Length)
        return ,$t
    } finally { $hmac.Dispose() }
}

# PostgreSQL 的 SCRAM-SHA-256 校验串（RFC 5802、7677；和 PostgreSQL 源码 scram_build_secret 同一格式）：
#   SCRAM-SHA-256$<轮数>:<盐 base64>$<StoredKey base64>:<ServerKey base64>
#   SaltedPassword = PBKDF2-HMAC-SHA256(密码, 盐, 4096)；ClientKey = HMAC(SaltedPassword, 「Client Key」)；
#   StoredKey = SHA256(ClientKey)；ServerKey = HMAC(SaltedPassword, 「Server Key」)
# 密码只有 ASCII 字符，SASLprep 不改变它，直接取 UTF-8 字节
function New-ScramVerifier([string]$password, [byte[]]$salt) {
    $iter = 4096
    $pw = $null; $salted = $null; $clientKey = $null
    try {
        $pw = [Text.Encoding]::UTF8.GetBytes($password)
        $salted = Get-Pbkdf2Sha256 $pw $salt $iter
        $h = [Security.Cryptography.HMACSHA256]::new($salted)
        try {
            $clientKey = $h.ComputeHash([Text.Encoding]::ASCII.GetBytes('Client Key'))
            $serverKey = $h.ComputeHash([Text.Encoding]::ASCII.GetBytes('Server Key'))
        } finally { $h.Dispose() }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $storedKey = $sha.ComputeHash($clientKey) } finally { $sha.Dispose() }
        return 'SCRAM-SHA-256$' + $iter + ':' + [Convert]::ToBase64String($salt) + '$' + [Convert]::ToBase64String($storedKey) + ':' + [Convert]::ToBase64String($serverKey)
    } finally {
        foreach ($a in @($pw, $salted, $clientKey)) { if ($null -ne $a) { [Array]::Clear($a, 0, $a.Length) } }
    }
}

# 调接口；出错时只打印状态码和对方的错误说明（不含我们发的值）。
# -NoDetail：只打印状态码，不回显对方的响应正文（写 secrets 时用：对方出错时可能把请求正文、也就是连接串原样带回来，安全审查中 2）。
# -MaximumRedirection 0：不跟随跳转，带着令牌的请求不会被转到别的地址（安全审查低 7）
function Invoke-Api([string]$method, [string]$uri, [hashtable]$headers, [string]$json, [switch]$NoDetail) {
    try {
        if ($json) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0 -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) }
        return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0
    } catch {
        $code = ''; $detail = ''
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if (-not $NoDetail) { try { $detail = $_.ErrorDetails.Message } catch { } }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
        if ($NoDetail) { $detail = '（不显示对方的说明：里面可能带着连接串）' }
        Fail "$method $([Uri]$uri | ForEach-Object { $_.Host + $_.AbsolutePath }) 失败（HTTP $code）：$detail"
    }
}

# PowerShell 5.1 的 Invoke-RestMethod 会把 JSON 数组当成一个对象交出来，这里统一摊平成数组；空响应得到空数组
function As-List($r) {
    if ($null -eq $r -or ($r -is [string] -and $r -eq '')) { return ,@() }
    return ,@($r | ForEach-Object { $_ })
}

# StrictMode 下读不存在的属性会报错：缺字段时返回 $null，由调用处报清楚是哪个字段
function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj -or $obj -isnot [psobject]) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

# 经 Management API 执行一条 SQL（POST /v1/projects/{ref}/database/query）；返回行的数组
function Invoke-Sql([string]$api, [hashtable]$headers, [string]$sql) {
    $json = @{ query = $sql } | ConvertTo-Json -Compress
    return As-List (Invoke-Api POST "$api/database/query" $headers $json)
}

# 两个角色的属性；superuser、bypassrls、createrole、replication、createdb 任何一项为 true 都不对（安全审查低 8）
$RoleFlags = @('rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolreplication', 'rolcreatedb')
function Get-Roles([string]$api, [hashtable]$headers) {
    $rows = Invoke-Sql $api $headers "select rolname, rolcanlogin, $($RoleFlags -join ', ') from pg_roles where rolname in ('fn_vault', 'fn_ai') order by rolname"
    $byName = @{}
    foreach ($row in $rows) {
        $n = Get-Prop $row 'rolname'
        if ($null -eq $n) { Fail 'SQL 接口返回的格式和预期不同（行里没有 rolname 字段）。请在聊天里告诉运维' }
        $byName[[string]$n] = $row
    }
    return $byName
}

# fn 角色不能是任何角色的成员（不能借别的角色的权限）；postgres 对它们的 ADMIN 成员关系方向相反（postgres 是成员），不在这里查
function Assert-NoMembership([string]$api, [hashtable]$headers) {
    $rows = Invoke-Sql $api $headers "select r.rolname as member, g.rolname as granted from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where r.rolname in ('fn_vault', 'fn_ai') order by 1, 2"
    if ($rows.Count -gt 0) {
        $pairs = ($rows | ForEach-Object { "$(Get-Prop $_ 'member') 属于 $(Get-Prop $_ 'granted')" }) -join '、'
        Fail "fn 角色不应属于任何角色，现在：$pairs。没有设密码，请在聊天里告诉运维"
    }
}

function Get-SecretNames([string]$api, [hashtable]$headers) {
    return ,@((As-List (Invoke-Api GET "$api/secrets" $headers '')) | ForEach-Object { [string](Get-Prop $_ 'name') })
}

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $supaName = 'lemomemo-preview'; $ref = 'yoeqwhygehbaftkppati'
} else {
    $label = '正式'; $supaName = 'lemomemo-prod'; $ref = 'uvlnwawwsdfihziaielj'
}
$roles = @('fn_vault', 'fn_ai')
$secretOf = @{ fn_vault = 'FN_VAULT_DB_URL'; fn_ai = 'FN_AI_DB_URL' }

$pw = @{}; $ver = @{}
$sbTok = $null; $sbH = $null; $body = $null; $list = $null
$altered = $false; $secretsPosted = $false
try {
    Step "给$label 环境的 fn_vault、fn_ai 设密码：先检查"
    Assert-SafeWindow
    # ref 不是密钥，直接写在脚本里（环境清单-v4 记着同样的值）；下面会用临时令牌核对项目名，不对就停
    Ok "$label Project ref 已自动填好"
    $api = "$ApiBase/v1/projects/$ref"

    Step '粘贴临时管理令牌（只用来写这一次）'
    $sbTok = Read-Value "Supabase 令牌（只管 $supaName）" '刚临时生成的项目级令牌：只选这个项目、1 天到期，权限只勾脚本开头写的四项，用完删掉' '^sbp_[A-Za-z0-9_]{20,}$' '以 sbp_ 开头'
    $sbH = @{ Authorization = "Bearer $sbTok" }

    Step '核对项目（防止贴错环境）'
    $proj = Invoke-Api GET $api $sbH ''
    $projName = Get-Prop $proj 'name'
    if ($projName -ne $supaName) { Fail "这个 Supabase 项目叫「$projName」，不是 $supaName。是不是贴成了另一个环境的令牌？" }
    $region = Get-Prop $proj 'region'
    if ($region -ne 'ap-northeast-2') { Fail "Supabase 项目不在首尔（$region）" }
    Ok "Supabase 项目：$projName（首尔）"

    Step '查两个角色（迁移 0001_core.sql 建的）'
    $before = Get-Roles $api $sbH
    foreach ($r in $roles) {
        if (-not $before.ContainsKey($r)) { Fail "数据库里没有角色 $r。先让后端把迁移部署到 $supaName，再运行本脚本" }
        $on = @($RoleFlags | Where-Object { (Get-Prop $before[$r] $_) -ne $false })
        if ($on.Count) { Fail "角色 $r 的 $($on -join '、') 不是 false，和迁移不一致。没有设密码，请在聊天里告诉运维" }
    }
    Assert-NoMembership $api $sbH
    $loginNow = ($roles | ForEach-Object { "$_ 现在$(if ((Get-Prop $before[$_] 'rolcanlogin') -eq $true) { '能' } else { '不能' })登录" }) -join '，'
    Ok "fn_vault、fn_ai 都在；不是 superuser，没有 bypassrls、createrole、replication、createdb，不属于任何角色（$loginNow）"

    Step '取连接池地址（Supavisor 事务模式）'
    $pools = As-List (Invoke-Api GET "$api/config/database/pooler" $sbH '')
    $tx = @($pools | Where-Object { (Get-Prop $_ 'pool_mode') -eq 'transaction' -and @($null, 'PRIMARY') -contains (Get-Prop $_ 'database_type') })
    if ($tx.Count -eq 0) {
        $modes = (@($pools | ForEach-Object { "$(Get-Prop $_ 'database_type')/$(Get-Prop $_ 'pool_mode')" }) -join '、')
        Fail "连接池接口没有返回事务模式（pool_mode = transaction）的主库连接池（收到 $($pools.Count) 条：$modes）。请在聊天里告诉运维"
    }
    $pool = $tx[0]
    # 安全审查低 9：这条连接池必须是本项目的（identifier = ref），接口给的默认用户名必须是 postgres.<ref>，我们照它的格式换成 <角色>.<ref>
    $ident = [string](Get-Prop $pool 'identifier')
    if ($ident -ne $ref) { Fail "连接池接口返回的 identifier 不是本项目的 ref（收到「$ident」）。请在聊天里告诉运维" }
    $dbUser = [string](Get-Prop $pool 'db_user')
    if ($dbUser -ne "postgres.$ref") { Fail "连接池接口返回的 db_user 不是「postgres.<ref>」的格式（收到「$dbUser」），不能确定 fn 角色的用户名怎么写。请在聊天里告诉运维" }
    $poolHost = [string](Get-Prop $pool 'db_host')
    $poolPort = Get-Prop $pool 'db_port'
    if (-not $poolHost) { Fail '连接池接口的返回里没有 db_host 字段（Supabase 可能改了接口）。请在聊天里告诉运维' }
    if ($null -eq $poolPort) { Fail '连接池接口的返回里没有 db_port 字段（Supabase 可能改了接口）。请在聊天里告诉运维' }
    if ($poolHost -notmatch '\A[A-Za-z0-9.-]+\z') { Fail '连接池接口返回的 db_host 格式不对（只应有字母、数字、点和 -）' }
    $portNum = 0
    if (-not [int]::TryParse([string]$poolPort, [ref]$portNum) -or $portNum -lt 1 -or $portNum -gt 65535) { Fail '连接池接口返回的 db_port 不是端口号' }
    Ok "连接池：${poolHost}:$portNum（事务模式，用户名照 $($dbUser -replace '^postgres\.', '<角色>.')）"

    Step '先试一下令牌能不能写 secrets（写一个占位的 LEMO_PROBE 再删掉）'
    # 安全审查中 3：权限不够时要在改密码之前发现，否则密码改了、连接串写不进去，函数就连不上了
    $all = Get-SecretNames $api $sbH
    $secretsBefore = @($all | Where-Object { $_ -ne 'LEMO_PROBE' })
    if ($all -contains 'LEMO_PROBE') { Say '  发现上次留下的 LEMO_PROBE，会一并删掉' }
    $probe = ConvertTo-Json -InputObject @(@{ name = 'LEMO_PROBE'; value = 'probe-not-a-secret' }) -Compress
    $null = Invoke-Api POST "$api/secrets" $sbH $probe
    # 复审低 A：DELETE 本身报错时（权限、接口变了）也要告诉负责人去网页上手动删
    try {
        $null = Invoke-Api DELETE "$api/secrets" $sbH (ConvertTo-Json -InputObject @('LEMO_PROBE') -Compress)
    } catch {
        $why = ([string]$_.Exception.Message) -replace '^已停止：', ''
        Fail "删除占位的 LEMO_PROBE 失败（$why）。还没改密码；请到 Supabase › Edge Functions › Secrets 手动删掉 LEMO_PROBE（值不敏感），并在聊天里告诉运维"
    }
    $now = Get-SecretNames $api $sbH
    if ($now -contains 'LEMO_PROBE') { Fail '占位的 LEMO_PROBE 删不掉（删除接口和文档不一样？）。还没改密码；请到 Supabase › Edge Functions › Secrets 手动删掉 LEMO_PROBE（值不敏感），并在聊天里告诉运维' }
    Ok "令牌能写、能删 secrets；现有 $($secretsBefore.Count) 个（只看名字）"

    Step '生成密码、在本机算 SCRAM 校验串'
    foreach ($r in $roles) {
        $pw[$r] = New-UrlSafePassword
        if ($pw[$r] -notmatch '\A[A-Za-z0-9_-]{43}\z') { Fail '生成的密码格式不对' }
        $salt = New-RandomBytes 16
        $ver[$r] = New-ScramVerifier $pw[$r] $salt
        [Array]::Clear($salt, 0, $salt.Length)
        # 校验串只含 base64 字符、$ 和 :，没有单引号，可以直接放进 SQL 字符串
        if ($ver[$r] -notmatch '\ASCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=\z') { Fail '算出的 SCRAM 校验串格式不对' }
    }
    if ($pw.fn_vault -eq $pw.fn_ai) { Fail '两个密码相同（随机数出错）' }
    Ok '两个密码已在内存里生成（各 32 字节随机，不显示）；SCRAM 校验串已算好，SQL 接口只收到校验串'

    Step '设密码（alter role … login password，只发校验串）'
    foreach ($r in $roles) {
        $altered = $true   # 请求一发出去就当作可能已改（对方可能改了但回包丢了）
        $null = Invoke-Sql $api $sbH "alter role $r with login password '$($ver[$r])'"
        $ver[$r] = $null
    }
    $after = Get-Roles $api $sbH
    foreach ($r in $roles) {
        if (-not $after.ContainsKey($r) -or (Get-Prop $after[$r] 'rolcanlogin') -ne $true) { Fail "设完以后 $r 还是不能登录（rolcanlogin 不是 true）" }
    }
    Ok '已设好：fn_vault、fn_ai 都能登录了'

    Step "写入 Supabase：$supaName › Edge Functions › Secrets"
    # 用户名 <角色>.<ref>：Supavisor 按「角色.项目 ref」认项目（架构 6.2、未核实第 17 项；格式已和接口给的 db_user 对过）；库名 postgres。
    # sslmode=require：要求加密（安全审查严重 1）；_shared/db.ts 另外写死 ssl: 'require'，两层都要求，不依赖其中一层
    $list = @(foreach ($r in $roles) {
        @{ name = $secretOf[$r]; value = "postgresql://$r.${ref}:$($pw[$r])@${poolHost}:$portNum/postgres?sslmode=require" }
    })
    $body = ConvertTo-Json -InputObject $list -Compress
    $null = Invoke-Api POST "$api/secrets" $sbH $body -NoDetail
    $secretsPosted = $true
    $body = $null; $list = $null
    $have = Get-SecretNames $api $sbH
    foreach ($n in 'FN_VAULT_DB_URL', 'FN_AI_DB_URL') { if ($have -notcontains $n) { Fail "Supabase 上没有 $n" } }
    $lost = @($secretsBefore | Where-Object { $have -notcontains $_ })
    if ($lost.Count) { Fail "写入后原有的 secrets 不见了：$($lost -join '、')。请在聊天里告诉运维" }
    foreach ($r in $roles) { $pw[$r] = $null }
    Ok "已写入 Supabase：FN_VAULT_DB_URL、FN_AI_DB_URL；原有的 $($secretsBefore.Count) 个 secrets 都在"

    Say ''
    Say "全部写好。在聊天里说「$label 的 fn_vault、fn_ai 密码设好了」。"
    Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
}
catch {
    # 所有报错打印前都去掉密码和令牌（安全审查中 2）；改了密码以后出的错，明确告诉负责人要马上重跑（中 3）
    $msg = Hide-Secrets ([string]$_.Exception.Message)
    if ($altered -and -not $secretsPosted) {
        $msg = "角色密码已改、secrets 未写，请立刻重跑本脚本（函数用旧连接串连不上）。$msg"
    } elseif ($altered) {
        $msg = "角色密码已改、secrets 已提交但核对没通过，请立刻重跑本脚本。$msg"
    }
    if ($altered) { Write-Host "  ✘ $msg" -ForegroundColor Red }
    throw $msg
}
finally {
    foreach ($k in @($pw.Keys)) { $pw[$k] = $null }
    foreach ($k in @($ver.Keys)) { $ver[$k] = $null }
    $pw = $null; $ver = $null; $sbTok = $null; $sbH = $null; $body = $null; $list = $null
    Clear-Clip
    [GC]::Collect()
    Write-Host '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
