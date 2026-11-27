<#
  tools/backup/pull.ps1、restore-files.ps1 共用的函数（架构第 10 节；ADR-016；TC-B7a-06、07、26）。只定义函数，点引用（. .\backup-lib.ps1）后才用；
  单独运行什么都不做。tests/build/backup-pull.test.ts 点引用本文件直接测三道保险、30 天保留、SigV4 签名、R2 增量同步。
  兼容 Windows PowerShell 5.1（任务计划程序用的就是它）和 pwsh。
  不读凭据管理器、不连网（连网的函数都由调用方传进地址和令牌）；令牌不打印、不写文件。
#>
Set-StrictMode -Version 3.0

$script:UuidRe = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$script:DateRe = '^\d{4}-\d{2}-\d{2}$'
# 本机只存 _manifest 和它列的数据文件（<代 a|b>_<表>[.<片号>].json.gz）；和 supabase/functions/_shared/backup-format.ts 的 DATA_FILE_RE、
# tools/backup/restore-lib.mjs 的 DATA_FILE_RE 是同一条（tests/build/backup-format-sync.test.ts 核对）；_running.<编号> 认领标记不下载
$script:BackupFileRe = '^(?:_manifest|[ab]_[a-z_]+(?:\.[1-9][0-9]{0,3})?)\.json\.gz$'
# 每日备份本机留 30 天（第 10 节第 4 步）；图片、附件远端已删的文件留 30 天（第 6 节 attachments 本机备份“保留期同每日备份”，TC-B7a-26）
$script:KeepDays = 30
$script:EmptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
$script:Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$script:Inv = [Globalization.CultureInfo]::InvariantCulture
# R2 的四个桶（清单 backup: 'weekly-s3'）放进本机哪个文件夹；桶名和 supabase/functions/_shared/objstore-buckets.ts 一致（backup-format-sync 测试核对）
$script:R2Buckets = [ordered]@{ 'images' = '图片'; 'vault-images' = '图片'; 'files' = '附件'; 'vault-files' = '附件' }

