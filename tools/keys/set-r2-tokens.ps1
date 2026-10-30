<#
.SYNOPSIS
  把 R2 令牌写进 Pages 和 Supabase（架构 0.32 第 12 条、8.4；B0 R2 任务单 O-3）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，不经过 Claude。

.DESCRIPTION
  R2 的 API 令牌只能在 Cloudflare 后台生成、Secret 只显示一次，按安全规则只能负责人本人生成（R-218）。
  生成以后运行本脚本，按提示粘贴，脚本直接写到要用的地方，屏幕上只显示“已写入”和变量名。

  三种用法：
    -Kind app（默认）：写一个环境（-Target preview 或 production）要用的全部 R2 配置——
        Cloudflare Pages 项目（lemomemo-preview / lemomemo）› 生产（Production）环境的变量：
          R2_ENDPOINT、R2_BUCKET_PREFIX（普通文本；正式为空就不写）、
          R2_FILES_ACCESS_KEY_ID、R2_FILES_SECRET_ACCESS_KEY（加密）、FILES_URL_SECRET（加密，脚本在内存里随机生成 32 字节）；
        Supabase 项目（lemomemo-preview / lemomemo-prod）› Edge Functions › Secrets：
          R2_ENDPOINT、R2_BUCKET_PREFIX（正式为空就不写）、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY。
        写入走两家官方的管理接口（Cloudflare API、Supabase Management API），在本进程里用 Invoke-RestMethod 发，
        **不用 supabase CLI**：`supabase secrets set` 只能把值写在命令行参数里或先写进 env 文件，两样都违反“值不进命令行参数、不落盘”。
        要粘贴两把“管理令牌”：Cloudflare（只要 Account › Cloudflare Pages › Edit）和 Supabase（只管这个项目的项目级令牌，
        能写 Edge Functions 的 secrets）。预览环境没有存这两把（第 ⑥ 节生成后只贴进了 GitHub），按负责人B0网页操作清单第 ⑫ 节
        临时生成两把 1 天到期的，用完删掉；正式环境同样当场临时生成（只管正式项目、1 天到期），用完删掉（R-220：令牌不另存）。
    -Kind pull（只能 -Target production）：本机每周拉照片和附件用的只读令牌 R2_PULL_*，写进 Windows 凭据管理器
        （目标名 lemomemo/R2_PULL_ACCESS_KEY_ID、lemomemo/R2_PULL_SECRET_ACCESS_KEY；B7 tools/backup/pull.ps1 按这两个名字读）。
        用 Win32 CredWrite 写，不经 cmdkey（cmdkey 要把密码写在命令行参数里）。
    -Manual：不用管理令牌，网页上手动粘贴。只做一件事：在内存里生成 FILES_URL_SECRET，屏幕显示一次，
        你粘贴进 Pages 加密变量，按回车后清屏、清剪贴板（同 new-proxy-secret.ps1）。R2 的令牌直接从 Cloudflare 页面复制到 Pages 和 Supabase。

  开头检查（任何一项不过就停，和 new-proxy-secret.ps1、publish.ps1 同一段、逐字相同）：没有 Claude 在运行
  （进程名 claude*，以及命令行带 claude-code / @anthropic-ai 的 node.exe）、Windows 剪贴板历史关着、
  系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略、本窗口没在记 transcript；关掉本窗口的历史记录。
  粘贴一律用 Read-Host -AsSecureString（屏幕不显示、不进历史），每读完一项清剪贴板；不写任何文件、不打印任何值；
  结尾清掉内存里的变量和剪贴板。值只在发给 Cloudflare / Supabase 的 HTTPS 请求正文里出现一次。
  剩下的风险：PowerShell 的字符串没法逐字节清零，值会在本进程内存里留到窗口关掉（和 publish.ps1 一样），所以最后要关窗口。

