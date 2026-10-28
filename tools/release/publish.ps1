<#
.SYNOPSIS
  柠檬记正式发布（R-206）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，不经过 Claude。

.DESCRIPTION
  GitHub 免费版私有仓库不能设“必须由负责人批准才发布”，所以正式环境的令牌不放 GitHub，
  正式发布由负责人本机运行本脚本，令牌每次发布前在网页上临时生成（建议 1 天到期）、粘贴进来，发完删掉（R-206、R-220：令牌不另存）。

  做的事（按顺序，任何一步不过就停）：
    1. 发布前检查：tag 格式、在 main 上、是带说明的 tag、当前检出的就是这个 tag、工作区干净、VERSION 一致、
       正式环境的公开配置文件在、工具锁文件在；
    2. 备份：E:\柠檬记-备份\版本前\ 下已有这个 tag 的“发布前”备份且恢复测试通过，没有就调 build\backup.py 做一份；
    3. 构建：npm ci --ignore-scripts → 白名单 rebuild → npm run build -- --mode production → 体积预算 → 不能有 source map；
       算产物指纹，请你在 iPhone 上打开 GitHub 里这个 tag 的 release-build 摘要页核对（R-206：CI 只构建和测试）；
    4. 装部署工具到临时目录：Supabase CLI（核对 tools\ci-tools.lock 里的 SHA-256）、wrangler（tools\deploy 的锁文件）；
    —— -DryRun 到这里停 ——
    5. 确认 Claude 已退出（含以 node 运行的）、Windows 剪贴板历史已关、没有 transcript 和日志策略（和 tools\keys 两个脚本同一段检查），然后依次粘贴三把令牌（屏幕不显示，粘贴后立即清剪贴板）；
    6. 正式项目状态 → db push（先演练给你看，你输入“确认推送”才真推）→ functions deploy → pages deploy；
    7. 核对 https://lemomemo.com/app/version.json；
    8. 不论成功失败：清掉本进程里的令牌、剪贴板、临时目录和 supabase link 的本地文件。

  令牌只在本进程的内存和环境变量里，不写文件、不进命令行参数（不会留在 PowerShell 历史里）、不打印。

.PARAMETER Tag
  要发布的 tag，例如 v4.0.0。

.PARAMETER RepoPath
  仓库位置，默认 D:\claude code\柠檬记APP。本脚本应从“冻结副本”运行（见发布说明第二节），所以不靠脚本自己的位置找仓库。

.PARAMETER CheckOnly
  只做第 1 步发布前检查。

.PARAMETER DryRun
  做第 1～4 步（含备份和构建），在输入令牌之前停下。不需要令牌，可以随时演练。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File E:\柠檬记-发布\publish-v4.0.0.ps1 -Tag v4.0.0
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$RepoPath = 'D:\claude code\柠檬记APP',
    [string]$PagesProject = 'lemomemo',
    [string]$SiteOrigin = 'https://lemomemo.com',
    # 和 build\backup.py 里的 BACKUP_ROOT 一致；只在演练时改到别处
    [string]$BackupRoot = 'E:\柠檬记-备份\版本前',
    [switch]$CheckOnly,
    [switch]$DryRun
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 架构 8.3a 第 1 步：关掉本窗口的 PowerShell 历史记录（PSReadLine），这个窗口之后输入的命令都不存盘。
# 令牌本来就用 Read-Host -AsSecureString 读、不进历史，这一步是多一道保险；窗口关掉后下次开新窗口恢复默认。
if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { Write-Host '提示：没能关掉 PowerShell 历史记录（不是交互窗口时正常），继续。' }
}

# 本进程里放令牌的环境变量；finally 里统一清掉
$SecretEnvNames = @('SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CLOUDFLARE_API_TOKEN')
$script:WorkDir = $null
$script:TokensRead = $false

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Fail([string]$msg) { throw "发布停止：$msg" }

# 运行外部程序，退出码不是 0 就停。参数用数组传，不拼字符串。
function Run([string]$exe, [string[]]$argv) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { Fail "$exe $($argv -join ' ') 退出码 $LASTEXITCODE" }
}

# 运行 git 并返回去掉首尾空白的输出；$allowFail 时不因退出码停下
function Invoke-Git([string[]]$argv, [switch]$allowFail) {
    # Windows PowerShell 5.1 里，ErrorActionPreference=Stop 时把外部程序的 stderr 重定向会被当成异常，这里临时放宽
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & git -C $RepoPath @argv 2>$null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $old }
    if (-not $allowFail -and $code -ne 0) { Fail "git $($argv -join ' ') 出错（退出码 $code）" }
    $global:LASTEXITCODE = $code
    if ($null -eq $out) { return '' }
    return (($out | Out-String).Trim())
}

