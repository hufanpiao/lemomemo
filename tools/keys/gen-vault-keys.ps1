<#
.SYNOPSIS
  生成隐私记的三把钥匙 VAULT_KEY、VAULT_PIN_PEPPER、VAULT_TOKEN_SECRET，写进 Supabase 函数 secrets
  （架构 8.4、5.5、R-220；B5 任务单 S19、第四节第 1 步）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，AI 不经手任何值。

.DESCRIPTION
  vault、vault-image、account 三个函数读这三把钥匙（supabase/functions/_shared/vault-crypto.ts 的 decodeKey32：32 字节随机数的标准 base64，44 个字符、以 = 结尾）。
  本脚本做的事（按顺序，任何一步不过就停）：
    1. 开头检查（和其他密钥脚本同一段、逐字相同，tests/build/keys-guard-sync.test.ts 核对）：Windows 剪贴板历史关着、
       系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略、本窗口没在记 transcript；关掉本窗口的历史记录；
    2. 粘贴一把临时的 Supabase 管理令牌（Read-Host -AsSecureString，屏幕不显示，读完清剪贴板）；
    3. GET /v1/projects/{ref} 核对项目名（预览 lemomemo-preview、正式 lemomemo-prod）和地区（首尔），防止贴错环境；
    4. GET /v1/projects/{ref}/secrets 只取 name 字段。**VAULT_KEY、VAULT_PIN_PEPPER 已经有了就整个停下、什么都不写**：
       换掉它们等于让所有已有的隐私记再也打不开、所有人的隐私记密码作废，本脚本不提供这个选项。
       只有 VAULT_TOKEN_SECRET 可以用 -RotateTokenSecret 单独换（R-220：后果只是所有人要重新解锁隐私记）；
    5. 在本机内存里用 RandomNumberGenerator 生成要写的值（各 32 字节）；
    6. 新生成了 VAULT_KEY、VAULT_PIN_PEPPER 时：屏幕上**只显示这一次**，请负责人马上存进 Google 密码管理器（passwords.google.com），
       存好后从 Google 密码管理器里**复制回来粘贴一遍**（Read-Host -AsSecureString），两把都对上了才往下走——确认存进去的是对的；
       对不上可以重贴，3 次都不对就停下、什么都不写（值作废，重跑脚本重新生成）。核对完马上清屏；
    7. POST /v1/projects/{ref}/secrets 一次写入（值只在这个 HTTPS 请求正文里出现一次），马上清掉内存里的变量；
       写完 GET 核对三个名字都在、原有的 secrets 一个没少。
  不用 supabase CLI：`supabase secrets set` 只能把值写在命令行参数里或先写进 env 文件，两样都违反「值不进命令行参数、不落盘」。
  除第 6 步那一次显示外，任何时候都不打印值、令牌；不写任何文件；脚本不往剪贴板里放任何东西。
  出错只打印状态码和对方的错误说明；写 secrets 那一次出错时连对方的说明也不打印；所有报错打印前把值和令牌换成 ***；
  接口请求不跟随跳转（-MaximumRedirection 0）；结束时清掉 $Error。
  ⚠ VAULT_KEY、VAULT_PIN_PEPPER 丢了不能重来（所有隐私记都打不开），唯一的备份就是 Google 密码管理器里那一条（R-220）。
  VAULT_TOKEN_SECRET 不用存（丢了加 -RotateTokenSecret 重跑）。

  临时管理令牌（R-220：不另存，用完删）：Supabase › Account › Access Tokens › 新建项目级令牌（Scoped PAT），
  **只选这个项目**，到期设 1 天，权限只勾下面两项，其余一律不给：
    - Edge Function Secrets：Read-write（写入并核对）
    - Project Settings：Read          （核对项目名）
  权限名照 set-signup-secrets.ps1 写，**没有在真实的令牌页面上核对过**，第一次跑预览时确认。

.PARAMETER Target
  preview 或 prod。

.PARAMETER RotateTokenSecret
  只换 VAULT_TOKEN_SECRET（另外两把已存在时也可以用）。后果：所有人要重新解锁隐私记，没有别的影响。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\gen-vault-keys.ps1" -Target preview
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'prod')][string]$Target,
    [switch]$RotateTokenSecret,
    # 只给测试用：把管理接口指向本机假服务（同 set-signup-secrets.ps1）。本机地址还要另设环境变量 LEMO_TEST_API=1 才生效
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