# ───────────────────────── 小工具 ─────────────────────────
# BACKUP_PULL_TOKEN 满 90 天提醒轮换（B7a 复审第 8 条）：$Written 是凭据管理器里这一条的最后写入时刻（UTC），没有（测试模式）回 $null
$script:RotateDays = 90
function Get-RotateNote($Written, [datetime]$Now) {
    if (-not ($Written -is [datetime])) { return $null }
    $days = [int][math]::Floor(($Now.ToUniversalTime() - $Written.ToUniversalTime()).TotalDays)
    if ($days -lt $script:RotateDays) { return $null }
    return "提示：BACKUP_PULL_TOKEN 已经用了 $days 天（满 $($script:RotateDays) 天要换）：运行 tools\keys\set-backup-pull-token.ps1 -Target prod，步骤见上线与回滚手册第七节「备份拉取令牌每 90 天轮换」"
}
function Add-BackupNote([string]$Root, [string]$Name, [string[]]$Lines, [datetime]$Now) {
    $stamp = $Now.ToString('yyyy-MM-dd HH:mm', $script:Inv)
    $text = (@($Lines) | ForEach-Object { "$stamp $_" }) -join "`r`n"
    [IO.File]::AppendAllText((Join-Path $Root $Name), $text + "`r`n", $script:Utf8Bom)
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { return (-join ($h.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') })) } finally { $h.Dispose() }
}

function Get-FileSha256Hex([string]$Path) {
    $h = [Security.Cryptography.SHA256]::Create()
    $s = [IO.File]::OpenRead($Path)
    try { return (-join ($h.ComputeHash($s) | ForEach-Object { $_.ToString('x2') })) } finally { $s.Dispose(); $h.Dispose() }
}

function Expand-GzipText([byte[]]$Bytes) {
    $in = New-Object IO.MemoryStream(, $Bytes)
    $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
    $out = New-Object IO.MemoryStream
    try { $gz.CopyTo($out); return [Text.Encoding]::UTF8.GetString($out.ToArray()) } finally { $gz.Dispose(); $in.Dispose(); $out.Dispose() }
}

<# JSON 转成字典和数组（5.1 的 ConvertFrom-Json 有 2 MB 上限、返回对象，这里统一成字典，用 $x['键'] 取值） #>
function ConvertFrom-JsonDict([string]$Text) {
    if ($PSVersionTable.PSVersion.Major -ge 6) { return ($Text | ConvertFrom-Json -AsHashtable -Depth 64) }
    Add-Type -AssemblyName System.Web.Extensions
    $s = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $s.MaxJsonLength = [int]::MaxValue
    $s.RecursionLimit = 64
    return $s.DeserializeObject($Text)
}

<# ISO 时刻转 UTC（pwsh 的 ConvertFrom-Json 会先把它变成 DateTime，5.1 给的是字符串） #>
function ConvertTo-UtcTime($Value) {
    if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
    return [datetime]::Parse([string]$Value, $script:Inv, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
}

function Get-DictValue($Dict, [string]$Key) {
    # 5.1 给 Dictionary[string,object]（只有 ContainsKey），pwsh 给 Hashtable（两个都有）
    if ($null -ne $Dict -and $Dict -is [Collections.IDictionary] -and $Dict.ContainsKey($Key)) { return $Dict[$Key] }
    return $null
}

# ───────────────────────── 本机有哪些账号 ─────────────────────────
<# 本机所有历史备份里出现过的 user_id：每日\<日期>\<id>、发布前\<批次>\<id>、图片\<id>、附件\<id>（第 10 节第 3 步“本机所有历史备份”） #>
function Get-LocalUserIds([string]$Root) {
    $ids = New-Object 'Collections.Generic.SortedSet[string]'
    foreach ($kind in @('每日', '发布前')) {
        $p = Join-Path $Root $kind
        if (-not (Test-Path -LiteralPath $p)) { continue }
        foreach ($d in Get-ChildItem -LiteralPath $p -Directory) {
            foreach ($u in Get-ChildItem -LiteralPath $d.FullName -Directory) { if ($u.Name -cmatch $script:UuidRe) { [void]$ids.Add($u.Name) } }
        }
    }
    foreach ($kind in @('图片', '附件')) {
        $p = Join-Path $Root $kind
        if (-not (Test-Path -LiteralPath $p)) { continue }
        foreach ($u in Get-ChildItem -LiteralPath $p -Directory) { if ($u.Name -cmatch $script:UuidRe) { [void]$ids.Add($u.Name) } }
    }
    return [string[]]@($ids)
}

# ───────────────────────── 三道保险（第 10 节第 3 步；安全审查高 1；TC-B7a-07） ─────────────────────────
<#
  算出这次要从本机删掉哪些账号。任何一道不过：Delete 为空、Problems 写原因（pull.ps1 写进 需要人工确认.txt），一个都不删。
  -Deleted     服务器 deleted_accounts 里的 user_id
  -ServerToday 当天服务器备份名单（backup-manifest 当天日期下的 user_id）；-TodayKnown 为假表示当天名单拿不到
  -LocalUsers  本机所有历史备份里的 user_id（Get-LocalUserIds）
  -Protected   本机配置 protected_user_ids
  -Approved    负责人看过 需要人工确认.txt 后用 pull.ps1 -ApproveDeletion 点名放行的 user_id：只放过第 ② 道（数量闸），①③ 照查
  只有本机还有文件夹的才算候选（已经删过的不再算）。
#>
function Get-DeletionPlan {
    param([string[]]$Deleted = @(), [string[]]$ServerToday = @(), [bool]$TodayKnown = $true, [string[]]$LocalUsers = @(),
        [string[]]$Protected = @(), [string[]]$Approved = @())
    $problems = New-Object 'Collections.Generic.List[string]'
    $deletedSet = @($Deleted | Where-Object { $_ -cmatch $script:UuidRe } | Sort-Object -Unique)
    $cands = @($deletedSet | Where-Object { $LocalUsers -contains $_ })
    # ① 受保护名单：服务器清单里出现了也不删；出现本身就不正常，整次都停
    foreach ($id in @($deletedSet | Where-Object { $Protected -contains $_ })) { $problems.Add("① 受保护名单里的 $id 出现在服务器的 deleted_accounts 里：不删，请核对") }
    if ($cands.Count -gt 0 -and @($Protected).Count -eq 0) { $problems.Add('① 配置.json 的 protected_user_ids 是空的：先填上负责人自己的 user_id 再清理') }
    # ③ 双向对账：只删已经不在当天备份名单里的
    if ($cands.Count -gt 0 -and -not $TodayKnown) { $problems.Add('③ 当天的服务器备份名单拿不到（当天备份还没做或没拉成功），对不了账') }
    foreach ($id in @($cands | Where-Object { $ServerToday -contains $_ })) { $problems.Add("③ $id 在 deleted_accounts 里，却还在当天的服务器备份名单里：两边对不上") }
    # ② 数量闸：超过 1 个，或超过本机现有账号的 20%
    $n = $cands.Count
    $total = [Math]::Max(1, @($LocalUsers).Count)
    if ($n -gt 1 -or ($n -gt 0 -and $n * 5 -gt $total)) {
        $unapproved = @($cands | Where-Object { $Approved -notcontains $_ })
        if ($unapproved.Count -gt 0) {
            $problems.Add("② 这次要删 $n 个账号（本机共 $(@($LocalUsers).Count) 个），超过数量闸（超过 1 个或超过 20%）：$($unapproved -join '、')。核对无误后用 -ApproveDeletion <user_id> 点名放行")
        }
    }
    $del = @()
    if ($problems.Count -eq 0) { $del = $cands }
    return [pscustomobject]@{ Candidates = [string[]]$cands; Delete = [string[]]$del; Problems = [string[]]$problems.ToArray() }
}

<# 从本机所有历史备份里删掉一个账号（每日、发布前、图片、附件），在 删除记录.txt 记 user_id 和日期；返回删了几处 #>
function Remove-UserEverywhere([string]$Root, [string]$UserId, [datetime]$Now) {
    if ($UserId -cnotmatch $script:UuidRe) { throw "不是 user_id：$UserId" }
    $places = New-Object 'Collections.Generic.List[string]'
    foreach ($kind in @('每日', '发布前')) {
        $p = Join-Path $Root $kind
        if (-not (Test-Path -LiteralPath $p)) { continue }
        foreach ($d in Get-ChildItem -LiteralPath $p -Directory) {
            $u = Join-Path $d.FullName $UserId
            if (Test-Path -LiteralPath $u) { Remove-Item -LiteralPath $u -Recurse -Force; $places.Add("$kind\$($d.Name)") }
        }
    }
    foreach ($kind in @('图片', '附件')) {
        $u = Join-Path (Join-Path $Root $kind) $UserId
        if (Test-Path -LiteralPath $u) { Remove-Item -LiteralPath $u -Recurse -Force; $places.Add($kind) }
    }
    Add-BackupNote $Root '删除记录.txt' @("删除 $UserId（$($places.Count) 处：$($places -join '、')）") $Now
    return $places.Count
}

# ───────────────────────── 30 天保留（第 10 节第 4 步；TC-B7a-26） ─────────────────────────
<# 删掉早于 今天 - 30 天 的每日备份；发布前、版本前不动。返回删掉的日期 #>
function Remove-OldDaily([string]$Root, [datetime]$Today) {
    $p = Join-Path $Root '每日'
    if (-not (Test-Path -LiteralPath $p)) { return [string[]]@() }
    $cut = $Today.Date.AddDays(-$script:KeepDays).ToString('yyyy-MM-dd', $script:Inv)
    $gone = @()
    foreach ($d in Get-ChildItem -LiteralPath $p -Directory | Sort-Object Name) {
        if ($d.Name -match $script:DateRe -and [string]::CompareOrdinal($d.Name, $cut) -lt 0) {
            Remove-Item -LiteralPath $d.FullName -Recurse -Force
            $gone += $d.Name
        }
    }
    return [string[]]$gone
}

# ───────────────────────── R2：SigV4 签名（S3 接口，区域 auto） ─────────────────────────
<# RFC 3986 编码；$KeepSlash 为真时保留 /（对象路径） #>
function ConvertTo-S3Encoded([string]$Text, [bool]$KeepSlash = $false) {
    $sb = New-Object Text.StringBuilder
    foreach ($b in [Text.Encoding]::UTF8.GetBytes($Text)) {
        $c = [char]$b
        if (($b -ge 0x41 -and $b -le 0x5A) -or ($b -ge 0x61 -and $b -le 0x7A) -or ($b -ge 0x30 -and $b -le 0x39) -or $c -eq '-' -or $c -eq '_' -or $c -eq '.' -or $c -eq '~' -or ($KeepSlash -and $c -eq '/')) {
            [void]$sb.Append($c)
        } else { [void]$sb.Append('%' + $b.ToString('X2')) }
    }
    return $sb.ToString()
}

function Get-HmacBytes([byte[]]$Key, [string]$Data) {
    $h = New-Object Security.Cryptography.HMACSHA256(, $Key)
    try { return $h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Data)) } finally { $h.Dispose() }
}

<#
  SigV4 头。$Query 是已排序、已编码的查询串（不带 ?）；$Path 是已编码的路径（/桶/键）；$PayloadHash 默认空正文（GET），上传用 UNSIGNED-PAYLOAD。
  返回 @{ Authorization; x-amz-date; x-amz-content-sha256 }
#>
function Get-SigV4Headers([string]$HostHeader, [string]$Path, [string]$Query, [string]$AccessKey, [string]$Secret, [datetime]$UtcNow, [string]$Region = 'auto',
    [string]$Method = 'GET', [string]$PayloadHash = $script:EmptySha) {
    $amz = $UtcNow.ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'", $script:Inv)
    $day = $amz.Substring(0, 8)
    $signed = 'host;x-amz-content-sha256;x-amz-date'
    $creq = "$Method`n$Path`n$Query`nhost:$HostHeader`nx-amz-content-sha256:$PayloadHash`nx-amz-date:$amz`n`n$signed`n$PayloadHash"
    $scope = "$day/$Region/s3/aws4_request"
    $sts = "AWS4-HMAC-SHA256`n$amz`n$scope`n" + (Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($creq)))
    $k = Get-HmacBytes ([Text.Encoding]::UTF8.GetBytes('AWS4' + $Secret)) $day
    $k = Get-HmacBytes $k $Region
    $k = Get-HmacBytes $k 's3'
    $k = Get-HmacBytes $k 'aws4_request'
    $sig = -join ((Get-HmacBytes $k $sts) | ForEach-Object { $_.ToString('x2') })
    return @{ 'Authorization' = "AWS4-HMAC-SHA256 Credential=$AccessKey/$scope, SignedHeaders=$signed, Signature=$sig"; 'x-amz-date' = $amz; 'x-amz-content-sha256' = $PayloadHash }
}

<# 上传一个文件（PUT，UNSIGNED-PAYLOAD；restore-files.ps1 用）。非 2xx 抛错 #>
function Invoke-S3Put([string]$Endpoint, [string]$Path, [string]$File, [string]$ContentType, [string]$AccessKey, [string]$Secret) {
    $u = [Uri]$Endpoint
    $hostHeader = if ($u.IsDefaultPort) { $u.Host } else { "$($u.Host):$($u.Port)" }
    $h = Get-SigV4Headers $hostHeader $Path '' $AccessKey $Secret ([datetime]::UtcNow) -Method 'PUT' -PayloadHash 'UNSIGNED-PAYLOAD'
    try {
        Invoke-WebRequest -Uri ($Endpoint.TrimEnd('/') + $Path) -Method Put -Headers $h -InFile $File -ContentType $ContentType -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop -UserAgent 'lemomemo-tools/4.0 (PowerShell)' | Out-Null
    } catch { throw "R2 上传失败（$($Path.Split('/')[1])）" }
}

function Get-FileMd5Hex([string]$Path) {
    $h = [Security.Cryptography.MD5]::Create()
    $s = [IO.File]::OpenRead($Path)
    try { return (-join ($h.ComputeHash($s) | ForEach-Object { $_.ToString('x2') })) } finally { $s.Dispose(); $h.Dispose() }
}

<# 发一个签名的 GET；$OutFile 为空时返回响应正文（字符串），否则写进文件。非 2xx 抛错（不带地址和头） #>
function Invoke-S3Get([string]$Endpoint, [string]$Path, [hashtable]$QueryParams, [string]$AccessKey, [string]$Secret, [string]$OutFile = '') {
    $u = [Uri]$Endpoint
    $hostHeader = if ($u.IsDefaultPort) { $u.Host } else { "$($u.Host):$($u.Port)" }
    # SigV4 要按编码后的键逐字节排序（不按区域文化排）
    $pairs = [string[]]@($QueryParams.Keys | ForEach-Object { (ConvertTo-S3Encoded $_) + '=' + (ConvertTo-S3Encoded ([string]$QueryParams[$_])) })
    [Array]::Sort($pairs, [StringComparer]::Ordinal)
    $q = $pairs -join '&'
    $h = Get-SigV4Headers $hostHeader $Path $q $AccessKey $Secret ([datetime]::UtcNow)
    $url = $Endpoint.TrimEnd('/') + $Path + $(if ($q) { "?$q" } else { '' })
    $p = @{ Uri = $url; Headers = $h; UseBasicParsing = $true; TimeoutSec = 300; ErrorAction = 'Stop'; UserAgent = 'lemomemo-tools/4.0 (PowerShell)' }
    if ($OutFile) { $p['OutFile'] = $OutFile }
    try { $r = Invoke-WebRequest @p } catch { throw "R2 请求失败（$($Path.Split('/')[1])）" }
    if ($OutFile) { return $null }
    if ($r.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($r.Content) }
    return [string]$r.Content
}

<# 列一个桶的全部对象：返回 @(@{ Key; ETag; Size }) #>
function Get-R2Objects([string]$Endpoint, [string]$Bucket, [string]$AccessKey, [string]$Secret) {
    $out = New-Object 'Collections.Generic.List[object]'
    $token = $null
    do {
        $q = @{ 'list-type' = '2'; 'max-keys' = '1000' }
        if ($token) { $q['continuation-token'] = $token }
        [xml]$x = Invoke-S3Get $Endpoint ('/' + (ConvertTo-S3Encoded $Bucket)) $q $AccessKey $Secret
        $res = $x.ListBucketResult
        foreach ($c in @($res.SelectNodes("*[local-name()='Contents']"))) {
            $key = $c.SelectSingleNode("*[local-name()='Key']").InnerText
            $etag = $c.SelectSingleNode("*[local-name()='ETag']").InnerText.Trim('"')
            $size = [long]$c.SelectSingleNode("*[local-name()='Size']").InnerText
            $out.Add(@{ Key = $key; ETag = $etag; Size = $size })
        }
        $trunc = $res.SelectSingleNode("*[local-name()='IsTruncated']")
        $next = $res.SelectSingleNode("*[local-name()='NextContinuationToken']")
        $token = if ($trunc -and $trunc.InnerText -eq 'true' -and $next) { $next.InnerText } else { $null }
    } while ($token)
    return $out.ToArray()
}

# ───────────────────────── R2 增量同步（第 10 节第 2 步） ─────────────────────────
<#
  按 ETag 增量把四个桶拉到 图片\<user_id>\<桶>\…、附件\<user_id>\<桶>\…：只下载、从不删远端。
  每个人的文件夹里一份 _索引.tsv（桶、键、ETag、大小、远端消失的日期）。远端已删的本机文件留 30 天后删掉（TC-B7a-26）。
  -Skip：不下载这些 user_id（deleted_accounts 里的，免得把刚清掉的又拉回来）。
  -Get 和 -List 可替换（测试用）；默认走 Invoke-S3Get。返回 @{ Downloaded; Kept; Expired; Skipped }
#>
function Sync-R2Files {
    param([string]$Root, [string]$Endpoint, [string]$Prefix, [string]$AccessKey, [string]$Secret, [datetime]$Today, [string[]]$Skip = @())
    $stat = @{ Downloaded = 0; Kept = 0; Expired = 0; Skipped = 0 }
    $todayS = $Today.ToString('yyyy-MM-dd', $script:Inv)
    $cut = $Today.Date.AddDays(-$script:KeepDays).ToString('yyyy-MM-dd', $script:Inv)
    # 先把四个桶都列出来，按人分组（一个人的索引同时管四个桶）
    $byUser = @{}
    foreach ($bucket in $script:R2Buckets.Keys) {
        foreach ($o in Get-R2Objects $Endpoint ($Prefix + $bucket) $AccessKey $Secret) {
            $parts = $o.Key.Split('/')
            $uid = $parts[0]
            $okKey = $uid -cmatch $script:UuidRe -and $parts.Count -ge 2 -and -not ($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -notmatch '^[A-Za-z0-9._-]+$' })
            if (-not $okKey) { $stat.Skipped++; continue }
            if ($Skip -contains $uid) { $stat.Skipped++; continue }
            if (-not $byUser.ContainsKey($uid)) { $byUser[$uid] = New-Object 'Collections.Generic.List[object]' }
            $byUser[$uid].Add(@{ Bucket = $bucket; Key = $o.Key; ETag = $o.ETag; Size = $o.Size })
        }
    }
    # 本机已有索引、远端这次一个都没列到的人也要过一遍（远端全删了的，30 天后清本机）
    $users = New-Object 'Collections.Generic.SortedSet[string]'
    foreach ($k in $byUser.Keys) { [void]$users.Add($k) }
    foreach ($kind in @('图片', '附件')) {
        $p = Join-Path $Root $kind
        if (Test-Path -LiteralPath $p) { foreach ($d in Get-ChildItem -LiteralPath $p -Directory) { if ($d.Name -cmatch $script:UuidRe -and $Skip -notcontains $d.Name) { [void]$users.Add($d.Name) } } }
    }
    foreach ($uid in $users) {
        $remote = @{}
        if ($byUser.ContainsKey($uid)) { foreach ($o in $byUser[$uid]) { $remote["$($o.Bucket)`t$($o.Key)"] = $o } }
        foreach ($kind in @('图片', '附件')) {
            $dir = Join-Path (Join-Path $Root $kind) $uid
            $idxPath = Join-Path $dir '_索引.tsv'
            $idx = [ordered]@{}
            if (Test-Path -LiteralPath $idxPath) {
                foreach ($line in [IO.File]::ReadAllLines($idxPath, [Text.Encoding]::UTF8)) {
                    $f = $line.Split("`t")
                    if ($f.Count -eq 5) { $idx["$($f[0])`t$($f[1])"] = @{ Bucket = $f[0]; Key = $f[1]; ETag = $f[2]; Size = [long]$f[3]; Gone = $f[4] } }
                }
            }
            $mine = @($remote.Values | Where-Object { $script:R2Buckets[$_.Bucket] -eq $kind })
            if ($mine.Count -eq 0 -and $idx.Count -eq 0) { continue }
            foreach ($o in $mine) {
                $id = "$($o.Bucket)`t$($o.Key)"
                $local = Join-Path (Join-Path $dir $o.Bucket) ($o.Key.Substring($uid.Length + 1).Replace('/', '\'))
                $have = $idx.Contains($id) -and $idx[$id].ETag -eq $o.ETag -and (Test-Path -LiteralPath $local) -and (Get-Item -LiteralPath $local).Length -eq $o.Size
                if ($have) { $idx[$id].Gone = ''; $stat.Kept++; continue }
                [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $local))
                $part = "$local.part"
                Invoke-S3Get $Endpoint ('/' + (ConvertTo-S3Encoded ($Prefix + $o.Bucket)) + '/' + (ConvertTo-S3Encoded $o.Key $true)) @{} $AccessKey $Secret $part | Out-Null
                if ((Get-Item -LiteralPath $part).Length -ne $o.Size) { Remove-Item -LiteralPath $part -Force; throw "R2 下载的大小对不上（$($o.Bucket)）" }
                Move-Item -LiteralPath $part -Destination $local -Force
                $idx[$id] = @{ Bucket = $o.Bucket; Key = $o.Key; ETag = $o.ETag; Size = $o.Size; Gone = '' }
                $stat.Downloaded++
            }
            # 远端没有了的：记下消失的日期，满 30 天删本机文件
            foreach ($id in @($idx.Keys)) {
                if ($remote.ContainsKey($id)) { continue }
                $e = $idx[$id]
                if (-not $e.Gone) { $e.Gone = $todayS; continue }
                if ([string]::CompareOrdinal($e.Gone, $cut) -lt 0) {
                    $local = Join-Path (Join-Path $dir $e.Bucket) ($e.Key.Substring($uid.Length + 1).Replace('/', '\'))
                    if (Test-Path -LiteralPath $local) { Remove-Item -LiteralPath $local -Force }
                    $idx.Remove($id)
                    $stat.Expired++
                }
            }
            [void](New-Item -ItemType Directory -Force -Path $dir)
            $lines = @($idx.Values | ForEach-Object { "$($_.Bucket)`t$($_.Key)`t$($_.ETag)`t$($_.Size)`t$($_.Gone)" })
            [IO.File]::WriteAllLines($idxPath, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
        }
    }
    return $stat
}