function Ask-Exact([string]$prompt, [string]$expected) {
    $ans = Read-Host $prompt
    if ($ans.Trim() -ne $expected) { Fail "没有输入“$expected”，已取消" }
}

function Clear-Clip {
    try { Set-Clipboard -Value ' ' } catch { }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Clipboard]::Clear()
    } catch { }
    # Windows 剪贴板历史（Win+V）也清一下；系统不支持时忽略
    try {
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory()
    } catch { }
}

function Read-Secret([string]$label, [string]$where) {
    Say ''
    Say "请粘贴：$label"
    Say "  （粘贴刚为这次发布临时生成的：$where。屏幕上不显示，粘贴后按回车。）"
    $script:TokensRead = $true
    $sec = Read-Host -AsSecureString '  粘贴到这里'
    Clear-Clip
    if ($sec.Length -lt 8) { Fail "$label 太短，像是没粘贴上" }
    Ok "$label 已收到（剪贴板已清空）"
    return $sec
}

function Set-SecretEnv([string]$name, [Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
        [Environment]::SetEnvironmentVariable($name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr), 'Process')
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Clear-SecretEnv {
    foreach ($n in $SecretEnvNames) { [Environment]::SetEnvironmentVariable($n, $null, 'Process') }
}

# 读 tools\ci-tools.lock 里某个工具某个平台的一行
function Get-LockEntry([string]$name, [string]$platform) {
    $lock = Join-Path $RepoPath 'tools\ci-tools.lock'
    foreach ($line in Get-Content -LiteralPath $lock -Encoding UTF8) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $c = $t -split '\s+'
        if ($c.Count -eq 6 -and $c[0] -eq $name -and $c[2] -eq $platform) {
            return [pscustomobject]@{ Version = $c[1]; File = $c[3]; Sha256 = $c[4].ToLower(); Url = $c[5] }
        }
    }
    Fail "tools\ci-tools.lock 里没有 $name / $platform"
}

function Test-FileSha([string]$path, [string]$sha) {
    return ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -eq $sha)
}

# ---------------------------------------------------------------- 1. 发布前检查
function Invoke-Checks {
    Step '1. 发布前检查'
    $self = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLower()
    Say "  本脚本的 SHA-256：$self"
    Say '  请和代码审查记录里“publish.ps1 冻结副本”的哈希核对（发布说明第二节），不一样就停下。'

    if ($Tag -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { Fail "tag 要写成 vX.Y.Z，例如 v4.0.0，现在是 $Tag" }
    $ver = $Tag.Substring(1)
    if (-not (Test-Path -LiteralPath (Join-Path $RepoPath '.git'))) { Fail "$RepoPath 不是仓库根目录" }
    foreach ($exe in 'git', 'node', 'npm.cmd', 'python', 'tar.exe') {
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Fail "找不到 $exe" }
    }
    Ok "tag 格式：$Tag"

    $dirty = Invoke-Git @('status', '--porcelain', '--untracked-files=all')
    if ($dirty) { Fail "工作区有没提交的改动或多余文件：`n$dirty" }
    Ok '工作区干净'

    if ((Invoke-Git @('cat-file', '-t', "refs/tags/$Tag") -allowFail) -ne 'tag') { Fail "$Tag 不存在，或不是带说明的 tag（要用 git tag -a）" }
    $tagCommit = Invoke-Git @('rev-parse', "$Tag^{commit}")
    $head = Invoke-Git @('rev-parse', 'HEAD')
    if ($head -ne $tagCommit) { Fail "当前检出的不是 $Tag（HEAD $($head.Substring(0,12))，tag 在 $($tagCommit.Substring(0,12))）。先 git switch --detach $Tag" }
    Ok "当前检出的就是 $Tag（$($tagCommit.Substring(0,12))）"

    $branch = Invoke-Git @('branch', '--show-current')
    if ($branch -and $branch -ne 'main') { Fail "当前在分支 $branch 上；正式发布只从 main 上的 tag 发" }
    $null = Invoke-Git @('merge-base', '--is-ancestor', $tagCommit, 'main') -allowFail
    if ($LASTEXITCODE -ne 0) { Fail "$Tag 不在本机的 main 分支上（先 git fetch，确认 tag 是从 main 打的）" }
    Ok "$Tag 在 main 上"

    $verFile = Join-Path $RepoPath 'VERSION'
    if (-not (Test-Path -LiteralPath $verFile)) { Fail '仓库里没有 VERSION 文件' }
    $fileVer = (Get-Content -LiteralPath $verFile -Raw).Trim()
    if ($fileVer -ne $ver) { Fail "VERSION 是 $fileVer，tag 是 $Tag，对不上" }
    Ok "VERSION 一致：$ver"

    $newer = (Invoke-Git @('tag', '-l', 'v*')) -split "`r?`n" | Where-Object { $_ -match '^v(\d+)\.(\d+)\.(\d+)$' } |
        Where-Object { [version]$_.Substring(1) -gt [version]$ver }
    if ($newer) { Say "  ⚠ 已有更高版本的 tag：$($newer -join ', ')。发旧版本会让线上倒退，确定要发再继续。" }

    $envFile = Join-Path $RepoPath '.env.production.local'
    if (-not (Test-Path -LiteralPath $envFile)) { Fail '缺 .env.production.local（正式环境的公开配置，见发布说明第三节）' }
    foreach ($l in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        $t = $l.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        if ($t -notmatch '^VITE_PUBLIC_[A-Z0-9_]+=') { Fail '.env.production.local 里只能有 VITE_PUBLIC_ 开头的公开值（不能放任何密钥）' }
    }
    Ok '.env.production.local 只有公开值'

    foreach ($f in 'tools\ci-tools.lock', 'tools\deploy\package.json', 'tools\deploy\package-lock.json', 'build\backup.py', 'build\ci\dist_hash.py') {
        if (-not (Test-Path -LiteralPath (Join-Path $RepoPath $f))) { Fail "缺 $f" }
    }
    Ok '工具锁文件和脚本都在'
    return @{ Ver = $ver; Commit = $tagCommit }
}

