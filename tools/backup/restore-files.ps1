<#
.SYNOPSIS
  把本机备份的图片和附件按原路径传回 R2（架构第 10 节“恢复 R2 里的文件”；上线与回滚手册第 3 层第 7 步、“R2 不可用”第 3 条第 4 步）。

.DESCRIPTION
  从 E:\柠檬记-备份\图片\<user_id>\<桶>\…、附件\<user_id>\<桶>\…（pull.ps1 拉下来的结构）读，传回 <前缀><桶>/<user_id>/…。
  两把令牌分开用（B7a 复审第 13 条）：
    • 试运行（默认）只用 pull.ps1 存在凭据管理器里的 R2 只读令牌 lemomemo.backup.r2-pull 列远端（经 tools/keys/cred.ps1 读），不要写令牌；
    • 加 -Execute：先照样用只读令牌列出、打印要传几个，再按提示粘贴写令牌（Read-Host -AsSecureString，不进命令行参数、不写文件、不打印），
      写令牌只用来 PUT。写令牌由负责人在 Cloudflare 临时生成（只授要恢复的桶），看过试运行的数再生成，用完立即吊销，记进过程记录。
  远端已有、大小和 MD5（ETag）都一样的跳过，可以放心重跑。
  传完请跑一遍 file-check 补扫，核对 sha256（架构第 10 节）。函数在 backup-lib.ps1，测试在 tests/build/backup-pull.test.ts。
  退出码：0 成功；1 参数或本机问题；2 R2 失败。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup\restore-files.ps1 -User <user_id>
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup\restore-files.ps1 -User <user_id> -Bucket images -Execute
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$User,
    [string]$Root = 'E:\柠檬记-备份',
    [ValidateSet('', 'images', 'vault-images', 'files', 'vault-files')][string]$Bucket = '',
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'backup-lib.ps1')
. (Join-Path $PSScriptRoot '..\keys\cred.ps1')