function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ✘ $msg" -ForegroundColor Yellow }
# 报错打印前，把内存里的值和令牌换成 ***（变量还没建时跳过，StrictMode 下不报错）
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    foreach ($n in 'vaultKey', 'pepper', 'tokenSecret', 'sbTok') {
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
    # 10-29 负责人定（R-223）：不再检查 Claude 是否在运行；第 6 步显示值之前在屏幕上另外要求完全退出 Claude、存好后关掉整个窗口
    Assert-NoRecording
}

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 粘贴一个值：屏幕不显示，读完清剪贴板；去掉零宽字符、不换行空格和空白
function Read-Secret([string]$prompt) {
    $sec = Read-Host -AsSecureString $prompt
    Clear-Clip
    $plain = To-Plain $sec
    $sec.Dispose()
    return ($plain -replace '[\s\u00A0\u200B-\u200D\u2060\uFEFF]', '')
}

# Supabase 令牌（sbp_ 开头），格式不对重贴，最多 3 次
function Read-Token([string]$label, [string]$where) {
    Say ''
    Say "请粘贴：$label"
    Say "  （$where。屏幕上不显示，粘贴后按回车。）"
    for ($try = 1; $try -le 3; $try++) {
        $v = Read-Secret '  粘贴到这里'
        if ($v -cmatch '\Asbp_[A-Za-z0-9_]{20,}\z') { Ok "$label 已收到（剪贴板已清空）"; return $v }
        Warn "格式不对（要以 sbp_ 开头）：收到 $($v.Length) 个字符"
        $v = $null
    }
    Fail "$label 连续 3 次格式不对，已停止"
}

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
            if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
        }
        Fail "$method $([Uri]$uri | ForEach-Object { $_.Host + $_.AbsolutePath }) 失败（HTTP $code）：$detail"
    }
}

function As-List($r) {
    if ($null -eq $r -or ($r -is [string] -and $r -eq '')) { return ,@() }
    return ,@($r | ForEach-Object { $_ })
}

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

# 32 字节随机数的标准 base64（44 个字符，以 = 结尾；和函数里 decodeKey32 认的格式一致）
function New-Key32 {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $b64 = [Convert]::ToBase64String($bytes)
    [Array]::Clear($bytes, 0, $bytes.Length)
    if ($b64 -cnotmatch '\A[A-Za-z0-9+/]{43}=\z') { Fail '生成的钥匙格式不对' }
    return $b64
}

# 显示一次、请负责人存进 Google 密码管理器，再从那里复制回来核对（3 次机会）
function Confirm-Saved([string]$name, [string]$value) {
    Say ''
    Say "  $name（只显示这一次）："
    Write-Host "      $value" -ForegroundColor Yellow
    Say ''
    Say "  请现在把上面这一段原样存进 Google 密码管理器那一条里（字段名写 $name）。"
    $null = Read-Host '  存好了按回车（屏幕会马上清掉）'
    Clear-Host
    Say "  核对 $name：请从 Google 密码管理器里复制刚存的值，粘贴回来（屏幕不显示）。"
    for ($try = 1; $try -le 3; $try++) {
        $back = Read-Secret '  粘贴到这里'
        $same = ($back -ceq $value)
        $back = $null
        if ($same) { Ok "$name 和 Google 密码管理器里存的一致"; return }
        Warn '对不上：请打开 Google 密码管理器那一条，重新复制再粘贴（多半少复制了一个字符，或贴成了另一把）'
    }
    Fail "$name 连续 3 次对不上，什么都没写（这次生成的值作废，请重新运行脚本）"
}

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $supaName = 'lemomemo-preview'; $ref = 'yoeqwhygehbaftkppati'; $entry = '柠檬记 隐私记总钥匙（预览）'
} else {
    $label = '正式'; $supaName = 'lemomemo-prod'; $ref = 'uvlnwawwsdfihziaielj'; $entry = '柠檬记 隐私记总钥匙（正式）'
}