# ---------------------------------------------------------------- 2. 备份
function Invoke-Backup($info) {
    Step '2. 发布前备份（ADR-009，build\backup.py）'
    $when = "$($info.Ver)发布前"
    $root = $BackupRoot
    $found = $null
    if (Test-Path -LiteralPath $root) {
        foreach ($d in Get-ChildItem -LiteralPath $root -Directory -Filter "*_$when") {
            $m = Join-Path $d.FullName '清单.json'
            if (-not (Test-Path -LiteralPath $m)) { continue }
            $j = Get-Content -LiteralPath $m -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.'git 提交' -eq $info.Commit -and $j.'恢复测试'.'通过' -eq $true) { $found = $d.FullName }
        }
    }
    if ($found) { Ok "已有这个 tag 的备份：$found"; return }
    Say "  没有找到 $($info.Commit.Substring(0,12)) 的“$when”备份，现在做一份"
    Push-Location $RepoPath
    try { Run 'python' @('-I', 'build\backup.py', $when) } finally { Pop-Location }
    Ok '备份完成（含恢复测试）'
    Say '  正式库的数据备份（backup-daily）要等 B7a 做好以后接进这里；4.0.0 首次上线前正式库没有用户数据。'
}

# ---------------------------------------------------------------- 3. 构建
function Invoke-Build($info) {
    Step '3. 构建正式产物（此时还没有输入任何令牌）'
    Push-Location $RepoPath
    try {
        Run 'npm.cmd' @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
        $pkg = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
        $allow = @()
        if ($pkg.PSObject.Properties.Name -contains 'lemo' -and $pkg.lemo.PSObject.Properties.Name -contains 'allowScripts') { $allow = @($pkg.lemo.allowScripts) }
        foreach ($p in $allow) { if ($p -notmatch '^(@[a-z0-9._-]+/)?[a-z0-9._-]+$') { Fail "package.json 的 lemo.allowScripts 里有不合格的包名：$p" } }
        if ($allow.Count -gt 0) { Run 'npm.cmd' (@('rebuild') + $allow) }
        Run 'npm.cmd' @('run', 'build', '--', '--mode', 'production')
        Run 'node' @('build\check_size.mjs')
        $maps = Get-ChildItem -LiteralPath 'dist\web' -Recurse -File -Filter '*.map'
        $smu = Get-ChildItem -LiteralPath 'dist\web' -Recurse -File -Filter '*.js' | Select-String -Pattern 'sourceMappingURL' -List
        if ($maps -or $smu) { Fail 'dist\web 里有 source map' }
        Ok '构建、体积预算通过，没有 source map'
        $dirty = Invoke-Git @('status', '--porcelain', '--untracked-files=normal')
        if ($dirty) { Fail "构建以后仓库里多了没被忽略的文件（构建脚本不该改源码）：`n$dirty" }

        Say ''
        & python -I 'build\ci\dist_hash.py' 'dist\web'
        if ($LASTEXITCODE -ne 0) { Fail '算产物指纹失败' }
    } finally { Pop-Location }
    Say ''
    Say "  请在 iPhone 上打开：GitHub › 仓库 › Actions › release-build › $Tag 那一次 › Summary，"
    Say '  核对“文件数”和“总指纹”和上面完全一样。'
    Ask-Exact '  一样就输入“一致”回车（不一样直接回车，发布停止）' '一致'
    Ok '产物和 CI 构建的一致'
}

