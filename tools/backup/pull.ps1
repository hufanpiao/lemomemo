<#
.SYNOPSIS
  把服务器备份拉回本机（架构第 10 节“拉回本机”1～4 步；ADR-016；TC-B7a-06、07、26）。函数在 backup-lib.ps1，测试在 tests/build/backup-pull.test.ts。

.DESCRIPTION
  Windows 任务计划程序每天 09:00 运行（错过了开机补跑）；publish.ps1 发版前也调它（见 -WaitForToday、-ExpectCount、-Snapshot、-SkipFiles、-SkipCleanup）。做这几件事：
    1. 调 backup-manifest（https://lemomemo.com/sb/functions/v1/backup-manifest，Authorization: Bearer <BACKUP_PULL_TOKEN>）：先拿目录
       （服务器算的首尔今天、最近 7 个日期、deleted_accounts），再按日期一页页拿（每页最多 50 人，拿到一页就下这一页；B7a 复审第 5 条），
       “今天”不用本机时钟：没带 -Today 就用服务器给的（publish.ps1 传数据库给的首尔日期，复审第 7 条）。
       把做完了的（有 _manifest）下载到 E:\柠檬记-备份\每日\<日期>\<user_id>\：每次先重下 _manifest，本机已有的同一份（_manifest 的 sha256 一样、
       它列的每个文件 sha256 都对上）才跳过（B7a 评审第 4 条：原来只比大小，同样大小的新备份会被当成旧的）；否则只下 _manifest 列的文件
       （服务器上新旧两代数据文件可能同时在），在临时文件夹里逐个核对字节数和 sha256，全对才换进去：旧目录先改名 .旧-<user_id>、新的换入、再删旧的
       （B7a 评审第 9 条：原来先删再改名，改名失败就两头都没了）。每个日期文件夹写 清单.json。没做完的（没有 _manifest）不下载，写进 失败原因.txt。
       -WaitForToday -ExpectCount <n> -Since <时刻>：等首尔当天有 n 个账号在 Since 之后写了新的 _manifest（n 是 publish.ps1 触发时
       private.backup_dispatch 实际发了请求的人数，B7a 评审第 7 条）；这时当天别的没做完的（停用、冷静期、早先半途而废的目录）只记提示，不算失败、不挡 -Snapshot。
       等待用不签名的页、单独计数（复审第 6 条），间隔至少 2 分钟，人多时按 wait_hourly 拉长（1000 个账号 150 秒，Get-PollSeconds）。
       全部成功（退出码 0）时最后调一次 {done: true}，服务器写心跳 backup-pull，lemo-ops 超过 26 小时没写就告警（复审第 8 条）。
    2. 每周日（或上次同步已满 7 天、或带 -SyncFiles）按 ETag 增量拉 R2 的 images、vault-images → 图片\<user_id>\，files、vault-files → 附件\<user_id>\；
       只下载、从不删远端；远端已删的本机文件留 30 天。令牌 R2_PULL_*（只读）。
    3. 按 deleted_accounts 清理本机所有历史备份（每日、发布前、图片、附件），过三道保险（backup-lib.ps1 的 Get-DeletionPlan）：
       任何一道不过一个都不删，写 需要人工确认.txt，退出码 3。删了的写进 删除记录.txt（只写 user_id 和日期）。
    4. 每日备份留 30 天；发布前、版本前的长期保留。
    -SkipCleanup 跳过第 3、4 步（publish.ps1 发版前用：三道保险拦下、退出码 3 和发版无关，留给每天 09:00 那一轮，B7a 评审第 8 条）。
  凭据（Windows 凭据管理器，读写经 tools/keys/cred.ps1；不进命令行参数、不写文件、不打印）：
    lemomemo.backup.pull（BACKUP_PULL_TOKEN）：由 tools/keys/set-backup-pull-token.ps1 本机生成、同时写进函数 secret 和这里，满 90 天本脚本提醒轮换；
    lemomemo.backup.r2-pull（R2_PULL_ACCESS_KEY_ID 存用户名、R2_PULL_SECRET_ACCESS_KEY 存密码）：-Setup 时由负责人本人粘贴（先过 safe-window.ps1 的安全窗口检查）。
  每天 09:00 的计划任务由 tools/backup/register-pull-task.ps1 注册（负责人本人运行一次）。
  配置 E:\柠檬记-备份\配置.json（第一次运行自动生成模板）：protected_user_ids（负责人自己的 user_id，必填）、r2_endpoint、r2_bucket_prefix。
  退出码：0 成功；1 本机问题（配置、凭据、参数）；2 服务器或网络失败（写 失败原因.txt）；3 需要人工确认（三道保险拦下）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup\pull.ps1 -Setup
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup\pull.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup\pull.ps1 -WaitForToday -Since 2026-12-02T09:00:00Z -Snapshot v4.0.0
#>
[CmdletBinding()]
param(
    [switch]$Setup,
    [string]$Root = 'E:\柠檬记-备份',
    [string]$Today = '',
    [switch]$WaitForToday,
    [string]$Since = '',
    [int]$WaitMinutes = 60,
    [string]$Snapshot = '',
    [switch]$SyncFiles,
    [switch]$SkipFiles,
    [switch]$SkipCleanup,
    [int]$ExpectCount = -1,
    [string[]]$ApproveDeletion = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'backup-lib.ps1')