.PARAMETER Target
  preview 或 production。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-r2-tokens.ps1" -Target preview

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\set-r2-tokens.ps1" -Target production -Kind pull
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'production')][string]$Target,
    [ValidateSet('app', 'pull')][string]$Kind = 'app',
    [switch]$Manual
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { }
}

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ✘ $msg" -ForegroundColor Yellow }
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
        $len = $plain.Length
        $other = $plain -replace '[0-9a-fA-F]', ''
        $bad = $other.Length
        # 只列出不属于十六进制的字符编码（它们不是密钥的一部分），不显示值本身
        $codes = (($other.ToCharArray() | Select-Object -Unique -First 5) | ForEach-Object { 'U+{0:X4}' -f [int]$_ }) -join ' '
        $plain = $null; $other = $null
        Warn "格式不对（要 $hint）：收到 $len 个字符，其中 $bad 个不是十六进制 $codes。多半复制错了栏（例如复制成了上面的「令牌值」）或没复制全"
        if ($try -lt 3) { Say '  请回到网页重新复制这一项，再粘贴一次：' }
    }
    Fail "$label 连续 3 次格式不对，已停止"
}

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function New-RandomHex32 {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $hex = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    [Array]::Clear($bytes, 0, $bytes.Length)
    return $hex
}

# 调接口；出错时只打印状态码和对方的错误说明（不含我们发的值）
function Invoke-Api([string]$method, [string]$uri, [hashtable]$headers, [string]$json) {
    try {
        if ($json) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0 -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) }
        return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -MaximumRedirection 0
    } catch {
        $code = ''; $detail = ''
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        try { $detail = $_.ErrorDetails.Message } catch { }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
        Fail "$method $([Uri]$uri | ForEach-Object { $_.Host + $_.AbsolutePath }) 失败（HTTP $code）：$detail"
    }
}

# Pages 项目生产环境的变量（没有时返回 $null；StrictMode 下不存在的属性会报错，所以包一层）
function Get-ProdEnvVars($projResult) {
    try { return $projResult.deployment_configs.production.env_vars } catch { return $null }
}

# ───────────────────────── -Kind pull：写 Windows 凭据管理器 ─────────────────────────
function Write-Credential([string]$target, [string]$user, [string]$secret) {
    if (-not ('LemoCred' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LemoCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWriteW(ref CREDENTIAL c, int flags);
    public static void Write(string target, string user, string secret) {
        IntPtr blob = Marshal.StringToCoTaskMemUni(secret);
        try {
            var c = new CREDENTIAL { Type = 1, TargetName = target, UserName = user, Persist = 2,
                CredentialBlob = blob, CredentialBlobSize = secret.Length * 2 };
            if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
    }
}
'@
    }
    [LemoCred]::Write($target, $user, $secret)
}

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $pages = 'lemomemo-preview'; $supaName = 'lemomemo-preview'; $prefix = 'preview-'
} else {
    $label = '正式'; $pages = 'lemomemo'; $supaName = 'lemomemo-prod'; $prefix = ''
}
if ($Kind -eq 'pull' -and $Target -ne 'production') { Fail '只读拉取令牌只有正式环境有（架构 8.4），请用 -Target production -Kind pull' }