$vaultKey = $null; $pepper = $null; $tokenSecret = $null; $sbTok = $null; $sbH = $null; $body = $null; $items = $null
try {
    Step "给$label 环境生成隐私记的钥匙：先检查"
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
    Ok "现有 $($before.Count) 个 secrets（只看名字）"
    $hasKey = $before -contains 'VAULT_KEY'
    $hasPepper = $before -contains 'VAULT_PIN_PEPPER'
    $hasTok = $before -contains 'VAULT_TOKEN_SECRET'
    if ($hasKey -ne $hasPepper) { Fail 'VAULT_KEY 和 VAULT_PIN_PEPPER 只有一个在，这不正常。什么都没写，请在聊天里告诉运维' }
    $newMain = -not $hasKey
    $newTok = (-not $hasTok) -or $RotateTokenSecret
    if ($hasKey) { Say '  VAULT_KEY、VAULT_PIN_PEPPER：已经有了，不换（换掉会让所有已有的隐私记打不开，本脚本不做）' }
    if ($hasTok -and -not $RotateTokenSecret) { Say '  VAULT_TOKEN_SECRET：已经有了，不换（要换的话加 -RotateTokenSecret）' }
    if (-not $newMain -and -not $newTok) {
        Say ''
        Say "三把都已经有了，这次什么都没写。在聊天里说「$label 的隐私记钥匙本来就都在」。"
        Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
        return
    }

    Step '在本机内存里生成（不写文件、不进剪贴板）'
    if ($newMain) { $vaultKey = New-Key32; $pepper = New-Key32; Ok 'VAULT_KEY、VAULT_PIN_PEPPER 已生成（各 32 字节）' }
    if ($newTok) { $tokenSecret = New-Key32; Ok 'VAULT_TOKEN_SECRET 已生成（32 字节，不显示，也不用存）' }

    if ($newMain) {
        Step '存进 Google 密码管理器（⚠ 这两把丢了不能重来）'
        Say '  1. 先确认身边没有人在看屏幕，屏幕没有在共享、录屏；'
        Say '     Claude 桌面应用请完全退出（它的终端面板能读到屏幕内容），也不要在编辑器内置的终端里运行本脚本。'
        Say '     下面显示的值存好以后，请关掉整个 PowerShell 窗口（清屏清不掉部分终端的回滚记录）。'
        Say '  2. 打开 passwords.google.com › 添加，新建一条：'
        Say "       名称：$entry"
        Say '       下面两段分别贴进这一条（用户名一栏写 VAULT_KEY，密码一栏贴 VAULT_KEY 的值；备注里写 VAULT_PIN_PEPPER 和它的值），保存。'
        $null = Read-Host '  准备好了按回车，屏幕上会显示第一把'
        Confirm-Saved 'VAULT_KEY' $vaultKey
        Confirm-Saved 'VAULT_PIN_PEPPER' $pepper
        Clear-Host
        Ok '两把都已存进 Google 密码管理器并核对过，屏幕已清'
    }

    $names = @()
    $items = @()
    if ($newMain) { $items += @{ name = 'VAULT_KEY'; value = $vaultKey }; $items += @{ name = 'VAULT_PIN_PEPPER'; value = $pepper }; $names += 'VAULT_KEY', 'VAULT_PIN_PEPPER' }
    if ($newTok) { $items += @{ name = 'VAULT_TOKEN_SECRET'; value = $tokenSecret }; $names += 'VAULT_TOKEN_SECRET' }
    Step "写入 Supabase：$supaName › Edge Functions › Secrets（$($names -join '、')）"
    $body = ConvertTo-Json -InputObject @($items) -Compress
    $null = Invoke-Api POST "$api/secrets" $sbH $body -NoDetail
    $body = $null; $items = $null; $vaultKey = $null; $pepper = $null; $tokenSecret = $null

    $have = Get-SecretNames $api $sbH
    $miss = @('VAULT_KEY', 'VAULT_PIN_PEPPER', 'VAULT_TOKEN_SECRET' | Where-Object { $have -notcontains $_ })
    if ($miss.Count) { Fail "写入后 Supabase 上还是没有：$($miss -join '、')" }
    $lost = @($before | Where-Object { $have -notcontains $_ })
    if ($lost.Count) { Fail "写入后原有的 secrets 不见了：$($lost -join '、')。请在聊天里告诉运维" }
    Ok "已写入 $($names -join '、')；三个名字都在，原有的 $($before.Count) 个 secrets 都在"

    Say ''
    Say "全部写好。在聊天里说「$label 的隐私记钥匙设好了」（只说这一句，不要贴任何值）。"
    Say '接着运行泄漏检查：tools\keys\check-vault-keys-leak.ps1（步骤见 docs\00-团队\负责人-隐私记密钥-步骤.md）。'
    Say '别忘了：到 Supabase › Account › Access Tokens 把这次临时生成的令牌删掉。'
}
catch {
    throw (Hide-Secrets ([string]$_.Exception.Message))
}
finally {
    $vaultKey = $null; $pepper = $null; $tokenSecret = $null; $sbTok = $null; $sbH = $null; $body = $null; $items = $null
    Clear-Clip
    [GC]::Collect()
    $Error.Clear()
    Write-Host '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