# 凭据管理器读写、Read-Secret（B7a 复审“重复和简化”：原来本文件、set-r2-tokens.ps1、claude-intake/add.ps1 各抄一份）
. (Join-Path $PSScriptRoot '..\keys\cred.ps1')
# 安全窗口检查（-Setup 粘贴令牌前用；B7a 复审第 14 条，和 tools/keys 下的密钥脚本同一份，tests/build/keys-guard-sync.test.ts 核对）
$SafeWindow = Join-Path $PSScriptRoot '..\keys\safe-window.ps1'
if (-not (Test-Path -LiteralPath $SafeWindow -PathType Leaf)) { throw "已停止：缺少 $SafeWindow（安全窗口检查），请从仓库完整取出 tools\keys 目录" }
. $SafeWindow

$ManifestUrl = 'https://lemomemo.com/sb/functions/v1/backup-manifest'
$SignedRe = '^https://[a-z0-9]{20}\.supabase\.co/storage/v1/object/sign/backups/'
$R2Re = '^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com$'
$PollSeconds = -1    # 等当天备份时多久问一轮：按每轮页数和 backup-manifest 的 wait_hourly 算（Get-PollSeconds），测试可以写死
$UA = 'lemomemo-tools/4.0 (PowerShell)'
# 只给本机自测用：LEMO_BACKUP_TEST=1 时清单、下载、R2 地址只认 http://127.0.0.1:<端口>，凭据从测试环境变量读，不碰凭据管理器
$TestMode = [Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST') -eq '1'
if ($TestMode) {
    $ManifestUrl = [Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST_MANIFEST')
    if ($ManifestUrl -notmatch '^http://127\.0\.0\.1:[0-9]{2,5}/[A-Za-z0-9/_-]*$') { throw '测试地址只认 http://127.0.0.1' }
    $SignedRe = '^http://127\.0\.0\.1:[0-9]{2,5}/'
    $R2Re = '^http://127\.0\.0\.1:[0-9]{2,5}$'
    $PollSeconds = [int]([Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST_POLL'))
}

function Fail([string]$Msg, [int]$Code = 1) {
    [Console]::Error.WriteLine("pull.ps1：$Msg")
    if ($Code -eq 2 -and (Test-Path -LiteralPath $Root)) { Add-BackupNote $Root '失败原因.txt' @($Msg) (Get-Date) }
    exit $Code
}
function Say([string]$Msg) { Write-Output $Msg }
function Ok([string]$Msg) { Write-Output "  ✔ $Msg" }
function Short([string]$Id) { $Id.Substring(0, 8) }

# 凭据：测试模式从测试环境变量读（不碰凭据管理器），平时经 tools/keys/cred.ps1 读；回 @(用户名, 值, 最后写入时刻)，没有回 $null
function Get-Cred([string]$Target, [string]$TestUser, [string]$TestSecret) {
    if ($TestMode) { return @([Environment]::GetEnvironmentVariable($TestUser), [Environment]::GetEnvironmentVariable($TestSecret), $null) }
    $c = Read-LemoCred $Target
    if (-not $c) { return $null }
    return @($c.User, $c.Secret, $c.LastWritten)
}

$ConfigPath = Join-Path $Root '配置.json'
$ConfigTemplate = @'
{
  "protected_user_ids": [],
  "r2_endpoint": "https://<Cloudflare 账号 ID>.r2.cloudflarestorage.com",
  "r2_bucket_prefix": ""
}
'@

# ───────────────────────── -Setup：存凭据（负责人本人运行） ─────────────────────────
if ($Setup) {
    if ($TestMode) { Fail '测试模式不做 -Setup' 1 }
    [void](New-Item -ItemType Directory -Force -Path $Root)
    if (-not (Test-Path -LiteralPath $ConfigPath)) { [IO.File]::WriteAllText($ConfigPath, $ConfigTemplate, (New-Object System.Text.UTF8Encoding($false))) }
    # 剪贴板历史关着、没有 transcript 和日志策略才往下读令牌（B7a 复审第 14 条）
    Assert-NoRecording
    # BACKUP_PULL_TOKEN 不在这里粘贴：由 tools\keys\set-backup-pull-token.ps1 本机生成，同时写进函数 secret 和凭据管理器（B7a 复审第 8 条）
    $id = Read-Secret '粘贴 R2_PULL_ACCESS_KEY_ID（只读令牌的 Access Key ID），回车'
    $sk = Read-Secret '粘贴 R2_PULL_SECRET_ACCESS_KEY，回车'
    if ($id.Length -lt 16 -or $sk.Length -lt 32) { Fail 'R2 只读令牌不对' 1 }
    Write-LemoCred 'lemomemo.backup.r2-pull' $id $sk; $id = $null; $sk = $null
    try { Set-Clipboard -Value ' ' } catch { }
    Say "R2 只读令牌已存进 Windows 凭据管理器（lemomemo.backup.r2-pull）。请打开 $ConfigPath，在 protected_user_ids 里填上你自己的 user_id、填好 r2_endpoint。"
    if (-not (Read-LemoCred 'lemomemo.backup.pull')) { Say '凭据管理器里还没有 lemomemo.backup.pull：运行 tools\keys\set-backup-pull-token.ps1 -Target prod 生成。' }
    exit 0
}

# ───────────────────────── 读配置、凭据 ─────────────────────────
if (-not (Test-Path -LiteralPath $Root)) { Fail "备份文件夹 $Root 不存在：先运行 -Setup" 1 }
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    [IO.File]::WriteAllText($ConfigPath, $ConfigTemplate, (New-Object System.Text.UTF8Encoding($false)))
    Fail "已生成 $ConfigPath 模板：填上 protected_user_ids（你自己的 user_id）和 r2_endpoint 后再运行" 1
}
$cfg = ConvertFrom-JsonDict ([IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8))
$Protected = [string[]]@(Get-DictValue $cfg 'protected_user_ids' | Where-Object { $_ -cmatch $script:UuidRe })
$R2Endpoint = [string](Get-DictValue $cfg 'r2_endpoint')
$R2Prefix = [string](Get-DictValue $cfg 'r2_bucket_prefix')
if ($R2Prefix -notmatch '^[a-z0-9-]{0,20}$') { Fail '配置.json 的 r2_bucket_prefix 不对' 1 }
if ($ApproveDeletion | Where-Object { $_ -cnotmatch $script:UuidRe }) { Fail '-ApproveDeletion 只收 user_id（小写 uuid）' 1 }

$tok = Get-Cred 'lemomemo.backup.pull' 'LEMO_BACKUP_TEST_USER' 'LEMO_BACKUP_TEST_TOKEN'
if (-not $tok -or -not $tok[1]) { Fail '凭据管理器里没有 lemomemo.backup.pull：先运行 tools\keys\set-backup-pull-token.ps1 -Target prod' 1 }
$Token = $tok[1]
$RotateNote = Get-RotateNote $tok[2] ([datetime]::UtcNow)   # 满 90 天提醒轮换（B7a 复审第 8 条）
$tok = $null

if ($Today -and $Today -notmatch $script:DateRe) { Fail '-Today 要写 yyyy-MM-dd' 1 }
$SinceUtc = $null
if ($Since) { try { $SinceUtc = ConvertTo-UtcTime $Since } catch { Fail '-Since 要写 ISO 时刻（如 2026-12-02T09:00:00Z）' 1 } }
if ($WaitForToday -and $ExpectCount -lt 0) { Fail '-WaitForToday 要带 -ExpectCount（这次实际发了备份请求的人数）' 1 }
if (-not $WaitForToday -and $ExpectCount -ge 0) { Fail '-ExpectCount 只和 -WaitForToday 一起用' 1 }

# ───────────────────────── 1. 清单（backup-manifest：目录 → 按日期一页页拿；B7a 复审第 5 条） ─────────────────────────
# $Body 是请求体（哈希表）：@{} 目录；@{date; after} 一页；@{date; after; wait=$true} 等待用的一页（不签名）；@{done=$true} 拉完写心跳
function Invoke-Manifest([hashtable]$Body) {
    $p = @{ Uri = $ManifestUrl; Method = 'Post'; Headers = @{ Authorization = "Bearer $Token" }; ContentType = 'application/json'; Body = ($Body | ConvertTo-Json -Compress)
        UseBasicParsing = $true; UserAgent = $UA; TimeoutSec = 60; ErrorAction = 'Stop' }
    try {
        $r = Invoke-WebRequest @p
    } catch {
        $st = $null
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
        if ($st -eq 429) { return 'rate_limited' }
        if ($st -eq 401) { Fail 'backup-manifest 回 401：BACKUP_PULL_TOKEN 不对，重新 -Setup' 2 }
        Fail "调 backup-manifest 失败（$(if ($st) { "HTTP $st" } else { '网络' })）" 2
    }
    $bytes = $r.RawContentStream.ToArray()
    return ConvertFrom-JsonDict ([Text.Encoding]::UTF8.GetString($bytes))
}

$MaxPages = 1000   # 一天最多翻几页（PAGE_USERS 50 × 1000 = 5 万个账号）；服务器的 next 不往前走时也靠它停下
# 一天的清单一页页往管道里送（拿到一页就处理这一页，签名链接 5 分钟有效）；次数用完送一个 'rate_limited' 就停
function Get-DayPages([string]$Date, [bool]$Wait) {
    $after = $null
    for ($i = 0; $i -lt $MaxPages; $i++) {
        $pg = Invoke-Manifest @{ date = $Date; after = $after; wait = $Wait }
        Write-Output -NoEnumerate $pg
        if ($pg -is [string]) { return }
        $next = Get-DictValue $pg 'next'
        if (-not ($next -is [string]) -or -not $next) { return }
        if ($after -and [string]::CompareOrdinal($next, $after) -le 0) { Fail 'backup-manifest 的翻页游标没往前走' 2 }
        $after = $next
    }
    Fail "backup-manifest 的 $Date 超过 $MaxPages 页" 2
}

$Ix = Invoke-Manifest @{}
if ($Ix -is [string]) { Fail 'backup-manifest 这个小时的次数用完了，过一会儿再跑' 2 }
# 今天按服务器给的首尔日期（B7a 复审第 7 条：不用本机时钟；publish.ps1 另传数据库给的 -Today）
if (-not $Today) { $Today = [string](Get-DictValue $Ix 'today') }
if ($Today -notmatch $script:DateRe) { Fail 'backup-manifest 没给今天的日期' 2 }
$TodayDate = [datetime]::ParseExact($Today, 'yyyy-MM-dd', $script:Inv)
$TodayS = $Today
$Dates = [string[]]@(Get-DictValue $Ix 'dates' | Where-Object { $_ -is [string] -and $_ -match $script:DateRe })
$WaitHourly = Get-DictValue (Get-DictValue $Ix 'limits') 'wait_hourly'
# 等待间隔：至少 2 分钟；一轮要 p 页时，一小时最多用 wait_hourly 的 80%（1000 个账号 20 页 → 150 秒，一小时 480 次 < 600）
function Get-PollSeconds([int]$Pages) {
    if ($PollSeconds -ge 0) { return $PollSeconds }
    if (-not ($WaitHourly -is [int] -or $WaitHourly -is [long]) -or $WaitHourly -le 0) { return 120 }
    return [int][math]::Max(120, [math]::Ceiling(3600.0 * [math]::Max(1, $Pages) / ($WaitHourly * 0.8)))
}

# 这个账号的 _manifest 是 Since 之后写的（manifest_at 为空、不是时刻都算没做完，不抛错：原来空值直接让脚本以退出码 1 结束，说成本机问题）
function Test-Fresh($User) {
    if (-not (Get-DictValue $User 'complete')) { return $false }
    if (-not $SinceUtc) { return $true }
    $at = Get-DictValue $User 'manifest_at'
    if (-not ($at -is [string]) -or -not $at) { return $false }
    try { return (ConvertTo-UtcTime $at) -ge $SinceUtc } catch { return $false }
}

$started = [datetime]::UtcNow
$FreshIds = [string[]]@()
while ($WaitForToday) {
    $pgs = @(Get-DayPages $TodayS $true)
    $pages = $pgs.Count
    if (-not @($pgs | Where-Object { $_ -is [string] })) {
        $users = @($pgs | ForEach-Object { Get-DictValue $_ 'users' })
        $FreshIds = [string[]]@($users | Where-Object { Test-Fresh $_ } | ForEach-Object { [string](Get-DictValue $_ 'user_id') })
        if ($FreshIds.Count -ge $ExpectCount) { Say "当天（$TodayS）这次发了请求的 $ExpectCount 个账号都做完了"; break }
        Say "等当天备份：$($FreshIds.Count)/$ExpectCount 个做完"
    }
    if (([datetime]::UtcNow - $started).TotalMinutes -ge $WaitMinutes) { Fail "等了 $WaitMinutes 分钟，当天备份还没全部做完（$($FreshIds.Count)/$ExpectCount）" 2 }
    Start-Sleep -Seconds (Get-PollSeconds $pages)
}

$Deleted = [string[]]@(Get-DictValue $Ix 'deleted_accounts' | ForEach-Object { [string](Get-DictValue $_ 'user_id') } | Where-Object { $_ -cmatch $script:UuidRe })
$failures = New-Object 'Collections.Generic.List[string]'
$notes = New-Object 'Collections.Generic.List[string]'
if ($RotateNote) { $notes.Add($RotateNote); Say $RotateNote }

# ───────────────────────── 下载 ─────────────────────────
function Get-BackupFile([string]$Url, [string]$OutFile) {
    if ($Url -notmatch $SignedRe) { throw '下载链接的地址不对' }
    try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -UserAgent $UA -TimeoutSec 300 -ErrorAction Stop | Out-Null }
    catch { throw '下载失败（链接 5 分钟有效，过期了就重跑）' }
}

# _manifest 列的数据文件：[{ name, bytes, sha256 }]；文件名不认识、不是这一代的直接报错
function Get-ListedFiles($Man) {
    $gen = [string](Get-DictValue $Man 'gen')
    if ($gen -cnotmatch '^[ab]$') { throw '_manifest 没写这一次的数据文件是哪一代（gen）' }
    $out = New-Object 'Collections.Generic.List[object]'
    foreach ($t in @(Get-DictValue $Man 'tables')) {
        foreach ($f in @(Get-DictValue $t 'files')) {
            $name = [string](Get-DictValue $f 'name')
            if ($name -cnotmatch $script:BackupFileRe -or $name -eq '_manifest.json.gz' -or -not $name.StartsWith("${gen}_")) { throw "_manifest 里有不认识的文件名" }
            $out.Add([pscustomobject]@{ Name = $name; Bytes = Get-DictValue $f 'bytes'; Sha256 = [string](Get-DictValue $f 'sha256') })
        }
    }
    return , $out.ToArray()
}

function Test-FilesMatch([string]$Dir, $Listed) {
    foreach ($f in $Listed) {
        $p = Join-Path $Dir $f.Name
        if (-not (Test-Path -LiteralPath $p)) { return $false }
        if ((Get-Item -LiteralPath $p).Length -ne $f.Bytes -or (Get-FileSha256Hex $p) -ne $f.Sha256) { return $false }
    }
    return $true
}

function Save-UserBackup([string]$Date, $User) {
    $uid = [string](Get-DictValue $User 'user_id')
    $byName = @{}
    foreach ($f in @(Get-DictValue $User 'files')) { $byName[[string](Get-DictValue $f 'name')] = [string](Get-DictValue $f 'url') }
    if (-not $byName.ContainsKey('_manifest.json.gz')) { throw '清单里没有 _manifest' }
    $dayDir = Join-Path (Join-Path $Root '每日') $Date
    $final = Join-Path $dayDir $uid
    $tmp = Join-Path $dayDir ".下载中-$uid"
    $old = Join-Path $dayDir ".旧-$uid"
    # 上一次换目录停在半路（旧的改了名、新的没换进来）：先把旧的改回来，再清掉残留
    if (-not (Test-Path -LiteralPath $final) -and (Test-Path -LiteralPath $old)) { Rename-Item -LiteralPath $old -NewName $uid }
    foreach ($d in @($tmp, $old)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }
    [void](New-Item -ItemType Directory -Force -Path $tmp)
    try {
        # 每次都先重下 _manifest（小文件）：它是这一次备份的提交点，列着每个数据文件的 sha256
        $manPath = Join-Path $tmp '_manifest.json.gz'
        Get-BackupFile $byName['_manifest.json.gz'] $manPath
        $man = ConvertFrom-JsonDict (Expand-GzipText ([IO.File]::ReadAllBytes($manPath)))
        if ((Get-DictValue $man 'format') -ne 'lemomemo-backup-manifest' -or (Get-DictValue $man 'user_id') -ne $uid -or (Get-DictValue $man 'date') -ne $Date) { throw '_manifest 的格式、user_id 或日期不对' }
        $listed = Get-ListedFiles $man
        # 本机已有同一份：_manifest 一字不差，它列的每个文件 sha256 都对上
        $localMan = Join-Path $final '_manifest.json.gz'
        if ((Test-Path -LiteralPath $localMan) -and (Get-FileSha256Hex $localMan) -eq (Get-FileSha256Hex $manPath) -and (Test-FilesMatch $final $listed)) {
            Remove-Item -LiteralPath $tmp -Recurse -Force
            return 'kept'
        }
        foreach ($f in $listed) {
            if (-not $byName.ContainsKey($f.Name)) { throw "服务器上缺文件 $($f.Name)" }
            Get-BackupFile $byName[$f.Name] (Join-Path $tmp $f.Name)
        }
        foreach ($f in $listed) {
            $p = Join-Path $tmp $f.Name
            if ((Get-Item -LiteralPath $p).Length -ne $f.Bytes -or (Get-FileSha256Hex $p) -ne $f.Sha256) { throw "$($f.Name) 的 sha256 对不上" }
        }
    } catch {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        throw
    }
    # 换目录：旧的先改名、新的换入、再删旧的；换入失败把旧的改回来（任何时刻本机至少有一份完整的）
    if (Test-Path -LiteralPath $final) { Rename-Item -LiteralPath $final -NewName ".旧-$uid" }
    try {
        Rename-Item -LiteralPath $tmp -NewName $uid
    } catch {
        if (Test-Path -LiteralPath $old) { Rename-Item -LiteralPath $old -NewName $uid }
        throw '换入新下载的备份失败（旧的已留着）'
    }
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
    return 'downloaded'
}

$down = 0; $kept = 0
$serverToday = New-Object 'Collections.Generic.List[string]'   # 服务器当天有目录的人（第 3 步三道保险的 ③）
foreach ($date in $Dates) {
    $dayDir = Join-Path (Join-Path $Root '每日') $date
    $index = New-Object 'Collections.Generic.List[object]'
    Get-DayPages $date $false | ForEach-Object {
        if ($_ -is [string]) { Fail "backup-manifest 这个小时的次数用完了（$date 没拉完），过一会儿再跑" 2 }
        foreach ($u in @(Get-DictValue $_ 'users')) {
            if ($date -eq $TodayS) { $serverToday.Add([string](Get-DictValue $u 'user_id')) }
            $uid = [string](Get-DictValue $u 'user_id')
            if ($uid -cnotmatch $script:UuidRe -or $Deleted -contains $uid) { continue }
            if (-not (Get-DictValue $u 'complete')) {
                # 等发版时（-WaitForToday）只认这次发了请求、已经做完的那几个；别的当天没做完的只记提示（停用、冷静期、早先半途而废的目录）
                if ($date -eq $TodayS -and $WaitForToday) { $notes.Add("提示：$date $(Short $uid) 的服务器备份没做完（这次没发请求或早先没做完），没下载") }
                elseif ($date -eq $TodayS) { $failures.Add("$date $(Short $uid) 的服务器备份没做完（没有 _manifest），没下载") }
                continue
            }
            [void](New-Item -ItemType Directory -Force -Path $dayDir)
            try {
                $res = Save-UserBackup $date $u
                if ($res -eq 'kept') { $kept++ } else { $down++ }
                $index.Add([ordered]@{ user_id = $uid; files = @(Get-DictValue $u 'files' | ForEach-Object { [ordered]@{ name = Get-DictValue $_ 'name'; bytes = Get-DictValue $_ 'bytes' } }) })
            } catch { $failures.Add("$date $(Short $uid)：$($_.Exception.Message)") }
        }
    }
    if ($index.Count -gt 0) {
        $doc = [ordered]@{ '日期' = $date; '拉取时间' = [datetime]::UtcNow.ToString('o', $script:Inv); '账号' = $index.ToArray() }
        [IO.File]::WriteAllText((Join-Path $dayDir '清单.json'), ($doc | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    }
}
Say "下载：新下 $down 份、已有 $kept 份"

# 发布前的备份：把当天的复制一份长期保留（publish.ps1 第 2 步用）
if ($Snapshot) {
    if ($Snapshot -notmatch '^[A-Za-z0-9._-]{1,40}$') { Fail '-Snapshot 只收 tag 一类的名字' 1 }
    $src = Join-Path (Join-Path $Root '每日') $TodayS
    $dst = Join-Path (Join-Path $Root '发布前') "${TodayS}_$Snapshot"
    # 这次做完的人都要已经下到本机（deleted_accounts 里的本来就不下载）
    $missingFresh = @($FreshIds | Where-Object { $Deleted -notcontains $_ -and -not (Test-Path -LiteralPath (Join-Path (Join-Path $src $_) '_manifest.json.gz')) })
    $noneExpected = $WaitForToday -and $ExpectCount -eq 0   # 这次一个请求都没发（没有可用账号）：发布前备份是空的，不算失败
    if ((-not (Test-Path -LiteralPath $src) -and -not $noneExpected) -or $missingFresh.Count -gt 0 -or @($failures | Where-Object { $_.StartsWith($TodayS) }).Count -gt 0) { Fail '当天备份没有全部下载成功，不做发布前备份' 2 }
    if (Test-Path -LiteralPath $dst) { Fail "发布前备份 $dst 已经有了，不覆盖" 1 }
    [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst))
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dst -Recurse } else { [void](New-Item -ItemType Directory -Path $dst) }
    Say "发布前备份：$dst"
}

# ───────────────────────── 2. R2 图片和附件 ─────────────────────────
$syncMark = Join-Path $Root '上次同步图片附件.txt'
$last = if (Test-Path -LiteralPath $syncMark) { ([IO.File]::ReadAllText($syncMark)).Trim() } else { '' }
$due = $TodayDate.DayOfWeek -eq [DayOfWeek]::Sunday -or -not ($last -match $script:DateRe) -or ($TodayDate - [datetime]::ParseExact($last, 'yyyy-MM-dd', $script:Inv)).TotalDays -ge 7
if (-not $SkipFiles -and ($due -or $SyncFiles)) {
    if ($R2Endpoint -notmatch $R2Re) { $failures.Add('配置.json 的 r2_endpoint 不对，图片和附件没同步') }
    else {
        $r2 = Get-Cred 'lemomemo.backup.r2-pull' 'LEMO_BACKUP_TEST_R2_ID' 'LEMO_BACKUP_TEST_R2_SECRET'
        if (-not $r2 -or -not $r2[0] -or -not $r2[1]) { $failures.Add('凭据管理器里没有 lemomemo.backup.r2-pull，图片和附件没同步') }
        else {
            try {
                $s = Sync-R2Files -Root $Root -Endpoint $R2Endpoint -Prefix $R2Prefix -AccessKey $r2[0] -Secret $r2[1] -Today $TodayDate -Skip $Deleted
                [IO.File]::WriteAllText($syncMark, $TodayS)
                Say "图片和附件：新下 $($s.Downloaded) 个、没变 $($s.Kept) 个、远端已删满 30 天清掉 $($s.Expired) 个"
            } catch { $failures.Add("图片和附件同步失败：$($_.Exception.Message)") }
            $r2 = $null
        }
    }
}

$needConfirm = $false
if ($SkipCleanup) {
    Say '跳过按注销清理和 30 天保留（-SkipCleanup；每天 09:00 那一轮照做）'
} else {
    # ───────────────────────── 3. 按 deleted_accounts 清理（三道保险） ─────────────────────────
    $plan = Get-DeletionPlan -Deleted $Deleted -ServerToday ([string[]]$serverToday.ToArray()) -TodayKnown ($Dates -contains $TodayS) -LocalUsers (Get-LocalUserIds $Root) -Protected $Protected -Approved $ApproveDeletion
    $needConfirm = @($plan.Problems).Count -gt 0
    if ($needConfirm) {
        Add-BackupNote $Root '需要人工确认.txt' (@('这次没有删任何账号的本机备份，原因：') + $plan.Problems) (Get-Date)
        Say "需要人工确认：$(@($plan.Problems).Count) 条，见 $(Join-Path $Root '需要人工确认.txt')"
    } else {
        foreach ($id in @($plan.Delete)) { $n = Remove-UserEverywhere $Root $id (Get-Date); Say "已删 $(Short $id) 的本机备份（$n 处）" }
    }

    # ───────────────────────── 4. 每日备份留 30 天 ─────────────────────────
    $old = @(Remove-OldDaily $Root $TodayDate)
    if ($old.Count -gt 0) { Say "删掉超过 30 天的每日备份：$($old -join '、')" }
}

# 全部成功（没有失败、没有要人工确认的）才写心跳 backup-pull：lemo-ops 超过 26 小时没写就告警（B7a 复审第 8 条）
if ($failures.Count -eq 0 -and -not $needConfirm) {
    $hb = Invoke-Manifest @{ done = $true }
    if ($hb -is [string]) { $failures.Add('备份都拉完了，但 backup-manifest 次数用完、心跳没写上（lemo-ops 26 小时后会报“停了”）') }
    else { Say '已写心跳 backup-pull' }
}
$Token = $null
if ($notes.Count) { Add-BackupNote $Root '失败原因.txt' $notes.ToArray() (Get-Date); Say "$($notes.Count) 条提示（不算失败），见 $(Join-Path $Root '失败原因.txt')" }
if ($failures.Count) {
    Add-BackupNote $Root '失败原因.txt' $failures.ToArray() (Get-Date)
    [Console]::Error.WriteLine("pull.ps1：$($failures.Count) 项没成功，见 $(Join-Path $Root '失败原因.txt')")
    exit 2
}
if ($needConfirm) { exit 3 }
Say '完成'
exit 0