$R2Re = '^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com$'
$TestMode = [Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST') -eq '1'
if ($TestMode) { $R2Re = '^http://127\.0\.0\.1:[0-9]{2,5}$' }
$Types = @{ '.webp' = 'image/webp'; '.pdf' = 'application/pdf'; '.doc' = 'application/msword'; '.xls' = 'application/vnd.ms-excel'; '.ppt' = 'application/vnd.ms-powerpoint'
    '.docx' = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; '.xlsx' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    '.pptx' = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; '.docm' = 'application/vnd.ms-word.document.macroEnabled.12'
    '.xlsm' = 'application/vnd.ms-excel.sheet.macroEnabled.12'; '.pptm' = 'application/vnd.ms-powerpoint.presentation.macroEnabled.12' }

function Fail([string]$Msg, [int]$Code) { [Console]::Error.WriteLine("restore-files.ps1：$Msg"); exit $Code }
function Say([string]$Msg) { Write-Output $Msg }

if ($User -cnotmatch $script:UuidRe) { Fail '-User 要写 user_id（小写 uuid）' 1 }
$cfgPath = Join-Path $Root '配置.json'
if (-not (Test-Path -LiteralPath $cfgPath)) { Fail "没有 $cfgPath（pull.ps1 -Setup 生成）" 1 }
$cfg = ConvertFrom-JsonDict ([IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8))
$Endpoint = [string](Get-DictValue $cfg 'r2_endpoint')
$Prefix = [string](Get-DictValue $cfg 'r2_bucket_prefix')
if ($Endpoint -notmatch $R2Re) { Fail '配置.json 的 r2_endpoint 不对' 1 }
if ($Prefix -notmatch '^[a-z0-9-]{0,20}$') { Fail '配置.json 的 r2_bucket_prefix 不对' 1 }

# 本机有哪些文件（_索引.tsv 记着桶和原始键；没有索引的按文件夹结构推）
$todo = New-Object 'Collections.Generic.List[object]'
foreach ($b in $script:R2Buckets.Keys) {
    if ($Bucket -and $b -ne $Bucket) { continue }
    $dir = Join-Path (Join-Path (Join-Path $Root $script:R2Buckets[$b]) $User) $b
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $dir -File -Recurse) {
        if ($f.Name.EndsWith('.part')) { continue }
        $rel = $f.FullName.Substring($dir.Length + 1).Replace('\', '/')
        $key = "$User/$rel"
        $ext = [IO.Path]::GetExtension($f.Name).ToLowerInvariant()
        $type = if ($b -eq 'vault-files') { 'application/octet-stream' } elseif ($Types.ContainsKey($ext)) { $Types[$ext] } else { 'application/octet-stream' }
        $todo.Add(@{ Bucket = $b; Key = $key; File = $f.FullName; Size = $f.Length; Type = $type })
    }
}
if ($todo.Count -eq 0) { Fail "本机没有 $User 的图片或附件备份" 1 }

# 只读令牌：列远端、比对（试运行和 -Execute 都用它）。测试模式从测试环境变量读，平时读 pull.ps1 -Setup 存的那一条
if ($TestMode) {
    $roId = [Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST_R2_ID'); $roSecret = [Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST_R2_SECRET')
} else {
    $c = Read-LemoCred 'lemomemo.backup.r2-pull'
    if ($c) { $roId = $c.User; $roSecret = $c.Secret } else { $roId = $null; $roSecret = $null }
}
if (-not $roId -or -not $roSecret) { Fail '凭据管理器里没有 R2 只读令牌 lemomemo.backup.r2-pull（先运行 pull.ps1 -Setup）' 1 }

$wId = $null; $wSecret = $null
try {
    # 远端现有的（大小和 ETag 一样的跳过）
    $remote = @{}
    foreach ($b in @($todo | ForEach-Object { $_.Bucket } | Sort-Object -Unique)) {
        foreach ($o in Get-R2Objects $Endpoint ($Prefix + $b) $roId $roSecret) { if ($o.Key.StartsWith("$User/")) { $remote["$b`t$($o.Key)"] = $o } }
    }
    $send = @($todo | Where-Object { $r = $remote["$($_.Bucket)`t$($_.Key)"]; -not $r -or $r.Size -ne $_.Size -or $r.ETag -ne (Get-FileMd5Hex $_.File) })
    Say "本机 $($todo.Count) 个文件：远端已有一样的 $($todo.Count - $send.Count) 个，要传 $($send.Count) 个"
    if (-not $Execute) { Say '这是试运行，一个都没传，只用了只读令牌；核对无误后在 Cloudflare 临时生成写令牌，再加 -Execute'; exit 0 }
    if ($send.Count -eq 0) { Say '远端都一样，不用传，也不用写令牌'; exit 0 }

    # 写令牌：看过上面的数才要，只用来 PUT
    if ($TestMode) {
        $wId = [Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST_R2_WRITE_ID'); $wSecret = [Environment]::GetEnvironmentVariable('LEMO_BACKUP_TEST_R2_WRITE_SECRET')
    } else {
        $wId = Read-Secret '粘贴临时写令牌的 Access Key ID（屏幕不显示），回车'
        $wSecret = Read-Secret '粘贴临时写令牌的 Secret Access Key，回车'
        try { Set-Clipboard -Value ' ' } catch { }
    }
    if (-not $wId -or -not $wSecret) { Fail '没有写令牌' 1 }
    $i = 0
    foreach ($t in $send) {
        $path = '/' + (ConvertTo-S3Encoded ($Prefix + $t.Bucket)) + '/' + (ConvertTo-S3Encoded $t.Key $true)
        Invoke-S3Put $Endpoint $path $t.File $t.Type $wId $wSecret
        $i++
        if ($i % 50 -eq 0) { Say "  已传 $i / $($send.Count)" }
    }
    Say "已传 $i 个。请马上在 Cloudflare 吊销这把临时写令牌，再跑一遍 file-check 补扫核对 sha256。"
} catch {
    Fail $_.Exception.Message 2
} finally {
    $c = $null; $roId = $null; $roSecret = $null; $wId = $null; $wSecret = $null
}
