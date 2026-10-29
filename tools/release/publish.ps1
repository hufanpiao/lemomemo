<#
.SYNOPSIS
  柠檬记正式发布（R-206）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行，不经过 Claude。

.DESCRIPTION
  GitHub 免费版私有仓库不能设“必须由负责人批准才发布”，所以正式环境的令牌不放 GitHub，
  正式发布由负责人本机运行本脚本，令牌每次发布前在网页上临时生成（建议 1 天到期）、粘贴进来，发完删掉（R-206、R-220：令牌不另存）。

  做的事（按顺序，任何一步不过就停）：
    1. 发布前检查：tag 格式、在 main 上、是带说明的 tag、当前检出的就是这个 tag、工作区干净、VERSION 一致、
       正式环境的公开配置文件在、工具锁文件在；git 的仓库配置和全局配置里没有 filter.*、core.attributesfile 之类的设置；
    2. 备份：E:\柠檬记-备份\版本前\ 下已有这个 tag 的“发布前”备份且恢复测试通过，没有就调 build\backup.py 做一份；
    3. 构建：npm ci --ignore-scripts → 白名单 rebuild → npm run build -- --mode production → 体积预算 → 不能有 source map；
       算产物指纹，请你在 iPhone 上打开 GitHub 里这个 tag 的 release-build 摘要页核对（R-206：CI 只构建和测试）；
       核对后记下 node_modules\aws4fetch 的哈希，把 dist\web 复制到临时目录（之后的核对和部署都用这一份）；
       -Only functions 时跳过这一步（不部署网页）；
    4. 装部署工具到临时目录：Supabase CLI（核对 tools\ci-tools.lock 里的 SHA-256）、wrangler（tools\deploy 的锁文件，
       装好后再核对整棵依赖树的哈希，tools\release\wrangler-tree.lock）；加 -Ops 时用 wrangler deploy --dry-run 把 lemo-ops 打包一遍（不上传）；
    —— -DryRun 到这里停 ——
    5. 再核对一次工作区干净、HEAD 是这个 tag、没有 .env / .env.local、临时目录里的网页、aws4fetch、supabase.exe、wrangler 都没被改过；
       确认 Windows 剪贴板历史已关、没有 transcript 和日志策略
       （R-223 起不再检查 Claude 是否在运行），然后按这次要部署的内容粘贴（屏幕不显示，粘贴后立即清剪贴板）：
       完整发布是 Supabase 令牌、数据库密码、Cloudflare 令牌三样；-Only functions -Ops 是 Supabase 令牌和 Cloudflare 令牌两样；
       -Only functions 不带 -Ops 只要 Supabase 令牌。加 -Ops 时改库之前先只读核对 Cloudflare 令牌有 Workers 权限、
       wrangler secret list 列出的 lemo-ops 密钥六个都在；
    6. 正式项目状态 → db push（先演练给你看，你输入“确认推送”才真推）→ functions deploy →（加 -Ops 时）lemo-ops → pages deploy；
    7. 核对 https://lemomemo.com/app/version.json；
    8. 不论成功失败：清掉本进程里的令牌、剪贴板、临时目录和 supabase link 的本地文件。

  令牌只在本进程的内存里（SecureString），不写文件、不进命令行参数（不会留在 PowerShell 历史里）、不打印；
  只在启动要用它的那个子进程时临时放进环境变量，子进程一结束就清掉（每个子进程只拿它要的那把，见 Invoke-WithSecrets）。

  usage-report（服务器函数）和 lemo-ops（Worker）必须同一次部署（上线与回滚手册第三节）：这个 tag 里两样都有时，
  不加 -Ops 第 1 步就停。回滚函数（-Only functions）时也一样，lemo-ops 跟着回到同一个 tag。

.PARAMETER Tag
  要发布的 tag，例如 v4.0.0。

.PARAMETER RepoPath
  仓库位置，默认 D:\claude code\柠檬记APP。本脚本应从“冻结副本”运行（见发布说明第二节），所以不靠脚本自己的位置找仓库。

.PARAMETER CheckOnly
  只做第 1 步发布前检查。

.PARAMETER DryRun
  做第 1～4 步（含备份和构建），在输入令牌之前停下。不需要令牌，可以随时演练。
  加 -Ops 时第 4 步还会用 wrangler deploy --dry-run 把 lemo-ops 打包一遍、列出绑定（不上传）。

.PARAMETER Ops
  同一次运行里接着服务器函数部署 lemo-ops Worker（workers\lemo-ops\wrangler.toml，用 tools\deploy 锁定版本的 wrangler，
  和网页同一把正式 Cloudflare 令牌，这把令牌要有 Pages: Edit ＋ Workers Scripts: Edit）。
  第 1 步核对 wrangler.toml 里 KV 的 id 已换成真的命名空间 ID（还是占位值就停）。

.PARAMETER Only
  只能写 functions：只重新部署这个 tag 的服务器函数（上线与回滚手册第四节第 2 层回滚用）。
  不构建网页、不 db push、不部署 Pages，也不要数据库密码；不加 -Ops 时也不要 Cloudflare 令牌。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File E:\柠檬记-发布\publish-v4.0.0.ps1 -Tag v4.0.0 -Ops

.EXAMPLE
  回滚服务器函数（先在冻结副本里 git switch --detach v4.0.0）：
  powershell -NoProfile -ExecutionPolicy Bypass -File E:\柠檬记-发布\publish-v4.0.0.ps1 -Tag v4.0.0 -Only functions -Ops
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
    [switch]$DryRun,
    [switch]$Ops,
    [ValidateSet('functions')][string]$Only = ''
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
# 主流程最前面建的空目录，GIT_CONFIG_* 把 core.hooksPath 指到这里，git 不执行任何钩子；finally 里删掉
$script:NoHooksDir = $null
# 预览专用函数的名单，第 1 步读（Invoke-Checks）
$script:PreviewFuncs = $null
# 要部署的服务器函数名（第 1 步按 git 跟踪的 supabase\functions\<名>\index.ts 列出，部署时逐个写出名字）
$script:FunctionNames = $null
# 第 3 步算出的 dist\web 指纹（@{ Count; Total }），部署网页前再算一次比对
$script:DistHash = $null
$script:TokensRead = $false
# 这次部署哪几样：-Only functions 时只有服务器函数（不构建网页、不 db push、不部署 Pages）；-Ops 时加上 lemo-ops
$script:DoWeb = ($Only -eq '')
$script:DoOps = [bool]$Ops
$script:NeedWrangler = ($script:DoWeb -or $script:DoOps)
$script:OpsConfig = 'workers\lemo-ops\wrangler.toml'
$script:OpsDotWrangler = $null
$script:EmptyEnvFile = $null
# 读进来的令牌：名字 → SecureString。平时不放进环境变量，Invoke-WithSecrets 调子进程时才设、子进程结束就清
$script:Secrets = @{}
$script:CfAccountId = $null
# wrangler：临时目录里的 tools\deploy 副本、直接用 node 跑的入口、第 4 步核对过的依赖树哈希（@{ Count; Total }）
$script:WranglerDir = $null
$script:WranglerJs = $null
$script:WranglerTree = $null
$script:WranglerTreeLock = 'tools\release\wrangler-tree.lock'
# 第 3 步之后 node_modules\aws4fetch 的哈希（functions\ 经 shared\objstore.ts 引入它，wrangler pages deploy 打包进 Functions）
$script:Aws4Hash = $null
# 第 3 步核对过的 dist\web 复制到临时目录的那一份；之后的核对和 pages deploy 都用它
$script:WebDir = $null
# lemo-ops 要的六个密钥（workers\lemo-ops\wrangler.toml 末尾的注释；tests/build/publish-run-deploy.test.ts 核对两边一致）
$script:OpsSecretNames = @('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'OPS_SECRET', 'RESEND_API_KEY_OPS', 'ALERT_TO', 'ALERT_FROM')

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
    # 双引号字符串里不能用中文弯引号：PowerShell 把它们当成引号，字符串会被截断（交付脚本先跑通的规矩）
    if ($ans.Trim() -ne $expected) { Fail "没有输入「$expected」，已取消" }
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
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', $null, 'Process')
}