$vals = @{}
$cfTok = $null; $sbTok = $null; $shown = $false
try {
    Step "写入$label 环境的 R2 配置：先检查"
    Assert-SafeWindow

    if ($Manual) {
        Step "手动方式：只生成 FILES_URL_SECRET（$label）"
        $v = New-RandomHex32
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($v))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        Say ''
        Say '  值（64 位，只有 0～9 和 a～f；只显示这一次，不用另存——丢了重新生成就行，旧链接最多 10 分钟内作废）：'
        Say ''
        $shown = $true
        [Console]::WriteLine("      $v")
        $v = $null
        Say ''
        Say "  SHA-256（不是密钥）：$digest"
        Say "  Cloudflare › Workers & Pages › $pages › 设置 › 变量和机密 › 生产（Production）› 添加：类型选「密钥 / Secret」，名称 FILES_URL_SECRET，粘贴，保存。"
        Say '  复制方法：用鼠标选中上面那一行的值（不要带前后的空格），按回车复制。'
        $null = Read-Host '  贴好了按回车（会清屏、清剪贴板）'
        return
    }

    if ($Kind -eq 'pull') {
        Step '粘贴只读拉取令牌（R2_PULL_*，Object Read only，授正式四个桶）'
        $id = Read-Value 'R2_PULL 的 Access Key ID' 'Cloudflare 生成令牌后的页面上“访问密钥 ID / Access Key ID”' '^[0-9a-f]{32}$' '32 位十六进制'
        $sk = Read-Value 'R2_PULL 的 Secret Access Key' '同一页“机密访问密钥 / Secret Access Key”' '^[0-9a-f]{64}$' '64 位十六进制'
        Write-Credential 'lemomemo/R2_PULL_ACCESS_KEY_ID' 'R2_PULL' $id
        Write-Credential 'lemomemo/R2_PULL_SECRET_ACCESS_KEY' 'R2_PULL' $sk
        $id = $null; $sk = $null
        Ok '已写入 Windows 凭据管理器：lemomemo/R2_PULL_ACCESS_KEY_ID、lemomemo/R2_PULL_SECRET_ACCESS_KEY'
        return
    }

    Step '不是密钥的两项'
    # 这两项不是密钥，直接写在脚本里（环境清单-v4 记着同样的值，10-28 负责人嫌粘贴太多）；后面会用临时令牌核对项目名，不对就停
    $acct = '85bc77b19e5133870fa049da6da2deda'
    $ref = if ($Target -eq 'preview') { 'yoeqwhygehbaftkppati' } else { 'uvlnwawwsdfihziaielj' }
    Ok "Account ID、$label Project ref 已自动填好"
    $endpoint = "https://$acct.r2.cloudflarestorage.com"

    Step '粘贴两把管理令牌（只用来写这一次）'
    $cfTok = Read-Value 'Cloudflare 令牌（Account › Cloudflare Pages › Edit）' "$(if ($Target -eq 'preview') { '第 ⑫ 节临时生成的「柠檬记 R2 写入（临时）」' } else { '刚临时生成的正式 Cloudflare 管理令牌（1 天到期，用完删掉）' })" '^[A-Za-z0-9_-]{30,}$' '30 位以上的字母、数字、- 和 _'
    $sbTok = Read-Value "Supabase 令牌（只管 $supaName）" "$(if ($Target -eq 'preview') { '第 ⑫ 节临时生成的项目级令牌' } else { '刚临时生成的正式 Supabase 项目级令牌（1 天到期，用完删掉）' })" '^sbp_[A-Za-z0-9_]{20,}$' '以 sbp_ 开头'

    $cfH = @{ Authorization = "Bearer $cfTok" }
    $sbH = @{ Authorization = "Bearer $sbTok" }

    Step '核对项目（防止贴错环境）'
    $proj = Invoke-Api GET "https://api.supabase.com/v1/projects/$ref" $sbH ''
    if ($proj.name -ne $supaName) { Fail "这个 Supabase 项目叫「$($proj.name)」，不是 $supaName。是不是贴成了另一个环境的 ref？" }
    if ($proj.region -ne 'ap-northeast-2') { Fail "Supabase 项目不在首尔（$($proj.region)）" }
    Ok "Supabase 项目：$($proj.name)（首尔）"
    $cfProj = Invoke-Api GET "https://api.cloudflare.com/client/v4/accounts/$acct/pages/projects/$pages" $cfH ''
    if (-not $cfProj.success -or $cfProj.result.name -ne $pages) { Fail "Cloudflare 里找不到 Pages 项目 $pages" }
    $before = @()
    $ev = Get-ProdEnvVars $cfProj.result
    if ($ev) { $before = @($ev.PSObject.Properties.Name) }
    Ok "Pages 项目：$pages（生产环境现有变量 $($before.Count) 个：$($before -join '、')）"

    Step "粘贴 R2 令牌（$label，桶前缀「$prefix」）"
    $vals.FilesId = Read-Value 'R2_FILES 的 Access Key ID' "令牌「柠檬记 $label files」生成后的页面（只授 ${prefix}images、${prefix}files 两个桶，读写）" '^[0-9a-f]{32}$' '32 位十六进制'
    $vals.FilesSk = Read-Value 'R2_FILES 的 Secret Access Key' '同一页' '^[0-9a-f]{64}$' '64 位十六进制'
    $vals.FnId = Read-Value 'R2_FN 的 Access Key ID' "令牌「柠檬记 $label functions」生成后的页面（授四个桶，读写）" '^[0-9a-f]{32}$' '32 位十六进制'
    $vals.FnSk = Read-Value 'R2_FN 的 Secret Access Key' '同一页' '^[0-9a-f]{64}$' '64 位十六进制'
    if ($vals.FilesId -eq $vals.FnId) { Fail 'R2_FILES 和 R2_FN 贴成了同一把令牌：两把要分开生成（权限范围不同）' }
    $vals.UrlSecret = New-RandomHex32
    Ok 'FILES_URL_SECRET 已在内存里生成（32 字节随机，不显示）'

    Step "写入 Cloudflare Pages：$pages › 生产环境"
    $envVars = [ordered]@{
        R2_ENDPOINT                = @{ type = 'plain_text'; value = $endpoint }
        R2_FILES_ACCESS_KEY_ID     = @{ type = 'secret_text'; value = $vals.FilesId }
        R2_FILES_SECRET_ACCESS_KEY = @{ type = 'secret_text'; value = $vals.FilesSk }
        FILES_URL_SECRET           = @{ type = 'secret_text'; value = $vals.UrlSecret }
    }
    if ($prefix) { $envVars.R2_BUCKET_PREFIX = @{ type = 'plain_text'; value = $prefix } }
    $body = @{ deployment_configs = @{ production = @{ env_vars = $envVars } } } | ConvertTo-Json -Depth 6 -Compress
    $null = Invoke-Api PATCH "https://api.cloudflare.com/client/v4/accounts/$acct/pages/projects/$pages" $cfH $body
    $body = $null; $envVars = $null
    $after = Invoke-Api GET "https://api.cloudflare.com/client/v4/accounts/$acct/pages/projects/$pages" $cfH ''
    $ev = Get-ProdEnvVars $after.result
    $names = @(); if ($ev) { $names = @($ev.PSObject.Properties.Name) }
    $lost = @($before | Where-Object { $names -notcontains $_ })
    if ($lost.Count) { Fail "写入后原有的变量不见了：$($lost -join '、')。请按第 ⑧ 节把它们重新填上，并在聊天里告诉运维（接口的合并方式和文档不一样）" }
    foreach ($n in 'R2_FILES_ACCESS_KEY_ID', 'R2_FILES_SECRET_ACCESS_KEY', 'FILES_URL_SECRET') {
        if ($names -notcontains $n -or $ev.$n.type -ne 'secret_text') { Fail "Pages 上 $n 没写成加密变量" }
    }
    if ($names -notcontains 'R2_ENDPOINT') { Fail 'Pages 上没有 R2_ENDPOINT' }
    Ok "已写入 Pages：R2_ENDPOINT$(if ($prefix) { '、R2_BUCKET_PREFIX' })（文本），R2_FILES_ACCESS_KEY_ID、R2_FILES_SECRET_ACCESS_KEY、FILES_URL_SECRET（加密）；原有变量都在"

    Step "写入 Supabase：$supaName › Edge Functions › Secrets"
    $list = @(
        @{ name = 'R2_ENDPOINT'; value = $endpoint },
        @{ name = 'R2_FN_ACCESS_KEY_ID'; value = $vals.FnId },
        @{ name = 'R2_FN_SECRET_ACCESS_KEY'; value = $vals.FnSk }
    )
    if ($prefix) { $list += @{ name = 'R2_BUCKET_PREFIX'; value = $prefix } }
    $body = ConvertTo-Json -InputObject $list -Compress
    $null = Invoke-Api POST "https://api.supabase.com/v1/projects/$ref/secrets" $sbH $body
    $body = $null; $list = $null
    $have = @((Invoke-Api GET "https://api.supabase.com/v1/projects/$ref/secrets" $sbH '') | ForEach-Object { $_.name })
    foreach ($n in 'R2_ENDPOINT', 'R2_FN_ACCESS_KEY_ID', 'R2_FN_SECRET_ACCESS_KEY') { if ($have -notcontains $n) { Fail "Supabase 上没有 $n" } }
    Ok "已写入 Supabase：R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY$(if ($prefix) { '、R2_BUCKET_PREFIX' })"

    Say ''
    Say "全部写好。Pages 的变量只对之后的部署生效：在聊天里说「第 ⑫ 节 $label 的令牌写好了」，主持人会安排重新部署一次。"
    if ($Target -eq 'preview') { Say '别忘了：到 Cloudflare 和 Supabase 把这次临时生成的两把管理令牌删掉（第 ⑫ 节）。' }
}
finally {
    foreach ($k in @($vals.Keys)) { $vals[$k] = $null }
    $vals = $null; $cfTok = $null; $sbTok = $null; $cfH = $null; $sbH = $null
    Clear-Clip
    if ($shown) {
        Clear-Host
        [Console]::Write("$([char]27)[3J")
    }
    [GC]::Collect()
    Write-Host '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。' -ForegroundColor Green
}