# ---------------------------------------------------------------- 4. 部署工具
function Install-Tools {
    Step '4. 部署工具装到临时目录（核对哈希）'
    $script:WorkDir = Join-Path $env:TEMP ("lemo-publish-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:WorkDir | Out-Null

    $e = Get-LockEntry 'supabase' 'windows_amd64'
    if ($e.Url -notlike 'https://github.com/supabase/cli/releases/download/*') { Fail "Supabase CLI 的下载地址不对：$($e.Url)" }
    $tgz = Join-Path $script:WorkDir $e.File
    Invoke-WebRequest -UseBasicParsing -Uri $e.Url -OutFile $tgz
    if (-not (Test-FileSha $tgz $e.Sha256)) { Fail 'Supabase CLI 的 SHA-256 和锁文件对不上' }
    $sbDir = Join-Path $script:WorkDir 'supabase'
    New-Item -ItemType Directory -Path $sbDir | Out-Null
    Run 'tar.exe' @('-xzf', $tgz, '-C', $sbDir)
    $script:SupabaseExe = Join-Path $sbDir 'supabase.exe'
    if (-not (Test-Path -LiteralPath $script:SupabaseExe)) { Fail '解压后没找到 supabase.exe' }
    $script:SupabaseSha = (Get-FileHash -LiteralPath $script:SupabaseExe -Algorithm SHA256).Hash
    Ok "Supabase CLI $($e.Version)：哈希核对通过"

    $wr = Join-Path $script:WorkDir 'deploy'
    New-Item -ItemType Directory -Path $wr | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoPath 'tools\deploy\package.json'), (Join-Path $RepoPath 'tools\deploy\package-lock.json') -Destination $wr
    Push-Location $wr
    try { Run 'npm.cmd' @('ci', '--ignore-scripts', '--no-audit', '--no-fund') } finally { Pop-Location }
    $script:WranglerCmd = Join-Path $wr 'node_modules\.bin\wrangler.cmd'
    if (-not (Test-Path -LiteralPath $script:WranglerCmd)) { Fail '没装上 wrangler' }
    Ok 'wrangler：按 tools\deploy\package-lock.json 装好（npm 已核对 integrity）'
}

# ==== 安全窗口检查：开始（tools/keys/new-proxy-secret.ps1、tools/keys/set-r2-tokens.ps1、tools/release/publish.ps1 三处逐字相同，tests/build/keys-guard-sync.test.ts 核对；改一处三处一起改）====
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

function Assert-NoAiSession {
    Assert-NoClaude
    Assert-NoRecording
}