# 架构 8.3a 冻结前五处之 ②（B1 接手清单 OPS-deploy ③）：每个子进程只给它要的那把令牌。
# 令牌平时只以 SecureString 留在 $script:Secrets 里，本进程的环境变量里没有；调某个子进程前才把它要的那几把设进本进程的环境变量
# （子进程启动时继承），子进程一结束（成功、失败都一样）立即清掉。于是 supabase 拿不到 Cloudflare 令牌、wrangler 拿不到 Supabase 令牌和数据库密码，
# git、python、npm 这些别的子进程什么令牌也拿不到。各处要哪几把：
#   supabase link、db push：Supabase 令牌 ＋ 数据库密码；supabase functions deploy：只要 Supabase 令牌；
#   wrangler secret list、wrangler deploy（lemo-ops）、wrangler pages deploy：只要 Cloudflare 令牌（Account ID 不是密钥，也只在这时设）；
#   wrangler deploy --dry-run：什么都不给。
# 本进程自己发的 HTTPS 请求（Invoke-RestMethod）直接从 SecureString 取值放进请求头，不经过环境变量。
# $action 里不要用 $sn、$secretNames、$action 这几个变量名（会被这里的同名变量盖住）
function Invoke-WithSecrets([string[]]$secretNames, [scriptblock]$action) {
    foreach ($sn in @($SecretEnvNames) + 'CLOUDFLARE_ACCOUNT_ID') {
        if ([Environment]::GetEnvironmentVariable($sn, 'Process')) { Fail "启动子进程之前本进程的环境变量里已经有 $sn（不该有）" }
    }
    try {
        foreach ($sn in $secretNames) {
            if (-not $script:Secrets.ContainsKey($sn)) { Fail "还没读 $sn" }
            Set-SecretEnv $sn $script:Secrets[$sn]
        }
        if ($secretNames -contains 'CLOUDFLARE_API_TOKEN') { [Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', $script:CfAccountId, 'Process') }
        & $action
    } finally {
        Clear-SecretEnv
    }
}

# 本进程自己发请求用：从 SecureString 取出值拼成请求头（只在请求头里，用完调用方把变量置空）
function Get-BearerHeader([string]$name) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($script:Secrets[$name])
    try { return @{ Authorization = 'Bearer ' + [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Test-SecretPrefix([Security.SecureString]$sec, [string]$prefix) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).StartsWith($prefix) } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Clear-Secrets {
    foreach ($s in @($script:Secrets.Values)) { try { $s.Dispose() } catch { } }
    $script:Secrets.Clear()
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
    Assert-NoHiddenGitState
    Assert-NoRiskyGitConfig

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

    $need = @('tools\ci-tools.lock', 'tools\deploy\package.json', 'tools\deploy\package-lock.json', 'build\backup.py', 'build\ci\dist_hash.py')
    if ($script:NeedWrangler) { $need += $script:WranglerTreeLock }
    foreach ($f in $need) {
        if (-not (Test-Path -LiteralPath (Join-Path $RepoPath $f))) { Fail "缺 $f" }
    }
    Ok '工具锁文件和脚本都在'

    # 预览专用函数的名单（build\check_backend.py 的 PREVIEW_FUNCS，名单只写那一处）。在这里读：此时还没输入任何令牌，
    # 不让带令牌的进程去跑仓库里的脚本；部署前的检查（Assert-NoPreviewFunctions）只用 PowerShell 查文件
    # 先跑一次完整的后端越界检查（含 F6：config.toml 和预览专用函数），失败就停（B1 接手清单 P-r2probe）。
    # check_backend 用 tomllib 解析 config.toml，要 Python 3.11 以上
    # 参数里不能用双引号：Windows PowerShell 5.1 传给外部程序时会把双引号吞掉
    $pyVer = & python -I -c 'import sys; print(''%d.%d'' % sys.version_info[:2])'
    if ($LASTEXITCODE -ne 0 -or [version]"$pyVer" -lt [version]'3.11') { Fail "要 Python 3.11 以上（现在是 $pyVer）" }
    Push-Location $RepoPath
    # 输出送到屏幕（Out-Host）：不送的话会混进本函数的返回值，主流程拿到的就不是 @{ Ver; Commit }
    try { & python -I 'build\check_backend.py' | Out-Host; $code = $LASTEXITCODE } finally { Pop-Location }
    if ($code -ne 0) { Fail '后端越界检查没通过（python -I build\check_backend.py），先修好再发布' }
    Ok "后端越界检查通过（Python $pyVer）"
    Push-Location $RepoPath
    try { $names = & python -I 'build\check_backend.py' '--print-preview-funcs'; $code = $LASTEXITCODE } finally { Pop-Location }
    if ($code -ne 0) { Fail '读不出预览专用函数的名单（python -I build\check_backend.py --print-preview-funcs）' }
    $script:PreviewFuncs = @($names | ForEach-Object { "$_".Trim() } | Where-Object { $_ -ne '' })
    foreach ($n in $script:PreviewFuncs) { if ($n -notmatch '^[a-z][a-z0-9-]{0,62}$') { Fail '预览专用函数名单里有不合规的名字' } }
    Assert-NoPreviewFunctions
    Assert-OpsPlan
    Assert-NoDotEnv
    Assert-NoWranglerConfigUpward
    Assert-CleanProcessEnv
    Assert-NoIgnoredDeployFiles
    $script:FunctionNames = @(Get-DeployFunctionNames)
    Ok "要部署的服务器函数：$($script:FunctionNames -join '、')"
    return @{ Ver = $ver; Commit = $tagCommit }
}

# usage-report 和 lemo-ops 必须同一次部署（上线与回滚手册第三节，B1 接手清单 OPS-mail-sugg ②、OPS-deploy）：
# 每次部署服务器函数都会带上 usage-report，所以这个 tag 里两样都有时必须加 -Ops，回滚时 lemo-ops 也就跟着回到同一个 tag。
# 加 -Ops 时核对 wrangler.toml：名字是 lemo-ops，KV 的 id 已换成真的命名空间 ID（32 位十六进制；占位值部署会失败，在这里先停）。
function Assert-OpsPlan {
    $opsToml = Join-Path $RepoPath $script:OpsConfig
    $usage = Join-Path $RepoPath 'supabase\functions\usage-report'
    if (-not $script:DoOps) {
        if ((Test-Path -LiteralPath $usage) -and (Test-Path -LiteralPath $opsToml)) {
            Fail 'usage-report 和 lemo-ops 必须同一次部署（上线与回滚手册第三节）：这个 tag 里两样都有，请加 -Ops 重新运行'
        }
        Ok '这次不部署 lemo-ops（这个 tag 里没有 usage-report 或 lemo-ops，不要求同一次部署）'
        return
    }
    if (-not (Test-Path -LiteralPath $opsToml)) { Fail "加了 -Ops，但这个 tag 里没有 $($script:OpsConfig)" }
    $text = Get-Content -LiteralPath $opsToml -Raw -Encoding UTF8
    # 区分大小写（-cmatch）：名字只认小写 lemo-ops，KV id 只认 Cloudflare 给的小写十六进制
    if ($text -cnotmatch '(?m)^\s*name\s*=\s*"lemo-ops"\s*$') { Fail "$($script:OpsConfig) 里的 name 不是 lemo-ops" }
    $ids = @([regex]::Matches($text, '(?m)^\s*id\s*=\s*"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    if ($ids.Count -eq 0) { Fail "$($script:OpsConfig) 里没有 KV 命名空间的 id" }
    foreach ($id in $ids) {
        if ($id -cnotmatch '^[0-9a-f]{32}$') { Fail "$($script:OpsConfig) 里 KV 的 id 还是占位值或格式不对（要换成正式账号里真的命名空间 ID，见上线与回滚手册第三节「部署 lemo-ops」）" }
    }
    Ok 'lemo-ops 的配置可以部署（名字对，KV 的 id 已填）'
}

# wrangler 默认会读当前目录下的 .env、.env.local（被 git 忽略，工作区检查看不见）：
# 有人往里写 CLOUDFLARE_API_BASE_URL，令牌就会被带到别的服务器。所以这几个文件存在就停（输入令牌之前查），
# 每次调用 wrangler 都加 --env-file <空文件>（不再读默认的 .env），本进程里也明确设好 CLOUDFLARE_API_BASE_URL。
# .env.production.local 是构建用的公开值，照第 1 步原来的检查办，不在这里。
# Supabase CLI 2.120.0（supabase.exe 的 JS 层）也会读 supabase\ 和仓库根目录的 .env.<SUPABASE_ENV>.local、.env.local、.env.<SUPABASE_ENV>、.env
# （SUPABASE_ENV 没设时是 development），管理接口地址取 SUPABASE_API_URL；本进程的环境变量优先于这些文件，所以下面也明确设好 SUPABASE_API_URL。
# 根目录的 .env.production 也拦（构建只该用 .env.production.local）。
function Assert-NoDotEnv {
    $found = @()
    foreach ($n in '.env', '.env.local', '.env.development', '.env.development.local', '.env.production') {
        if (Test-Path -LiteralPath (Join-Path $RepoPath $n)) { $found += $n }
    }
    foreach ($sub in 'workers\lemo-ops', 'supabase') {
        $d = Join-Path $RepoPath $sub
        if (Test-Path -LiteralPath $d) {
            foreach ($f in @(Get-ChildItem -LiteralPath $d -Force -Filter '.env*' -ErrorAction SilentlyContinue)) { $found += "$sub\$($f.Name)" }
        }
    }
    if ($found.Count -gt 0) { Fail "仓库里有 wrangler 或 Supabase CLI 会自动读的环境文件：$($found -join '、')。里面的设置可能把令牌带到别的服务器，请先移出仓库目录再运行" }
    Ok '没有 wrangler、Supabase CLI 会自动读的 .env 文件'
}

# wrangler pages deploy 没有 --config 参数，会从当前目录（仓库根目录）一路往上找到盘符根：
# wrangler.json / wrangler.jsonc / wrangler.toml，以及重定向文件 .wrangler\deploy\config.json；
# 配置里有 pages_build_output_dir 就会被采用，里面的 vars 和绑定会跟着正式部署上线（例如把 SUPABASE_UPSTREAM 指到别人的服务器）。
# 仓库外的、被 git 忽略的这些文件工作区检查看不见，所以每一级都查，有就停。
# 也不能换到临时目录里跑：Pages Functions 取的是当前目录下的 functions\（wrangler 4.150.0 cli.js:306603），functions\ 里有相对路径的 import。
# lemo-ops 的 wrangler deploy 带了 --config，不往上找、不走重定向；它目录下的重定向文件也一并拦。
function Assert-NoWranglerConfigUpward {
    $found = @()
    $d = (Resolve-Path -LiteralPath $RepoPath).ProviderPath
    while ($d) {
        foreach ($n in 'wrangler.json', 'wrangler.jsonc', 'wrangler.toml', '.wrangler\deploy\config.json') {
            $p = Join-Path $d $n
            if (Test-Path -LiteralPath $p) { $found += $p }
        }
        $parent = Split-Path -Path $d -Parent
        if (-not $parent -or $parent -eq $d) { break }
        $d = $parent
    }
    $opsRedirect = Join-Path $RepoPath 'workers\lemo-ops\.wrangler\deploy\config.json'
    if (Test-Path -LiteralPath $opsRedirect) { $found += $opsRedirect }
    if ($found.Count -gt 0) { Fail "发现 wrangler 部署网页时会自动采用的配置文件：$($found -join '、')。里面的变量和绑定会跟着上线，请先移走再运行" }
    Ok '仓库目录和各级父目录都没有 wrangler 配置或重定向文件'
}

# 这些环境变量会改 HTTPS 去向、关证书校验、往 node 里塞代码，或者让 wrangler 不用这次粘贴的令牌（global key ＋ email 优先于令牌）。
# 选择“有就停”而不是悄悄清掉：它们不该出现在发布窗口里，出现了说明这台电脑或这个窗口的环境不对，要负责人知道；清掉反而会掩盖问题。
# 开一个新的 PowerShell 窗口通常就没有了；系统里设了的，在 系统 › 高级系统设置 › 环境变量 里删。
# CLOUDFLARE_API_BASE_URL、SUPABASE_API_URL 由本脚本在第 4 步设成官方地址：第 1 步不许预先有，第 5 步核对是官方地址。
$script:ForbiddenEnv = @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
    'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'SUPABASE_ENV', 'SUPABASE_DASHBOARD_URL', 'SUPABASE_PROJECT_HOST',
    # 窗口里预先有的令牌会被每个子进程继承，“每个子进程只拿它要的那把”（Invoke-WithSecrets）就做不到了
    'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID')
$script:PinnedEnv = [ordered]@{ CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4'; SUPABASE_API_URL = 'https://api.supabase.com' }
function Assert-CleanProcessEnv([switch]$AfterSetup) {
    $bad = @($script:ForbiddenEnv | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') })
    foreach ($n in $script:PinnedEnv.Keys) {
        $v = [Environment]::GetEnvironmentVariable($n, 'Process')
        if (-not $AfterSetup) { if ($v) { $bad += $n } }
        elseif ($v -and $v -cne $script:PinnedEnv[$n]) { $bad += $n }
    }
    if ($bad.Count -gt 0) { Fail "这个窗口里有不该有的环境变量：$($bad -join '、')（会改令牌发往哪里或怎么校验）。请开一个新的 PowerShell 窗口；系统环境变量里设了的先删掉再运行" }
    Ok '没有代理、关证书校验、global key 之类的环境变量'
}

# 输入令牌之前再核对一次：工作区仍干净、HEAD 仍是这个 tag、lemo-ops 的计划和配置没变、没有 .env
# （第 1 步之后这段时间里文件可能被改；-Only functions 不构建，没有第 3 步的那次检查）
function Assert-StillClean($info) {
    Assert-NoHiddenGitState
    Assert-NoRiskyGitConfig
    $dirty = Invoke-Git @('status', '--porcelain', '--untracked-files=all')
    if ($dirty) { Fail "第 1 步之后工作区多了改动或文件：`n$dirty" }
    if ((Invoke-Git @('rev-parse', 'HEAD')) -ne $info.Commit) { Fail "第 1 步之后 HEAD 变了，不再是 $Tag" }
    Ok "工作区仍干净，HEAD 仍是 $Tag"
    Assert-OpsPlan
    Assert-NoDotEnv
    Assert-NoWranglerConfigUpward
    Assert-CleanProcessEnv -AfterSetup
    Assert-NoIgnoredDeployFiles
    $names = @(Get-DeployFunctionNames)
    if (($names -join ',') -cne ($script:FunctionNames -join ',')) { Fail '第 1 步之后要部署的服务器函数名单变了' }
}

# .git\index 里的 assume-unchanged（git ls-files -v 显示小写字母）和 skip-worktree（显示 S）标记，
# 能让改过的已跟踪文件在 git status 里看起来是干净的；稀疏检出也会让一部分文件不在工作区里（B0 复查 M3）。有就停。
function Assert-NoHiddenGitState {
    $gitDir = Join-Path $RepoPath '.git'
    # .git 是文件（gitdir: 指向别处）时，下面查的 .git\info 就不是 git 真正用的那份
    if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) { Fail "$gitDir 不是目录（工作树或 gitdir 指向别处的副本不能用来发布），请用普通的 git clone" }
    $out = Invoke-Git @('-c', 'core.quotepath=false', 'ls-files', '-v')
    $bad = @($out -split "`r?`n" | Where-Object { $_ -cmatch '^([a-z]|S) ' } | ForEach-Object { $_.Substring(2) })
    if ($bad.Count -gt 0) {
        $show = @($bad | Select-Object -First 10) -join '、'
        Fail "仓库里有文件被标成 assume-unchanged 或 skip-worktree（改了也不在 git status 里显示）：$show$(if ($bad.Count -gt 10) { " 等 $($bad.Count) 个" })。请先 git update-index --no-assume-unchanged / --no-skip-worktree 去掉标记，或重新 clone"
    }
    if (Test-Path -LiteralPath (Join-Path $gitDir 'info\sparse-checkout')) { Fail '仓库开了稀疏检出（.git\info\sparse-checkout 存在），不能用来发布，请用普通的 git clone' }
    if ((Invoke-Git @('config', '--bool', '--get', 'core.sparseCheckout') -allowFail) -eq 'true') { Fail '仓库开了稀疏检出（core.sparseCheckout = true），不能用来发布，请用普通的 git clone' }
    Ok '没有 assume-unchanged / skip-worktree 标记，没有稀疏检出'
}

# .git\config 里这些设置会让 git 执行别的程序、读别处的配置或属性、换工作区（B0 复查 M4）：
# filter.*（检出、status 时跑过滤程序）、include.* / includeif.*（再读一份配置）、core.worktree、core.attributesfile、core.hookspath、core.fsmonitor。
# git config --local --list --name-only 本身不触发 fsmonitor；主流程最前面也已用 GIT_CONFIG_* 把 fsmonitor 关掉、把 hooksPath 指到空目录。
# .git\info\attributes 不为空也停（里面可以给文件挂 filter）。
# core.hookspath 只放行项目规定的那一种（npm run hooks:install，提交前的密钥检查）：发布时不用先卸掉钩子再装回，免得忘了装回去。
# 放行的依据是主流程最前面的覆盖：GIT_CONFIG_KEY_1=core.hooksPath 指到一个空的临时目录，本进程和子进程（wrangler、supabase）里的 git
# 都不执行 .git\hooks\、.githooks\ 里的任何钩子（git status 写回索引时的 post-index-change 也不执行，B0 复查 M5）。
# 这里读的是 .git\config 里的原值（--local 不受 GIT_CONFIG_* 影响）。放行条件仍然必须同时满足：
# 值规范化后（相对路径按仓库根目录算）和 <RepoPath>\.githooks 完全相等（不区分大小写）；.githooks 是普通目录，
# 下面每个文件都被 git 跟踪（git ls-files --others 不带 --exclude-standard：未跟踪的和被忽略的都列出来）；工作区干净由第 1 步、第 5 步原有的检查保证。
function Test-AllowedHooksPath {
    $v = Invoke-Git @('config', '--local', '--get', 'core.hookspath') -allowFail
    if (-not $v) { return $false }
    $want = Join-Path $RepoPath '.githooks'
    if (-not (Test-Path -LiteralPath $want -PathType Container)) { return $false }
    if ((Get-Item -LiteralPath $want -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    $p = if ([IO.Path]::IsPathRooted($v)) { $v } else { Join-Path $RepoPath $v }
    try { $got = (Resolve-Path -LiteralPath $p -ErrorAction Stop).ProviderPath } catch { return $false }
    $wantFull = (Resolve-Path -LiteralPath $want).ProviderPath
    if (-not [string]::Equals($got.TrimEnd('\', '/'), $wantFull.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $extra = Invoke-Git @('-c', 'core.quotepath=false', 'ls-files', '--others', '--', '.githooks')
    if ($extra) { Fail ".githooks 下有没被 git 跟踪的文件（含被忽略的）：$(($extra -split "`r?`n") -join '、')。core.hookspath 指向这里时，.githooks 下只许有被跟踪的文件" }
    Ok 'core.hookspath 指向本仓库被跟踪的 .githooks（提交前的密钥检查钩子），放行'
    return $true
}

function Assert-NoRiskyGitConfig {
    $attr = Join-Path $RepoPath '.git\info\attributes'
    if ((Test-Path -LiteralPath $attr) -and (Get-Item -LiteralPath $attr).Length -gt 0) { Fail '.git\info\attributes 不是空的（里面可以给文件挂过滤程序），请先删掉再运行' }
    $out = Invoke-Git @('config', '--local', '--list', '--name-only')
    $bad = @($out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object {
            $_ -imatch '^(filter|include|includeif)\.' -or $_ -iin 'core.worktree', 'core.attributesfile', 'core.hookspath', 'core.fsmonitor'
        } | Sort-Object -Unique)
    if ($bad -contains 'core.hookspath' -and (Test-AllowedHooksPath)) { $bad = @($bad | Where-Object { $_ -ne 'core.hookspath' }) }
    if ($bad.Count -gt 0) { Fail "仓库的 .git\config 里有发布时不许有的设置：$($bad -join '、')（会让 git 执行别的程序或读别处的配置）。请在发布用的副本里用 git config --local --unset 去掉（core.hookspath 发布完再设回），或重新 clone" }
    Ok '.git\config 里没有过滤程序、include、hooksPath、fsmonitor 之类的设置，.git\info\attributes 为空'
    Assert-NoRiskyGlobalGitConfig
}

# B1 接手清单 OPS-deploy ⑧：全局配置（~\.gitconfig，以及它 include 进来的文件）里的 filter.*、core.attributesfile 一样会被这个仓库的 git 用上：
# 全局的属性文件给文件挂上 filter，检出、status 时就会跑全局配置里的过滤程序。所以用 git config --show-origin --list
# （加 --show-scope 区分哪一级、--name-only 不取值）逐条看，global 一级有 filter.* 或 core.attributesfile 就停，并报出是哪个文件；
# include 进来的设置 git 会按所在的那一级列出，一并查到。没设 core.attributesfile 时 git 也会读默认的全局属性文件
# （git var GIT_ATTR_GLOBAL，一般是 ~\.config\git\attributes），它不为空也停（和 .git\info\attributes 同一个道理）。
# GIT_CONFIG_GLOBAL 之类改全局配置位置的环境变量，主流程最前面已经拦了。system 一级（Git for Windows 安装目录的 etc\gitconfig）不在这一条里。
function Assert-NoRiskyGlobalGitConfig {
    $out = Invoke-Git @('config', '--show-scope', '--show-origin', '--list', '--name-only')
    $bad = @()
    foreach ($l in ($out -split "`r?`n")) {
        $c = $l -split "`t"
        if ($c.Count -lt 3 -or $c[0] -ne 'global') { continue }
        $name = $c[-1].Trim()
        if ($name -imatch '^filter\.' -or $name -ieq 'core.attributesfile') { $bad += "$name（$($c[1] -replace '^file:', '')）" }
    }
    $bad = @($bad | Sort-Object -Unique)
    if ($bad.Count -gt 0) { Fail "git 的全局配置里有发布时不许有的设置：$($bad -join '、')（会让这个仓库的 git 执行别的程序或读别处的属性文件）。请先用 git config --global --unset 去掉（或从括号里那个文件删掉），发布完再加回" }
    $attr = Invoke-Git @('var', 'GIT_ATTR_GLOBAL') -allowFail
    if ($LASTEXITCODE -eq 0 -and $attr -and (Test-Path -LiteralPath $attr -PathType Leaf) -and (Get-Item -LiteralPath $attr -Force).Length -gt 0) {
        Fail "git 的全局属性文件 $attr 不是空的（里面可以给文件挂过滤程序）。请先移走，发布完再放回"
    }
    Ok 'git 的全局配置里没有 filter.*、core.attributesfile，全局属性文件不存在或为空'
}

# 被 git 忽略的文件 git status 看不见，却会跟着正式部署上线（B0 复查 M2）：
# wrangler pages deploy 打包 functions\ 下的文件，supabase functions deploy 打包函数目录和它 import 到的文件。
# 所以 functions\、supabase\functions\ 下有被忽略的文件就停。supabase\functions\_shared\gen\ 除外：
# 第 6 步部署函数前会把它删掉、从 shared\ 重新复制。core.quotepath=false：中文文件名照原样列出。
function Assert-NoIgnoredDeployFiles {
    $out = Invoke-Git @('-c', 'core.quotepath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--', 'functions', 'supabase/functions')
    $bad = @($out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('supabase/functions/_shared/gen/') })
    if ($bad.Count -gt 0) { Fail "functions\ 或 supabase\functions\ 下有被 git 忽略的文件，会跟着正式部署上线：$($bad -join '、')。请先移出仓库目录再运行" }
    Ok 'functions\、supabase\functions\ 下没有被 git 忽略的文件（_shared\gen 部署前重建，不算）'
}

# 要部署的服务器函数：supabase\functions 下被 git 跟踪、并且有 index.ts 的目录（_ 开头的是共用代码，不是函数）。
# 部署时逐个写出名字（Supabase CLI 2.120.0：functions deploy [<Function name...>]，可以一次传多个），
# 不用“不写名字＝全部部署”：那样会把目录里其他东西和 config.toml 里声明的函数一起带上去。
function Get-DeployFunctionNames {
    $out = Invoke-Git @('-c', 'core.quotepath=false', 'ls-files', '--', 'supabase/functions')
    $list = New-Object 'System.Collections.Generic.List[string]'
    foreach ($l in ($out -split "`r?`n")) {
        $l = $l.Trim()
        if ($l -inotmatch '^supabase/functions/([^/]+)/index\.ts$') { continue }
        # 入口文件名大小写不对（例如 Index.ts）：在区分大小写的部署环境里不是入口，不悄悄跳过，直接停
        $n = $Matches[1]
        if ($l -cnotmatch '^supabase/functions/[^/]+/index\.ts$') { Fail "$l 的文件名大小写不对，入口必须是小写的 index.ts" }
        if ($n.StartsWith('_')) { continue }
        if ($n -cnotmatch '^[a-z][a-z0-9-]{0,62}$') { Fail "supabase\functions\$n 的名字不合规（只许小写字母、数字和 -）" }
        if (@($script:PreviewFuncs) -contains $n) { Fail "supabase\functions\$n 是预览专用函数，正式环境不能部署它" }
        $list.Add($n)
    }
    if ($list.Count -eq 0) { Fail 'supabase\functions 下没有被 git 跟踪的函数（<名>\index.ts）' }
    $arr = $list.ToArray()
    [Array]::Sort($arr, [StringComparer]::Ordinal)
    return $arr
}

# dist\web 的指纹，算法和 build\ci\dist_hash.py 完全一样（每个文件“SHA-256␠␠相对路径\n”按路径的 UTF-8 字节排序，再整体算 SHA-256）。
# 用 PowerShell 算：部署网页时进程里已经有令牌，不在这时跑仓库里的 Python 脚本。第 3 步会和 dist_hash.py 的结果对一遍，保证两边算法一致。
# 同一个算法也用来给装好的 wrangler 依赖树（第 4 步）、node_modules\aws4fetch（第 3 步之后）记哈希。
function Get-DistHash([string]$dir) {
    $root = (Resolve-Path -LiteralPath $dir).ProviderPath.TrimEnd('\')
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $rows = New-Object 'System.Collections.Generic.List[string[]]'
    # 逐个文件用同一个 SHA256 对象流式算（依赖树有一千多个文件，逐个调 Get-FileHash 太慢）
    $fsha = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($f in @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
            if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$dir 里不应有符号链接或联接：$($f.FullName)" }
            if ($f.PSIsContainer) { continue }
            $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
            # 排序键：路径 UTF-8 字节的十六进制（每个字节两位、中间用 - 隔开），按序号比较就等于按字节排序
            $key = [BitConverter]::ToString($utf8.GetBytes($rel))
            $fs = [IO.File]::OpenRead($f.FullName)
            try { $fh = [BitConverter]::ToString($fsha.ComputeHash($fs)).Replace('-', '').ToLowerInvariant() } finally { $fs.Dispose() }
            $rows.Add(@($key, $rel, $fh))
        }
    } finally { $fsha.Dispose() }
    if ($rows.Count -eq 0) { Fail "目录是空的：$dir" }
    $keys = @($rows | ForEach-Object { $_[0] })
    $arr = $rows.ToArray()
    [Array]::Sort([string[]]$keys, $arr, [StringComparer]::Ordinal)
    $sb = New-Object System.Text.StringBuilder
    foreach ($r in $arr) { [void]$sb.Append("$($r[2])  $($r[1])`n") }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $total = -join ($sha.ComputeHash($utf8.GetBytes($sb.ToString())) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
    return @{ Count = $rows.Count; Total = $total }
}

# 每次调用 wrangler 都带 --env-file <空文件>，不读仓库里的 .env、.env.local。
# 用 node 直接跑 wrangler 包里的 bin\wrangler.js：npm 生成的 .bin\wrangler.cmd 随本机 npm 版本变，第 4 步核对依赖树哈希前已删掉（Assert-WranglerTree）。
# -WithToken：这次要连 Cloudflare，只把 Cloudflare 令牌（和 Account ID）给这一个子进程（Invoke-WithSecrets）；不加时什么令牌都不给
function Get-WranglerArgs([string[]]$argv) { return @($script:WranglerJs) + $argv + @('--env-file', $script:EmptyEnvFile) }
function Run-Wrangler([string[]]$argv, [switch]$WithToken) {
    $full = Get-WranglerArgs $argv
    if ($WithToken) { Invoke-WithSecrets @('CLOUDFLARE_API_TOKEN') { Run 'node' $full } } else { Run 'node' $full }
}

# B1 接手清单 OPS-deploy ②：npm ci 只按 package-lock.json 的 integrity 核对下载的包；装好以后整棵依赖树再核对一次
# （解包后的文件被换、npm 缓存被动过，integrity 都看不出来）。tools\release\wrangler-tree.lock 记着三样：
# 这份 tools\deploy\package-lock.json 的 SHA-256、node_modules 的文件数和树哈希（算法同 Get-DistHash）。
# node_modules\.bin（npm 生成的启动脚本）和 node_modules\.package-lock.json（npm 的安装记录）内容随本机 npm 版本变、部署也用不到：
# 先删掉，剩下的每个文件都进哈希；wrangler 用 node 直接跑包里的 bin\wrangler.js（Run-Wrangler）。
# 升级 wrangler（改 tools\deploy 的锁文件）时要一起重算 wrangler-tree.lock：对不上时这里会打印实际的文件数和树哈希，核实后写进去、随代码审查提交。
function Get-WranglerTreeLock {
    $p = Join-Path $RepoPath $script:WranglerTreeLock
    $rows = @(Get-Content -LiteralPath $p -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') })
    $c = if ($rows.Count -eq 1) { @($rows[0] -split '\s+') } else { @() }
    if ($c.Count -ne 3 -or $c[0] -cnotmatch '^[0-9a-f]{64}$' -or $c[1] -notmatch '^[1-9][0-9]*$' -or $c[2] -cnotmatch '^[0-9a-f]{64}$') {
        Fail "$($script:WranglerTreeLock) 的格式不对（要有且只有一行：package-lock.json 的 SHA-256、文件数、树哈希）"
    }
    return @{ Lock = $c[0]; Count = [int]$c[1]; Total = $c[2] }
}

function Assert-WranglerTree {
    $want = Get-WranglerTreeLock
    $lockSha = (Get-FileHash -LiteralPath (Join-Path $script:WranglerDir 'package-lock.json') -Algorithm SHA256).Hash.ToLower()
    if ($lockSha -cne $want.Lock) { Fail "tools\deploy\package-lock.json 和 $($script:WranglerTreeLock) 记的不是同一份（改了 package-lock.json 要一起重算树哈希）" }
    $nm = Join-Path $script:WranglerDir 'node_modules'
    foreach ($x in '.bin', '.package-lock.json') {
        $p = Join-Path $nm $x
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
    }
    $script:WranglerJs = Join-Path $nm 'wrangler\bin\wrangler.js'
    if (-not (Test-Path -LiteralPath $script:WranglerJs -PathType Leaf)) { Fail '没装上 wrangler（找不到 node_modules\wrangler\bin\wrangler.js）' }
    $got = Get-DistHash $nm
    if ($got.Count -ne $want.Count -or $got.Total -cne $want.Total) {
        Fail "装好的 wrangler 依赖树和 $($script:WranglerTreeLock) 对不上：实际文件数 $($got.Count)、树哈希 $($got.Total)；锁里是 $($want.Count)、$($want.Total)。还没输入任何令牌。没改过 tools\deploy 就不要继续，请在聊天里告诉运维"
    }
    $script:WranglerTree = $got
    Ok "wrangler 依赖树和 $($script:WranglerTreeLock) 一致（$($got.Count) 个文件）"
}

# 第 3 步之后给 node_modules\aws4fetch 记哈希（B1 接手清单 OPS-deploy ⑥）：functions\ 经 shared\objstore.ts 引入它，
# wrangler pages deploy 打包 Functions 时从仓库的 node_modules 里取；它被 git 忽略，工作区检查看不见。改库前、部署网页前各再比一次
function Get-Aws4Hash {
    $d = Join-Path $RepoPath 'node_modules\aws4fetch'
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { Fail '找不到 node_modules\aws4fetch（第 3 步 npm ci 之后应该有）' }
    if ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'node_modules\aws4fetch 是符号链接或联接，不能用来发布' }
    return Get-DistHash $d
}

function Assert-Aws4Unchanged([string]$state) {
    if ($null -eq $script:Aws4Hash) { Fail '没有第 3 步记下的 aws4fetch 哈希' }
    $now = Get-Aws4Hash
    if ($now.Count -ne $script:Aws4Hash.Count -or $now.Total -cne $script:Aws4Hash.Total) { Fail "node_modules\aws4fetch 和第 3 步之后记下的不一样了（被改过）。现在：$state" }
    Ok 'node_modules\aws4fetch 和第 3 步之后记下的一致'
}

# 临时目录里那份网页（第 3 步核对过的 dist\web 的副本，B1 接手清单 OPS-deploy ⑦）仍和第 3 步的指纹一致
function Assert-WebCopyUnchanged([string]$state) {
    if ($null -eq $script:DistHash -or $null -eq $script:WebDir) { Fail '没有第 3 步的产物指纹或临时目录里的网页副本' }
    $now = Get-DistHash $script:WebDir
    if ($now.Count -ne $script:DistHash.Count -or $now.Total -cne $script:DistHash.Total) { Fail "临时目录里的网页和第 3 步核对过的指纹不一样了（被改过）。现在：$state" }
    Ok '临时目录里的网页仍是第 3 步核对过的产物'
}

function New-WorkDir {
    if ($script:WorkDir) { return }
    $script:WorkDir = Join-Path $env:TEMP ("lemo-publish-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:WorkDir | Out-Null
}

# 改库之前只读核对 lemo-ops 的六个密钥都设好了（B1 接手清单 OPS-deploy ⑤）：wrangler secret list 只列名字和类型，不返回值。
# 没设齐就部署，lemo-ops 照样上线，但发不出告警、认不了 usage-report；这里先停，还没改库。
# 输出只取名字，不打印；只给这一个 wrangler 子进程 Cloudflare 令牌
function Assert-OpsSecrets {
    $full = Get-WranglerArgs @('secret', 'list', '--config', $script:OpsConfig, '--format', 'json')
    Push-Location $RepoPath
    try {
        $out = Invoke-WithSecrets @('CLOUDFLARE_API_TOKEN') {
            $o = @(& node @full)
            if ($LASTEXITCODE -ne 0) { Fail "wrangler secret list 退出码 $LASTEXITCODE（读不了 lemo-ops 的密钥名单）。还没改库" }
            $o
        }
    } finally { Pop-Location }
    $text = (@($out) | ForEach-Object { "$_" }) -join "`n"
    $i = $text.IndexOf('[')
    $j = $text.LastIndexOf(']')
    $names = @()
    try {
        if ($i -lt 0 -or $j -lt $i) { throw 'no json' }
        # Windows PowerShell 5.1 的 ConvertFrom-Json 把整个数组当一个对象送进管道：先赋给变量，foreach 才是逐个元素
        $parsed = ConvertFrom-Json -InputObject $text.Substring($i, $j - $i + 1)
        foreach ($s in $parsed) {
            if ($null -ne $s -and $s.PSObject.Properties.Name -contains 'name') { $names += [string]$s.name }
        }
    } catch { Fail '读不懂 wrangler secret list 的结果（应是 JSON 名单）。还没改库' }
    $missing = @($script:OpsSecretNames | Where-Object { $names -cnotcontains $_ })
    if ($missing.Count -gt 0) { Fail "lemo-ops 还缺这些密钥：$($missing -join '、')（wrangler secret list 只读核对）。还没改库。按上线与回滚手册第三节「部署 lemo-ops」设好再原样重跑" }
    Ok "lemo-ops 的六个密钥都在（wrangler secret list 只读核对，只看名字）"
}

# db push 之前的只读预检：这把 Cloudflare 令牌能读本账号的 Worker 列表（Workers Scripts 权限）。
# 只发到固定的 api.cloudflare.com，令牌只在请求头里；失败只报 HTTP 状态码，不打印返回内容
function Assert-WorkersAccess {
    $uri = "https://api.cloudflare.com/client/v4/accounts/$($script:CfAccountId)/workers/scripts"
    $hdr = Get-BearerHeader 'CLOUDFLARE_API_TOKEN'
    $code = ''
    try { $r = Invoke-RestMethod -Uri $uri -Headers $hdr -MaximumRedirection 0 } catch {
        $hdr = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        Fail "这把 Cloudflare 令牌读不了 Worker 列表（HTTP $code）：要有 Workers Scripts: Edit，Account ID 也要对。还没改库，换一把令牌重新运行"
    }
    $hdr = $null
    if ($null -eq $r -or -not ($r.PSObject.Properties.Name -contains 'success') -or $r.success -ne $true) { Fail '这把 Cloudflare 令牌读不了 Worker 列表：要有 Workers Scripts: Edit。还没改库，换一把令牌重新运行' }
    Ok 'Cloudflare 令牌有 Workers 权限（只读预检）'
}

# 正式环境不能带上预览专用函数（架构 6.2 末尾预览专用一行，check_backend F6；B0 审查中 2）：
# supabase\functions\ 下不能有和名单同名的目录（入口只许 deploy-preview.yml 在预览产物里生成），
# supabase\config.toml 里不能出现 _preview，也不能声明 [functions.<预览专用函数名>]（CLI 会部署配置里声明的函数）。
# 第 1 步查一次；第 4 步装完工具、第 5 步输入令牌之前再查一次（第二轮审查中 B：不能在输令牌、db push 之后才失败）。
# 以后改成“下载 CI 产物部署”时，这个断言要改成查下载下来的产物，不是查本机工作区。
function Assert-NoPreviewFunctions {
    if ($null -eq $script:PreviewFuncs) { Fail '还没读预览专用函数的名单' }
    $fnDir = Join-Path $RepoPath 'supabase\functions'
    foreach ($n in $script:PreviewFuncs) {
        if (Test-Path -LiteralPath (Join-Path $fnDir $n)) { Fail "supabase\functions\$n 存在：$n 是预览专用函数，正式环境不能部署它" }
    }
    $cfg = Join-Path $RepoPath 'supabase\config.toml'
    if (Test-Path -LiteralPath $cfg) {
        $text = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8
        if ($text -match '(?<![A-Za-z0-9_])_preview(?![A-Za-z0-9_])') { Fail 'supabase\config.toml 里出现了 _preview（预览专用函数的配置不能进正式发布）' }
        foreach ($n in $script:PreviewFuncs) {
            if ($text -match ('(?m)^\s*\[\s*functions\s*\.\s*["'']?' + [regex]::Escape($n) + '["'']?\s*[\].]')) { Fail "supabase\config.toml 里声明了预览专用函数 [functions.$n]" }
        }
    }
    Ok "没有预览专用函数（$(@($script:PreviewFuncs).Count) 个名单内的都不在，config.toml 里也没有）"
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
    Say "  没有找到 $($info.Commit.Substring(0,12)) 的「$when」备份，现在做一份"
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
        $pyOut = @(& python -I 'build\ci\dist_hash.py' 'dist\web')
        if ($LASTEXITCODE -ne 0) { Fail '算产物指纹失败' }
        # 只取数字和十六进制，不依赖控制台编码（中文提示词在 PowerShell 5.1 里可能读成乱码）
        $pyCount = if ("$($pyOut[0])" -match '(\d+)\s*$') { [int]$Matches[1] } else { -1 }
        $pyTotal = if ("$($pyOut[-1])" -match '([0-9a-f]{64})\s*$') { $Matches[1] } else { '' }
        $script:DistHash = Get-DistHash 'dist\web'
        if ($pyCount -ne $script:DistHash.Count -or $pyTotal -cne $script:DistHash.Total) { Fail '本脚本算的产物指纹和 build\ci\dist_hash.py 的不一致（两边算法不同了？），先查清再发布' }
        Say "  文件数：$($script:DistHash.Count)"
        Say "  总指纹：$($script:DistHash.Total)"
    } finally { Pop-Location }
    Say ''
    Say "  请在 iPhone 上打开：GitHub › 仓库 › Actions › release-build › $Tag 那一次 › Summary，"
    Say '  核对“文件数”和“总指纹”和上面完全一样。'
    Ask-Exact '  一样就输入“一致”回车（不一样直接回车，发布停止）' '一致'
    Ok '产物和 CI 构建的一致'

    $script:Aws4Hash = Get-Aws4Hash
    Ok "记下 node_modules\aws4fetch 的哈希（$($script:Aws4Hash.Count) 个文件，改库前、部署网页前各再比一次）"
    # B1 接手清单 OPS-deploy ⑦：核对过的产物复制到临时目录，之后再核对、部署网页都用这一份，仓库里的 dist\web 之后被改也不影响。
    # wrangler pages deploy 的目录参数就指向这里；配置和 functions\ 仍从当前目录（仓库根目录）取（wrangler 4.150.0 pages deploy 用 findWranglerConfig(process.cwd())）
    New-WorkDir
    $dst = Join-Path $script:WorkDir 'web'
    Copy-Item -LiteralPath (Join-Path $RepoPath 'dist\web') -Destination $dst -Recurse -Force
    $script:WebDir = $dst
    Assert-WebCopyUnchanged '还没输入任何令牌，没部署任何东西'
}

# ---------------------------------------------------------------- 4. 部署工具
function Install-Tools {
    Step '4. 部署工具装到临时目录（核对哈希）'
    New-WorkDir
    # Supabase CLI 的管理接口地址明确指向官方（本进程的值优先于 supabase\.env 这类文件），结束时清掉
    [Environment]::SetEnvironmentVariable('SUPABASE_API_URL', $script:PinnedEnv['SUPABASE_API_URL'], 'Process')

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

    if (-not $script:NeedWrangler) { Ok '这次只部署服务器函数、不部署 lemo-ops，不装 wrangler'; return }
    $wr = Join-Path $script:WorkDir 'deploy'
    New-Item -ItemType Directory -Path $wr | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoPath 'tools\deploy\package.json'), (Join-Path $RepoPath 'tools\deploy\package-lock.json') -Destination $wr
    Push-Location $wr
    try { Run 'npm.cmd' @('ci', '--ignore-scripts', '--no-audit', '--no-fund') } finally { Pop-Location }
    $script:WranglerDir = $wr
    Ok 'wrangler：按 tools\deploy\package-lock.json 装好（npm 已核对 integrity）'
    Assert-WranglerTree
    # 不发统计、不写日志文件（日志路径也指到临时目录，跟着一起删）；API 地址明确指向 Cloudflare 官方
    [Environment]::SetEnvironmentVariable('WRANGLER_SEND_METRICS', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('WRANGLER_WRITE_LOGS', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('WRANGLER_LOG_PATH', (Join-Path $script:WorkDir 'wrangler-logs'), 'Process')
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_API_BASE_URL', $script:PinnedEnv['CLOUDFLARE_API_BASE_URL'], 'Process')
    $script:EmptyEnvFile = Join-Path $script:WorkDir 'empty.env'
    New-Item -ItemType File -Path $script:EmptyEnvFile | Out-Null

    if ($script:DoOps) {
        # 还没输入任何令牌：只打包、列绑定，不上传（--dry-run）；打包结果放临时目录
        $dot = Join-Path $RepoPath 'workers\lemo-ops\.wrangler'
        if (-not (Test-Path -LiteralPath $dot)) { $script:OpsDotWrangler = $dot }
        Say ''
        Say '  lemo-ops 打包演练（wrangler deploy --dry-run，不上传；看一眼 OPS_STATE 绑定的是真的命名空间 ID）：'
        Push-Location $RepoPath
        try { Run-Wrangler @('deploy', '--config', $script:OpsConfig, '--dry-run', '--outdir', (Join-Path $script:WorkDir 'lemo-ops-dry')) } finally { Pop-Location }
        Ok 'lemo-ops 打包演练通过'
    }
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

function Assert-NoAiSession {
    # 10-29 负责人定（R-223）：不再检查 Claude 是否在运行
    Assert-NoRecording
}

# ---------------------------------------------------------------- 5～7. 部署
function Invoke-Deploy($info) {
    Step '5. 输入正式环境的令牌'
    Assert-StillClean $info
    # 改库之前先对一次：临时目录里的网页、aws4fetch（部署网页前还会再对一次）、装好的 supabase.exe 和 wrangler 依赖树
    if ($script:DoWeb) {
        Assert-WebCopyUnchanged '还没输入令牌、还没改库，请重新运行'
        Assert-Aws4Unchanged '还没输入令牌、还没改库，请重新运行'
    }
    Assert-NoAiSession
    if ((Get-FileHash -LiteralPath $script:SupabaseExe -Algorithm SHA256).Hash -ne $script:SupabaseSha) { Fail 'supabase.exe 在安装后被改过' }
    if ($script:NeedWrangler) {
        $now = Get-DistHash (Join-Path $script:WranglerDir 'node_modules')
        if ($null -eq $script:WranglerTree -or $now.Count -ne $script:WranglerTree.Count -or $now.Total -cne $script:WranglerTree.Total) { Fail 'wrangler 的依赖树在第 4 步核对之后被改过（还没输入令牌、还没改库），请重新运行' }
        Ok 'supabase.exe 和 wrangler 依赖树都还是第 4 步核对过的'
    }

    $ref = Read-Host '  正式 Supabase 项目的 Project ref（20 个小写字母，在 Supabase › 正式项目 › Project Settings 里，不是密钥）'
    $ref = $ref.Trim()
    if ($ref -notmatch '^[a-z]{20}$') { Fail 'Project ref 的格式不对' }

    # 令牌只留在 $script:Secrets 里（SecureString），不设进本进程的环境变量；用到时由 Invoke-WithSecrets 只给那一个子进程
    $script:Secrets['SUPABASE_ACCESS_TOKEN'] = Read-Secret '正式 Supabase 令牌（只管正式项目的那把）' 'Supabase › Account › Access Tokens 里新建的正式项目级令牌（1 天到期，发完删掉）'
    if (-not (Test-SecretPrefix $script:Secrets['SUPABASE_ACCESS_TOKEN'] 'sbp_')) { Fail '这不像 Supabase 令牌（应以 sbp_ 开头）' }
    # -Only functions 不 db push、不 link，用不到数据库密码
    if ($script:DoWeb) {
        $script:Secrets['SUPABASE_DB_PASSWORD'] = Read-Secret '正式数据库密码' '正式项目 › Project Settings › Database 里重设的新密码'
    }
    # 网页和 lemo-ops 用同一把正式 Cloudflare 令牌；只回滚函数且不带 -Ops 时不要
    if ($script:NeedWrangler) {
        $perm = @()
        if ($script:DoWeb) { $perm += 'Pages 编辑' }
        if ($script:DoOps) { $perm += 'Workers Scripts 编辑' }
        $script:Secrets['CLOUDFLARE_API_TOKEN'] = Read-Secret "正式 Cloudflare 令牌（$($perm -join ' ＋ ')）" 'Cloudflare › 我的个人资料 › API 令牌里新建的正式令牌（1 天到期，发完删掉）'

        $acct = Read-Host '  Cloudflare Account ID（32 位，Cloudflare 首页右侧，不是密钥）'
        $acct = $acct.Trim()
        if ($acct -notmatch '^[0-9a-f]{32}$') { Fail 'Account ID 的格式不对' }
        $script:CfAccountId = $acct
    }

    Step '6. 部署'
    $hdr = Get-BearerHeader 'SUPABASE_ACCESS_TOKEN'
    $proj = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref" -Headers $hdr
    $hdr = $null
    if ($proj.region -ne 'ap-northeast-2') { Fail "这个项目不在首尔（$($proj.region)），是不是贴成了预览项目？" }
    if ($proj.status -ne 'ACTIVE_HEALTHY') { Fail "正式项目状态是 $($proj.status)，不是 ACTIVE_HEALTHY" }
    Ok "正式项目：$($proj.name)（首尔，运行正常）"
    Ask-Exact "  确认要发布到上面这个项目就输入项目名「$($proj.name)」" $proj.name
    # 改库之前先确认 Cloudflare 令牌能部署 lemo-ops、lemo-ops 的六个密钥都设好了，免得迁移推了、函数换了，才发现令牌权限不够或密钥没设
    if ($script:DoOps) {
        Assert-WorkersAccess
        Assert-OpsSecrets
    }

    $sbDb = @('SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD')
    Push-Location $RepoPath
    try {
        # 上次留下的 supabase link 本地文件（项目 ref、连接池地址等）先删掉，不让它影响这次（finally 里还会再删一次）
        $linkTemp = Join-Path $RepoPath 'supabase\.temp'
        if (Test-Path -LiteralPath $linkTemp) { Remove-Item -LiteralPath $linkTemp -Recurse -Force }
        if ($script:DoWeb) {
            Invoke-WithSecrets $sbDb { Run $script:SupabaseExe @('link', '--project-ref', $ref) }
            Say ''
            Say '  数据库迁移演练（不改库，只列出要执行的迁移）：'
            Invoke-WithSecrets $sbDb { Run $script:SupabaseExe @('db', 'push', '--linked', '--dry-run') }
            Ask-Exact '  核对上面的迁移，没问题输入“确认推送”' '确认推送'
            Invoke-WithSecrets $sbDb { Run $script:SupabaseExe @('db', 'push', '--linked', '--yes') }
            Ok '数据库迁移完成'
        } else {
            Say '  只部署服务器函数（-Only functions）：不 db push（迁移只增不改，旧函数能用新表结构）'
        }

        $shared = Join-Path $RepoPath 'supabase\functions\_shared\gen'
        if (Test-Path -LiteralPath $shared) { Remove-Item -LiteralPath $shared -Recurse -Force }
        New-Item -ItemType Directory -Path $shared | Out-Null
        Copy-Item -Path (Join-Path $RepoPath 'shared\*') -Destination $shared -Recurse
        # 部署函数不连数据库，只给 Supabase 令牌
        Invoke-WithSecrets @('SUPABASE_ACCESS_TOKEN') { Run $script:SupabaseExe (@('functions', 'deploy') + $script:FunctionNames + @('--project-ref', $ref, '--use-api', '--yes')) }
        Ok "服务器函数部署完成（$Tag：$($script:FunctionNames -join '、')）"

        # 紧接着函数部署 lemo-ops：usage-report 和 lemo-ops 必须同一次部署（上线与回滚手册第三节）
        if ($script:DoOps) {
            try { Run-Wrangler @('deploy', '--config', $script:OpsConfig, '--tag', $Tag, '--message', "$Tag@$($info.Commit.Substring(0,12))") -WithToken } catch {
                $done = if ($script:DoWeb) { '数据库迁移已推、服务器函数已是新版，lemo-ops 和网页还是旧版' } else { '服务器函数已是这个 tag 的版本，lemo-ops 还是原来的版本' }
                Fail "lemo-ops 部署失败（$($_.Exception.Message -replace '^发布停止：', '')）。现在：$done。这种状态能用，只是 usage-report 和 lemo-ops 的新约定没生效。修好原因后用同一个 tag、同样的参数原样重跑（上线与回滚手册第三节「部署 lemo-ops」）"
            }
            Ok "lemo-ops 部署完成（$Tag）"
        }

        if ($script:DoWeb) {
            # 第 3 步核对过、复制到临时目录的那份产物，和 Functions 要打包的 aws4fetch，到这里都不能被换掉（中间这段时间可能被改）
            $state = "数据库迁移、服务器函数$(if ($script:DoOps) { '、lemo-ops' })已是新版，网页还是旧版；查清原因后用同一个 tag 原样重跑"
            Assert-WebCopyUnchanged $state
            Assert-Aws4Unchanged $state
            Ok '网页产物和第 3 步核对过的一致，从临时目录里的副本部署'
            Run-Wrangler @('pages', 'deploy', $script:WebDir, '--project-name', $PagesProject, '--branch', 'main', '--commit-hash', $info.Commit, '--commit-dirty=true') -WithToken
            Ok '网页部署完成'
        }
    } finally { Pop-Location }

    if (-not $script:DoWeb) {
        Step '7. 核对'
        Say '  这次没有部署网页，不核对 version.json。请按上线与回滚手册第四节第 2 层第 4 步核对：设一条 2 分钟后的提醒能准时收到、跑一次 AI 识别。'
        if ($script:DoOps) { Say '  lemo-ops：Cloudflare › Workers › lemo-ops › 部署记录里最新一条的说明是这次的 tag，15 分钟后看一次日志没有报错。' }
        return
    }

    Step '7. 核对线上版本'
    $got = ''
    for ($i = 0; $i -lt 20; $i++) {
        try { $got = (Invoke-RestMethod -Uri "$SiteOrigin/app/version.json" -Headers @{ 'Cache-Control' = 'no-cache' }).version } catch { $got = '' }
        if ($got -eq $info.Ver) { break }
        Start-Sleep -Seconds 6
    }
    if ($got -ne $info.Ver) { Fail "2 分钟后线上版本仍是「$got」，不是 $($info.Ver)。按上线与回滚手册处理" }
    Ok "线上已是 $($info.Ver)"
    if ($script:DoOps) { Say '  lemo-ops：Cloudflare › Workers › lemo-ops › 部署记录里最新一条的说明是这次的 tag，两个 Cron Trigger 都在，15 分钟后看一次日志没有报错。' }
}

# 第 1 步之后打印这次要做的事（不含任何值）
function Show-Plan {
    $parts = @()
    if ($script:DoWeb) { $parts += '数据库迁移' }
    $parts += '服务器函数'
    if ($script:DoOps) { $parts += 'lemo-ops' }
    if ($script:DoWeb) { $parts += '网页（Pages）' }
    Say ''
    Say "  这次要部署：$($parts -join ' → ')（$Tag）"
    Say "  服务器函数逐个写出名字部署：$($script:FunctionNames -join '、')"
    if (-not $script:DoWeb) { Say '  -Only functions：不构建网页、不 db push、不部署 Pages，也不要数据库密码' }
}

# ---------------------------------------------------------------- 主流程
$exitCode = 0
try {
    # 第一次调 git 之前：关掉 core.fsmonitor（B0 复查 M4）。.git\config 里的 core.fsmonitor 会在 git status、ls-files、rev-parse 时
    # 执行任意程序；wrangler pages deploy 内部也会跑 git status（此时进程里已有令牌，那个程序会继承走）。
    # GIT_CONFIG_COUNT/KEY/VALUE 是命令行级配置，优先于仓库和全局配置，子进程（wrangler、supabase）也继承；finally 里清掉。
    # 窗口里预先有的 git 环境变量会改 git 读哪个仓库、哪份配置（GIT_CONFIG_PARAMETERS 还会盖过下面这一条），有就停。
    # 同时把 core.hooksPath 指到一个空的临时目录（B0 复查 M5）：git status 会把刷新后的索引写回去，写索引会触发 post-index-change 钩子，
    # 钩子放在 .git\hooks\ 或 .githooks\ 都会被执行；wrangler 内部跑 git status 时进程里已有令牌。指到空目录以后任何钩子都不执行。
    $gitEnv = @('GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR') |
        Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }
    if (@($gitEnv).Count -gt 0) { Fail "这个窗口里有会改 git 行为的环境变量：$(@($gitEnv) -join '、')。请开一个新的 PowerShell 窗口再运行" }
    $script:NoHooksDir = Join-Path $env:TEMP ('lemo-nohooks-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:NoHooksDir | Out-Null
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT', '2', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_KEY_0', 'core.fsmonitor', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_VALUE_0', 'false', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_KEY_1', 'core.hooksPath', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_VALUE_1', $script:NoHooksDir, 'Process')
    Say "柠檬记正式发布：$Tag    （$(Get-Date -Format 'yyyy-MM-dd HH:mm')）"
    $info = Invoke-Checks
    Show-Plan
    if ($CheckOnly) { Say ''; Say '只做检查（-CheckOnly），到此结束。'; return }
    Invoke-Backup $info
    if ($script:DoWeb) { Invoke-Build $info } else { Step '3. 构建正式产物'; Ok '-Only functions：跳过（不部署网页）' }
    Install-Tools
    Assert-NoPreviewFunctions
    if ($DryRun) { Say ''; Say '演练（-DryRun）到此结束：没有输入令牌，没有部署任何东西。'; return }
    Invoke-Deploy $info
    Step '完成'
    if ($script:DoWeb) {
        Say "  $Tag 已发布。接下来："
        Say '  1. 在 docs\08-发布\发布记录.md 记一行（版本、时间、提交、产物指纹）；'
        Say '  2. 需要的话在 GitHub 网页（iPhone）上为这个 tag 建 Release；'
        Say '  3. 按上线与回滚手册做发布后的检查。'
    } else {
        Say "  已把服务器函数$(if ($script:DoOps) { '和 lemo-ops' })部署成 $Tag 的版本。接下来："
        Say '  1. 在 docs\08-发布\发布记录.md 记一行（回滚到哪个 tag、时间、原因）；'
        Say '  2. 按上线与回滚手册第四节第 2 层第 4 步核对。'
    }
} catch {
    $exitCode = 1
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    Clear-SecretEnv
    Clear-Secrets
    $script:CfAccountId = $null
    foreach ($n in 'WRANGLER_SEND_METRICS', 'WRANGLER_WRITE_LOGS', 'WRANGLER_LOG_PATH', 'CLOUDFLARE_API_BASE_URL', 'SUPABASE_API_URL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1') { [Environment]::SetEnvironmentVariable($n, $null, 'Process') }
    if ($script:NoHooksDir -and (Test-Path -LiteralPath $script:NoHooksDir)) { Remove-Item -LiteralPath $script:NoHooksDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($script:TokensRead) { Clear-Clip }
    # lemo-ops 打包演练时 wrangler 在 workers\lemo-ops 下建的 .wrangler（本来没有才删；已被 .gitignore 忽略）
    if ($script:OpsDotWrangler -and (Test-Path -LiteralPath $script:OpsDotWrangler)) { Remove-Item -LiteralPath $script:OpsDotWrangler -Recurse -Force -ErrorAction SilentlyContinue }
    if ($script:WorkDir -and (Test-Path -LiteralPath $script:WorkDir)) { Remove-Item -LiteralPath $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
    $linkTemp = Join-Path $RepoPath 'supabase\.temp'
    if (Test-Path -LiteralPath $linkTemp) { Remove-Item -LiteralPath $linkTemp -Recurse -Force -ErrorAction SilentlyContinue }
    [GC]::Collect()
    Say ''
    Say '已清掉本窗口里的令牌、剪贴板和临时文件。请关掉这个 PowerShell 窗口。'
}
exit $exitCode