# ---------------------------------------------------------------- 5～7. 部署
function Invoke-Deploy($info) {
    Step '5. 输入正式环境的令牌'
    Assert-NoAiSession
    if ((Get-FileHash -LiteralPath $script:SupabaseExe -Algorithm SHA256).Hash -ne $script:SupabaseSha) { Fail 'supabase.exe 在安装后被改过' }

    $ref = Read-Host '  正式 Supabase 项目的 Project ref（20 个小写字母，在 Supabase › 正式项目 › Project Settings 里，不是密钥）'
    $ref = $ref.Trim()
    if ($ref -notmatch '^[a-z]{20}$') { Fail 'Project ref 的格式不对' }

    $sb = Read-Secret '正式 Supabase 令牌（只管正式项目的那把）' 'Supabase › Account › Access Tokens 里新建的正式项目级令牌（1 天到期，发完删掉）'
    Set-SecretEnv 'SUPABASE_ACCESS_TOKEN' $sb
    if (-not $env:SUPABASE_ACCESS_TOKEN.StartsWith('sbp_')) { Fail '这不像 Supabase 令牌（应以 sbp_ 开头）' }
    $db = Read-Secret '正式数据库密码' '正式项目 › Project Settings › Database 里重设的新密码'
    Set-SecretEnv 'SUPABASE_DB_PASSWORD' $db
    $cf = Read-Secret '正式 Cloudflare 令牌（Pages 编辑）' 'Cloudflare › 我的个人资料 › API 令牌里新建的正式令牌（1 天到期，发完删掉）'
    Set-SecretEnv 'CLOUDFLARE_API_TOKEN' $cf
    $sb.Dispose(); $db.Dispose(); $cf.Dispose()

    $acct = Read-Host '  Cloudflare Account ID（32 位，Cloudflare 首页右侧，不是密钥）'
    $acct = $acct.Trim()
    if ($acct -notmatch '^[0-9a-f]{32}$') { Fail 'Account ID 的格式不对' }
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', $acct, 'Process')

    Step '6. 部署'
    $hdr = @{ Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN" }
    $proj = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref" -Headers $hdr
    $hdr = $null
    if ($proj.region -ne 'ap-northeast-2') { Fail "这个项目不在首尔（$($proj.region)），是不是贴成了预览项目？" }
    if ($proj.status -ne 'ACTIVE_HEALTHY') { Fail "正式项目状态是 $($proj.status)，不是 ACTIVE_HEALTHY" }
    Ok "正式项目：$($proj.name)（首尔，运行正常）"
    Ask-Exact "  确认要发布到上面这个项目就输入项目名“$($proj.name)”" $proj.name

    Push-Location $RepoPath
    try {
        Run $script:SupabaseExe @('link', '--project-ref', $ref)
        Say ''
        Say '  数据库迁移演练（不改库，只列出要执行的迁移）：'
        Run $script:SupabaseExe @('db', 'push', '--linked', '--dry-run')
        Ask-Exact '  核对上面的迁移，没问题输入“确认推送”' '确认推送'
        Run $script:SupabaseExe @('db', 'push', '--linked', '--yes')
        Ok '数据库迁移完成'

        $shared = Join-Path $RepoPath 'supabase\functions\_shared\gen'
        if (Test-Path -LiteralPath $shared) { Remove-Item -LiteralPath $shared -Recurse -Force }
        New-Item -ItemType Directory -Path $shared | Out-Null
        Copy-Item -Path (Join-Path $RepoPath 'shared\*') -Destination $shared -Recurse
        Run $script:SupabaseExe @('functions', 'deploy', '--project-ref', $ref, '--use-api', '--yes')
        Ok '服务器函数部署完成'

        Run $script:WranglerCmd @('pages', 'deploy', 'dist\web', '--project-name', $PagesProject, '--branch', 'main', '--commit-hash', $info.Commit, '--commit-dirty=true')
        Ok '网页部署完成'
    } finally { Pop-Location }

    Step '7. 核对线上版本'
    $got = ''
    for ($i = 0; $i -lt 20; $i++) {
        try { $got = (Invoke-RestMethod -Uri "$SiteOrigin/app/version.json" -Headers @{ 'Cache-Control' = 'no-cache' }).version } catch { $got = '' }
        if ($got -eq $info.Ver) { break }
        Start-Sleep -Seconds 6
    }
    if ($got -ne $info.Ver) { Fail "2 分钟后线上版本仍是“$got”，不是 $($info.Ver)。按上线与回滚手册处理" }
    Ok "线上已是 $($info.Ver)"
}

# ---------------------------------------------------------------- 主流程
$exitCode = 0
try {
    Say "柠檬记正式发布：$Tag    （$(Get-Date -Format 'yyyy-MM-dd HH:mm')）"
    $info = Invoke-Checks
    if ($CheckOnly) { Say ''; Say '只做检查（-CheckOnly），到此结束。'; return }
    Invoke-Backup $info
    Invoke-Build $info
    Install-Tools
    if ($DryRun) { Say ''; Say '演练（-DryRun）到此结束：没有输入令牌，没有部署任何东西。'; return }
    Invoke-Deploy $info
    Step '完成'
    Say "  $Tag 已发布。接下来："
    Say '  1. 在 docs\08-发布\发布记录.md 记一行（版本、时间、提交、产物指纹）；'
    Say '  2. 需要的话在 GitHub 网页（iPhone）上为这个 tag 建 Release；'
    Say '  3. 按上线与回滚手册做发布后的检查。'
} catch {
    $exitCode = 1
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    Clear-SecretEnv
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', $null, 'Process')
    if ($script:TokensRead) { Clear-Clip }
    if ($script:WorkDir -and (Test-Path -LiteralPath $script:WorkDir)) { Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
    $linkTemp = Join-Path $RepoPath 'supabase\.temp'
    if (Test-Path -LiteralPath $linkTemp) { Remove-Item -LiteralPath $linkTemp -Recurse -Force -ErrorAction SilentlyContinue }
    [GC]::Collect()
    Say ''
    Say '已清掉本窗口里的令牌、剪贴板和临时文件。请关掉这个 PowerShell 窗口。'
}
exit $exitCode
