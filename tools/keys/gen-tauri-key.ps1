<#
.SYNOPSIS
  生成电脑版 exe 自动更新用的 Tauri 签名密钥（minisign 格式，带密码加密），正式、预览各一把，分两次运行（B6-exe 任务单 F10；
  架构 8.4“谁来生成最要紧的三把钥匙”、0.48 第 10、13 条；Q-O7 / R-291）。由产品负责人本人在自己电脑的 PowerShell 窗口里运行，AI 不经手私钥。

.DESCRIPTION
  两把密钥存哪（Q-O7，负责人 11-03 定）：
    - 正式（-Target prod）：U 盘 + Google 密码管理器，开发电脑上不留；
    - 预览（-Target preview）：只存 Google 密码管理器，不写 U 盘，开发电脑上不留（丢了就重新生成一把，已装的预览版 exe 重装一次）。
  私钥的密码由签名工具自己在窗口里问（输入时不显示），**不经过本脚本**：不进命令行参数、不进环境变量、不进剪贴板，负责人自己记下、存进 Google 密码管理器。
  私钥本身是用这个密码加密过的 minisign 私钥盒（scrypt）。私钥盒里的 Sc 标记只说明格式是加密盒，**不能证明密码不为空**
  （空密码照样走 scrypt、标记照样是 Sc）；空密码靠签名工具在标准输出打印的 <empty> 那一行判断，见到就停（F10 安全审查、代码审查 M1）。

  本脚本做的事（按顺序，任何一步不过就停）：
    1. 开头检查（“安全窗口检查”一段和其他密钥脚本逐字相同）：Windows 剪贴板历史和跨设备同步都关着、
       系统没开 PowerShell 的 transcript / 模块日志 / 脚本块日志策略、本窗口没在记 transcript；
       关掉本窗口的历史记录；环境变量 CI、TAURI_SIGNING_PRIVATE_KEY、TAURI_SIGNING_PRIVATE_KEY_PATH、TAURI_SIGNING_PRIVATE_KEY_PASSWORD 必须都没设
       （设了 CI，签名工具会用空密码加密、不问密码）；打印本脚本的 SHA-256，和审查记录里冻结副本的哈希核对；
    2. 核对签名工具：-Signer 指向的 exe 的 SHA-256 必须和 tools/ci-tools.lock 里 tauri-signer / windows_amd64 那一行一致（不经 npm，0.48 第 10 条）；
       核对时打开的只读句柄（只许别人读、不许改）一直拿到签名工具启动以后才放，核对完到启动之间文件换不掉；
    3. 正式那把：核对 -UsbDrive 是可移动磁盘、不是系统盘，目标文件还不存在（不覆盖旧钥匙）；
    4. 运行 `<签名工具> signer generate`（不带 --password、不带 --write-keys、不带 --ci；工作目录是签名工具所在的文件夹；
       子进程的环境变量只给白名单里那几个，PATH 只有系统目录）：签名工具在窗口里问两次密码；
       它打印到标准输出的私钥和公钥由本脚本直接收进内存，**不显示在终端、不落盘**（任务单 F10 第 ① 种，首选做法，用不到临时文件）；
       输出里有 <empty> 一行（密码为空）就停；核对私钥是 minisign 私钥盒（Ed / Sc / B2）、公钥是 minisign 公钥盒，公钥说明行里的 key id 和算出来的一致；
    5. 正式那把：把私钥（加密后的那一串）和公钥写进 U 盘 <盘符>\柠檬记-签名密钥\（只新建、不覆盖，写完刷到盘上），读回来逐字核对（0.48 第 13 条第 ③ 点）；
    6. 把私钥放进剪贴板（带“不进剪贴板历史、不上传云剪贴板、不给剪贴板监视程序”三个标记），负责人在**这台电脑的浏览器里**粘进 Google 密码管理器、按回车，
       脚本立刻清空剪贴板；120 秒没按回车也自动清空；再请负责人从 Google 密码管理器复制回来粘贴核对一次（屏幕不显示），对上了才算存好；最多 3 次；
    7. 打印公钥（公开值）：交给前端 B 写进 updater 配置（正式 tauri.conf.json、预览 tauri.preview.conf.json 的 plugins.updater.pubkey），
       desktop_scan.mjs 编译后会核对两套环境各用一把、互相搜不到。
  剪贴板只在第 6 步放私钥；放之前已核对剪贴板历史和跨设备同步关着。**没放过私钥就不碰剪贴板**（开头检查没过时，负责人的剪贴板和剪贴板历史原样不动，
  F10 安全审查 M4）。屏幕、报错里任何时候都不打印私钥和签名工具的原始输出。
  -Practice：练习一遍（第一次用这个签名工具、或想先看看流程时）：照样生成一把，但只核对格式，不写 U 盘，用完即丢，只显示 key id；
  再加 -PracticeSave，用这把要丢掉的钥匙把“进剪贴板、存进 Google 密码管理器、复制回来核对”也走一遍（看密码管理器存不存得下约 350 个字符），练完删掉那一条。

  剩下的风险：PowerShell 的字符串没法逐字节清零，私钥会在本进程内存里短暂存在（用完即置空），最后要关窗口；
  剪贴板在第 6 步会短暂放着私钥（已加密），任何能读剪贴板的程序在那段时间里都读得到，所以运行前要按步骤文档自己退出 Claude、停用浏览器里的 AI 扩展
  （脚本不查 Claude 进程，和其他密钥脚本一致，R-298）；
  直接点窗口右上角的 × 关掉时，最后清剪贴板那一步不会执行，要关窗口先按 Ctrl+C。

.PARAMETER Target
  preview 或 prod。

.PARAMETER Signer
  签名工具 exe 的完整路径（运维选定、锁进 tools/ci-tools.lock 的那个，见步骤文档第二节）。那个文件夹里只放 cargo-tauri.exe。

.PARAMETER UsbDrive
  只有 -Target prod 用：U 盘的盘符，例如 F:。预览那把不写 U 盘，带了这个参数会被拒绝。

.PARAMETER Practice
  练习模式：生成后只核对格式就丢掉，不写 U 盘。

.PARAMETER PracticeSave
  只能和 -Practice 一起用：练习时也走一遍存进 Google 密码管理器和核对。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\gen-tauri-key.ps1" -Target preview -Signer "E:\柠檬记-工具\cargo-tauri.exe"

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记APP\tools\keys\gen-tauri-key.ps1" -Target prod -Signer "E:\柠檬记-工具\cargo-tauri.exe" -UsbDrive F:
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('preview', 'prod')][string]$Target,
    [Parameter(Mandatory = $true)][ValidateLength(1, 400)][string]$Signer,
    [ValidatePattern('\A[A-Za-z]:\z')][string]$UsbDrive = '',
    [switch]$Practice,
    [switch]$PracticeSave,
    # 只给测试用（要另设环境变量 LEMO_TEST_SIGNER=1 才生效，两个路径都必须在 %TEMP% 下）：换一份锁文件（里面是假签名工具的哈希）、把“U 盘”换成一个临时目录
    [Parameter(DontShow = $true)][string]$LockFile = '',
    [Parameter(DontShow = $true)][string]$UsbRootForTest = ''
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8   # 先设好，下面的报错才不是乱码

# 只许用 -File 运行：点源（. 脚本）或把内容粘贴进窗口跑，脚本里的变量（私钥）会留在窗口的会话里（照搬 set-vapid-keys.ps1）
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
$testMode = ($env:LEMO_TEST_SIGNER -eq '1')
# 测试模式必须同时换掉锁文件，而且锁文件和“U 盘”目录都在 %TEMP% 下：LEMO_TEST_SIGNER=1 会放宽 & 调用检查，不能拿它对着真锁文件、真 U 盘跑（F10 安全审查 S6）
if ($testMode) {
    if (-not $LockFile) { throw '已停止：环境变量 LEMO_TEST_SIGNER=1 只给测试用，不能用来生成真钥匙。请关掉这个窗口、新开一个 PowerShell 再运行' }
    $tmpRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    foreach ($tp in @($LockFile, $UsbRootForTest) | Where-Object { $_ }) {
        if (-not ([IO.Path]::GetFullPath($tp)).StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '已停止：测试模式的 -LockFile、-UsbRootForTest 必须在 %TEMP% 下' }
    }
}
if (-not $testMode -and ($LockFile -or $UsbRootForTest)) {
    throw '已停止：-LockFile、-UsbRootForTest 只给测试用，正式运行不要带这两个参数'
}
if (-not $byFile -and -not $testMode) {
    throw '已停止：请用 powershell -NoProfile -ExecutionPolicy Bypass -File <脚本路径> 运行（不要在已打开的窗口里用 & 调用）'
}
if ($Target -eq 'preview' -and $UsbDrive) {
    throw '已停止：预览那把只存 Google 密码管理器、不写 U 盘（Q-O7），不要带 -UsbDrive'
}
if ($Target -eq 'prod' -and -not $UsbDrive -and -not $Practice) {
    throw '已停止：正式那把要另存一份到 U 盘，请带上 -UsbDrive <盘符>，例如 -UsbDrive F:'
}
if ($PracticeSave -and -not $Practice) {
    throw '已停止：-PracticeSave 只能和 -Practice 一起用'
}

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
    try { Set-PSReadLineOption -HistorySaveStyle SaveNothing } catch { }
}

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ✘ $msg" -ForegroundColor Yellow }
# 报错打印前，把内存里的私钥、签名工具的标准输出、核对时粘贴的内容换成 ***（变量还没建时跳过，StrictMode 下不报错）；
# 再把任何 40 个字符以上的 base64 串都换成 ***（私钥、私钥盒里那一行都是这种串，不管它从哪里冒出来）
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    foreach ($n in 'skB64', 'rawOut', 'back') {
        $v = Get-Variable -Name $n -Scope Script -ValueOnly -ErrorAction SilentlyContinue
        if ($v -is [string] -and $v.Length -ge 8) { $s = $s.Replace($v, '***') }
    }
    $s = [regex]::Replace($s, '[A-Za-z0-9+/]{40,}={0,2}', '***')
    return $s
}
function Fail([string]$msg) { throw "已停止：$(Hide-Secrets $msg)" }

# 剪贴板：只有放过私钥（$clipUsed 为真）才清，开头检查没过时不碰负责人的剪贴板和剪贴板历史（F10 安全审查 M4）。
# 测试模式只调 Set-Clipboard（外壳换成了假的），不碰真剪贴板、不调 WinRT 的 ClearHistory
$clipUsed = $false
function Clear-Clip {
    if (-not $script:clipUsed) { return }
    try { Set-Clipboard -Value ' ' } catch { }
    if ($script:testMode) { return }
    try { Add-Type -AssemblyName System.Windows.Forms } catch { }
    try { [System.Windows.Forms.Clipboard]::Clear() } catch { }
    try {
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
        $null = [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory()
    } catch { }
}

# 放私钥进剪贴板（F10 安全审查 S1）：带三个标记——不给剪贴板监视程序（ExcludeClipboardContentFromMonitorProcessing）、
# 不进剪贴板历史（CanIncludeInClipboardHistory = 0）、不上传云剪贴板（CanUploadToCloudClipboard = 0）。放不进去就停，不退回不带标记的写法
function Set-ClipSecret([string]$value) {
    $script:clipUsed = $true
    if ($script:testMode) { Set-Clipboard -Value $value; return }
    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { Fail '这个 PowerShell 窗口不是 STA 模式，放不进剪贴板。请按步骤文档用 powershell -File 运行' }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $do = New-Object System.Windows.Forms.DataObject
        $do.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $value)
        $do.SetData('ExcludeClipboardContentFromMonitorProcessing', [IO.MemoryStream]::new([byte[]]@(1, 0, 0, 0)))
        $do.SetData('CanIncludeInClipboardHistory', [IO.MemoryStream]::new([byte[]]@(0, 0, 0, 0)))
        $do.SetData('CanUploadToCloudClipboard', [IO.MemoryStream]::new([byte[]]@(0, 0, 0, 0)))
        [System.Windows.Forms.Clipboard]::SetDataObject($do, $true)
    } catch {
        # 正式那次 U 盘已经写好（参照主流程“连续 3 次都没存好”那两句的分法）
        if ($script:usbDir) { Fail '放不进剪贴板（带“不进历史、不上传”标记的写法失败）。U 盘上那份是好的，Google 密码管理器里还没存好：在聊天里告诉主持人，不要把公钥交给前端' }
        Fail '放不进剪贴板（带“不进历史、不上传”标记的写法失败）。Google 密码管理器里还没存好，这台电脑上也没留文件：请在聊天里告诉主持人'
    }
}

# 等负责人按回车，最多 $seconds 秒（F10 安全审查 S2）：按了回车返回真，超时返回假。
# 测试模式用 Read-Host（外壳换成了假的；返回 TIMEOUT 表示超时）
function Wait-Enter([string]$prompt, [int]$seconds) {
    if ($script:testMode) { return ((Read-Host $prompt) -ne 'TIMEOUT') }
    Write-Host -NoNewline "$prompt（$seconds 秒内）："
    while ([Console]::KeyAvailable) { $null = [Console]::ReadKey($true) }
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ([Console]::KeyAvailable) {
            if (([Console]::ReadKey($true)).Key -eq [ConsoleKey]::Enter) { Write-Host ''; return $true }
        }
        Start-Sleep -Milliseconds 200
    }
    Write-Host ''
    return $false
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

# 剪贴板跨设备同步（“跨设备共享”）：开着时复制的内容会传到微软账号下的其他设备（8.3a 第 1 步、0.48 第 13 条）
function Assert-NoCloudClipboard {
    $v = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Clipboard' -Name 'EnableCloudClipboard' -ErrorAction SilentlyContinue
    if ($v -and $v.EnableCloudClipboard -eq 1) {
        Fail '剪贴板的“跨设备共享”开着，复制的私钥会传到你微软账号下的其他设备。请到 设置 › 系统 › 剪贴板 关掉“跨设备共享”，再重新运行'
    }
    Ok '剪贴板跨设备共享是关的'
}

# 这几个环境变量设着时不运行：CI 会让签名工具用空密码加密、不问密码；TAURI_SIGNING_* 说明这台电脑上还留着别的私钥或密码
function Assert-CleanEnv {
    foreach ($n in 'CI', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD') {
        if ([Environment]::GetEnvironmentVariable($n)) { Fail "环境变量 $n 设着（不显示它的值）。请关掉这个窗口，把它从系统环境变量里删掉，新开一个 PowerShell 再运行" }
    }
    Ok '没有设 CI、TAURI_SIGNING_ 开头的环境变量'
}

function Assert-SafeWindow {
    # 不查 Claude 进程（R-223、R-298，和其他密钥脚本一致）；运行前退出 Claude、停用浏览器 AI 扩展由步骤文档人工提醒
    Assert-NoRecording
    Assert-NoCloudClipboard
    Assert-CleanEnv
}

# 读锁文件里某个工具某个平台的一行（同 publish.ps1 的 Get-LockEntry）
function Get-LockEntry([string]$lock, [string]$name, [string]$platform) {
    foreach ($line in Get-Content -LiteralPath $lock -Encoding UTF8) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $c = $t -split '\s+'
        if ($c.Count -eq 6 -and $c[0] -eq $name -and $c[2] -eq $platform) {
            return [pscustomobject]@{ Version = $c[1]; File = $c[3]; Sha256 = $c[4].ToLower(); Url = $c[5] }
        }
    }
    return $null
}

# 核对签名工具，返回打开着的只读句柄（只许别人读，F10 安全审查 S4）：签名工具启动以后才关，核对完到启动之间文件换不掉
function Open-Signer([string]$path, [string]$lock) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "找不到签名工具：$path" }
    if ([IO.Path]::GetExtension($path) -ne '.exe') { Fail '签名工具必须是 .exe（不接受 .cmd、.ps1 之类的脚本）' }
    $e = Get-LockEntry $lock 'tauri-signer' 'windows_amd64'
    if (-not $e) { Fail 'tools\ci-tools.lock 里还没有 tauri-signer / windows_amd64 这一行：签名工具还没选定、没审过（B6-exe F10），先别运行，在聊天里告诉主持人' }
    if ([IO.Path]::GetFileName($path) -ne $e.File) { Fail "签名工具的文件名应为 $($e.File)，现在是 $([IO.Path]::GetFileName($path))" }
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $h = [Security.Cryptography.SHA256]::Create()
        try { $sha = -join ($h.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
    } catch {
        $fs.Dispose()
        throw
    }
    if ($sha -ne $e.Sha256) { $fs.Dispose(); Fail "签名工具的 SHA-256 和 tools\ci-tools.lock 不一致（锁的是 $($e.Version)）。不要用这个文件，重新下载或在聊天里告诉主持人" }
    Ok "签名工具 $($e.File) $($e.Version)，SHA-256 和 tools\ci-tools.lock 一致（文件已锁住，启动前改不了）"
    return $fs
}

# 正式那把的 U 盘：可移动磁盘、不是系统盘；返回目标目录。三条检查测试时照样跑（外壳给假的磁盘信息），最后才把目录换成临时目录（F10 代码审查 M3）
function Get-UsbDir([string]$drive) {
    $d = $drive.ToUpper()
    if ($d -eq ([string]$env:SystemDrive).ToUpper()) { Fail "$d 是系统盘，不是 U 盘" }
    $disk = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID = '$d'" -ErrorAction SilentlyContinue)
    if ($disk.Count -ne 1) { Fail "找不到 $d 这个盘，U 盘插好了吗？" }
    if ($disk[0].DriveType -ne 2) { Fail "$d 不是可移动磁盘（Windows 认作类型 $($disk[0].DriveType)），请换成 U 盘；移动硬盘被认作本地磁盘的，在聊天里告诉主持人" }
    if ($UsbRootForTest) { return (Join-Path $UsbRootForTest '柠檬记-签名密钥') }
    return "$d\柠檬记-签名密钥"
}

# 只新建、不覆盖地写一个文件，写完刷到盘上（F10 安全审查 M5）
function Write-NewFile([string]$path, [string]$content) {
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($content)
    $fs = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $fs.Write($bytes, 0, $bytes.Length)
        $fs.Flush($true)
    } finally {
        $fs.Dispose()
    }
}

# minisign 的密钥盒：base64 里包着两行文本“untrusted comment: …”和一行 base64 的二进制。
# 私钥盒 158 字节：签名算法 Ed、KDF 算法 Sc、校验算法 B2，后面是盐、参数和加密后的密钥；公钥盒 42 字节：Ed + 8 字节 key id + 32 字节公钥。
# Sc 只说明格式是加密盒，不能证明密码不为空，空密码靠 <empty> 判断（见主流程）
function Read-Box([string]$b64, [int]$size) {
    try { $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) } catch { return $null }
    $lines = @($text -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ -ne '' })
    if ($lines.Count -ne 2 -or -not $lines[0].StartsWith('untrusted comment: ')) { return $null }
    try { $bin = [Convert]::FromBase64String($lines[1]) } catch { return $null }
    if ($bin.Length -ne $size) { return $null }
    return [pscustomobject]@{ Comment = $lines[0]; Bin = $bin }
}
function Test-SecretKey([string]$b64) {
    $box = Read-Box $b64 158
    if (-not $box) { Fail '签名工具给出的私钥格式不对（不是 minisign 私钥盒）。什么都没保存，请在聊天里告诉主持人' }
    $alg = [Text.Encoding]::ASCII.GetString($box.Bin, 0, 6)
    [Array]::Clear($box.Bin, 0, $box.Bin.Length)
    # 兜底：KDF 标记是两个 0 表示完全没加密（兼容别的 minisign 工具；tauri-cli 空密码时不会走到这里，走上面的 <empty>）
    if ($alg -eq ("Ed" + [char]0 + [char]0 + "B2")) { Fail '私钥没有加密。什么都没保存：请重新运行，签名工具问密码时输入一个不为空的密码' }
    if ($alg -ne 'EdScB2') { Fail '签名工具给出的私钥算法标记不对（应为 Ed / Sc / B2）。什么都没保存，请在聊天里告诉主持人' }
}
# 公钥的 key id：盒里第 2～9 字节按小端读成 64 位数，十六进制大写；必须和说明行“minisign public key: <key id>”里的一致（F10 代码审查 S6）
function Get-PublicKeyId([string]$b64) {
    $box = Read-Box $b64 42
    if (-not $box -or [Text.Encoding]::ASCII.GetString($box.Bin, 0, 2) -ne 'Ed') { Fail '签名工具给出的公钥格式不对（不是 minisign 公钥盒）。什么都没保存，请在聊天里告诉主持人' }
    $id = -join ($box.Bin[9..2] | ForEach-Object { $_.ToString('X2') })
    $m = [regex]::Match($box.Comment, '\Auntrusted comment: minisign public key: ([0-9A-Fa-f]{16})\z')
    if (-not $m.Success) { Fail '公钥的说明行不对。什么都没保存，请在聊天里告诉主持人' }
    if ($m.Groups[1].Value.ToUpper() -ne $id) { Fail '公钥说明行里的 key id 和公钥本身对不上。什么都没保存，请在聊天里告诉主持人' }
    return $id
}

# 运行签名工具：标准输出、标准错误收进内存（不显示），标准输入和窗口留给它问密码。
# 只传 signer generate 两个参数；工作目录是签名工具所在的文件夹；环境变量只给白名单（F10 安全审查 S3），PATH 只有系统目录。
# 测试模式另把 FAKE_SIGNER_ 开头的变量传给假签名工具。签名工具启动以后才关掉核对哈希时拿着的句柄
function Invoke-SignerGenerate([string]$exe, [IO.FileStream]$held) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = 'signer generate'
    $psi.WorkingDirectory = [IO.Path]::GetDirectoryName($exe)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $false
    $psi.CreateNoWindow = $false
    $keep = @{}
    foreach ($n in 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS') {
        $v = [Environment]::GetEnvironmentVariable($n)
        if ($v) { $keep[$n] = $v }
    }
    if ($script:testMode) {
        foreach ($k in @([Environment]::GetEnvironmentVariables().Keys)) { if ([string]$k -like 'FAKE_SIGNER_*') { $keep[[string]$k] = [Environment]::GetEnvironmentVariable([string]$k) } }
    }
    $psi.EnvironmentVariables.Clear()
    foreach ($k in $keep.Keys) { $psi.EnvironmentVariables[$k] = $keep[$k] }
    $psi.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
    try {
        $p = [Diagnostics.Process]::Start($psi)
    } finally {
        $held.Dispose()
    }
    try {
        $o = $p.StandardOutput.ReadToEndAsync()
        $e = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit(900000)) { try { $p.Kill() } catch { }; Fail '签名工具 15 分钟没结束，已停掉。什么都没保存' }
        $p.WaitForExit()
        $script:rawOut = $o.Result
        $script:rawErr = $e.Result
        return $p.ExitCode
    } finally {
        $p.Dispose()
    }
}

# 从签名工具的输出里取私钥、公钥：“Private: (Keep it secret!)”下一行是私钥，“Public:”下一行是公钥
function Get-AfterLabel([string[]]$lines, [string]$label) {
    $hits = @(for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k].Trim() -ceq $label) { $k } })
    if ($hits.Count -ne 1) { return $null }
    for ($k = $hits[0] + 1; $k -lt $lines.Count; $k++) {
        $t = $lines[$k].Trim()
        if ($t) { if ($t -cmatch '\A[A-Za-z0-9+/]+={0,2}\z') { return $t } else { return $null } }
    }
    return $null
}

function To-Plain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 存进 Google 密码管理器并核对：私钥进剪贴板 → 负责人在这台电脑的浏览器里存好、按回车（120 秒不按自动清空）→ 清空 → 复制回来粘贴核对 → 清空。
# 最多 3 次，存好返回真；没存好时 $script:saveWhy 写明 3 次各是什么原因（超时还是对不上，F10 代码审查复核第 3 条）
$saveWhy = ''
function Save-ToPasswordManager([string]$entry, [string]$user) {
    $timeouts = 0; $mismatches = 0
    $script:saveWhy = ''
    for ($try = 1; $try -le 3; $try++) {
        Say '  放进剪贴板之前：浏览器里的 Claude 扩展和其他 AI、读页面类扩展要先停用（或者换一个没装扩展的浏览器配置）。'
        Set-ClipSecret $script:skB64
        Say '  私钥已放进剪贴板（加密过的那一串，屏幕不显示）。在**这台电脑**的浏览器里打开 passwords.google.com › 添加：'
        Say "    网站或应用：$entry；用户名：$user；密码：粘贴（Ctrl+V）；备注里写上刚才输入的私钥密码。保存。"
        Say '    不要在手机上操作，也不要用微信、KakaoTalk、邮件、备忘录把私钥传到手机。'
        $pressed = Wait-Enter '  保存好以后回到这里按回车（脚本马上清空剪贴板）' 120
        Clear-Clip
        if (-not $pressed) {
            $timeouts++
            Warn '120 秒没按回车，已清空剪贴板。没存好的话重新来一次：'
            continue
        }
        Ok '剪贴板已清空'
        Say '  核对一次：在这台电脑的浏览器里打开刚存的那一条，复制“密码”，粘贴到下面（屏幕不显示）：'
        $sec = Read-Host -AsSecureString '  粘贴到这里'
        Clear-Clip
        $script:back = (To-Plain $sec) -replace '[\s\u00A0\u200B-\u200D\u2060\uFEFF]', ''
        $sec.Dispose()
        $same = ($script:back -ceq $script:skB64)
        $n = $script:back.Length
        $script:back = $null
        if ($same) {
            Ok 'Google 密码管理器里存的私钥和生成的一致（剪贴板已清空）'
            return $true
        }
        $mismatches++
        Warn "对不上（收到 $n 个字符，应为 $($script:skB64.Length) 个）。多半没粘贴全，或者存成了别的内容"
        if ($try -lt 3) { Say '  把那一条的密码改掉、重新来一次：' }
    }
    $script:saveWhy = if ($timeouts -eq 3) { '3 次都没在 120 秒内按回车' } elseif ($mismatches -eq 3) { '连续 3 次核对都对不上' } else { "3 次里 $timeouts 次 120 秒没按回车、$mismatches 次核对对不上" }
    return $false
}

# ───────────────────────── 主流程 ─────────────────────────
if ($Target -eq 'preview') {
    $label = '预览'; $conf = 'desktop/src-tauri/tauri.preview.conf.json'; $gpmName = '柠檬记 电脑版签名私钥（预览）'
} else {
    $label = '正式'; $conf = 'desktop/src-tauri/tauri.conf.json'; $gpmName = '柠檬记 电脑版签名私钥（正式）'
}
$RepoPath = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$lock = if ($LockFile) { $LockFile } else { Join-Path $RepoPath 'tools\ci-tools.lock' }

$skB64 = $null; $pkB64 = $null; $rawOut = $null; $rawErr = $null; $back = $null; $held = $null
try {
    if ($testMode) { Write-Host '!!!!! 测试模式（LEMO_TEST_SIGNER=1）：只给自动测试用，生成的不是真钥匙。看到这一行请关掉窗口 !!!!!' -ForegroundColor Red }
    Step "生成$label 签名密钥：先检查$(if ($Practice) { '（练习模式：生成后只核对格式就丢掉）' })"
    Assert-SafeWindow
    $self = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLower()
    Say "  本脚本的 SHA-256：$self"
    Say '  请和审查记录里“gen-tauri-key.ps1 冻结副本”的哈希核对（步骤文档第三节），不一样就按 Ctrl+C 停下。'

    $usbDir = $null
    if ($Target -eq 'prod' -and -not $Practice) {
        $usbDir = Get-UsbDir $UsbDrive
        foreach ($f in 'lemomemo-tauri-prod.key', 'lemomemo-tauri-prod.key.pub') {
            if (Test-Path -LiteralPath (Join-Path $usbDir $f)) { Fail "U 盘上已经有 $f。本脚本不覆盖旧钥匙：确实要换新钥匙，先在聊天里和主持人确认，再把旧文件挪走（不要删）" }
        }
        Ok "U 盘目录：$usbDir（里面还没有正式私钥文件）"
    }
    $held = Open-Signer $Signer $lock

    Step '运行签名工具生成密钥（它会在下面问两次密码）'
    Say '  签名工具会显示 Password: 和 Password (one more time):，输入时屏幕上不显示，输完按回车。'
    if ($Practice) {
        Say '  练习模式：随便输入一个不为空的密码（这把密钥用完就丢）。'
    } else {
        Say "  这个密码用 4 个以上随机的词组成、自己手打（不要复制粘贴，不要和别的密码相同，不能为空），**记下来**，等一下和私钥一起存进 Google 密码管理器的「$gpmName」。"
        Say '  丢了密码和丢了私钥一样：这把钥匙就不能再签更新包了。'
    }
    $code = Invoke-SignerGenerate $Signer $held
    $held = $null
    if ($code -ne 0) {
        $tip = if ($rawErr) { $e1 = (Hide-Secrets $rawErr).Trim(); if ($e1.Length -gt 300) { $e1.Substring(0, 300) } else { $e1 } } else { '' }
        Fail "签名工具出错（退出码 $code）。什么都没保存。$tip"
    }
    $lines = @($rawOut -split "`n" | ForEach-Object { $_.TrimEnd("`r") })
    $rawOut = $null; $rawErr = $null
    # 空密码：签名工具照样用 scrypt 加密、标记照样是 Sc，只会在标准输出打印一行 <empty>（F10 安全审查、代码审查 M1）
    if (@($lines | Where-Object { $_.Trim() -ceq '<empty>' }).Count -gt 0) {
        $lines = $null
        Fail '密码为空（签名工具问密码时直接按了回车）。什么都没保存：请重新运行，输入一个不为空的密码'
    }
    $skB64 = Get-AfterLabel $lines 'Private: (Keep it secret!)'
    $pkB64 = Get-AfterLabel $lines 'Public:'
    $lines = $null
    if (-not $skB64 -or -not $pkB64) { Fail '签名工具的输出里找不到私钥和公钥（输出格式和预期不一样）。什么都没保存，请在聊天里告诉主持人' }
    Test-SecretKey $skB64
    $keyId = Get-PublicKeyId $pkB64
    Ok "私钥是 minisign 加密私钥盒（Ed / Sc / B2），密码不为空；公钥 key id $keyId；都只在内存里，没显示、没落盘"

    if ($Practice) {
        if ($PracticeSave) {
            Step '练习存进 Google 密码管理器（这把钥匙练完就丢）'
            if (-not (Save-ToPasswordManager '柠檬记 练习（用完删掉）' 'practice')) { Fail "练习：$saveWhy，没存好。删掉 Google 密码管理器里那一条练习记录，在聊天里告诉主持人" }
            Say '  练完了：到 Google 密码管理器把「柠檬记 练习（用完删掉）」那一条删掉。'
        }
        $skB64 = $null
        Step '练习结束'
        Ok "流程走通了：这把的 key id 是 $keyId（已丢弃，不要交给任何人）"
        Say '  正式生成时去掉 -Practice 再运行一次。'
        return
    }

    if ($usbDir) {
        Step "写进 U 盘：$usbDir"
        $null = New-Item -ItemType Directory -Path $usbDir -Force
        $skPath = Join-Path $usbDir 'lemomemo-tauri-prod.key'
        $pkPath = Join-Path $usbDir 'lemomemo-tauri-prod.key.pub'
        Write-NewFile $skPath $skB64
        Write-NewFile $pkPath $pkB64
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        if ([IO.File]::ReadAllText($skPath, $utf8) -cne $skB64 -or [IO.File]::ReadAllText($pkPath, $utf8) -cne $pkB64) { Fail 'U 盘上的文件读回来和写进去的不一样，U 盘可能有问题。请换一个 U 盘重新运行' }
        Ok '已写入 lemomemo-tauri-prod.key（加密的私钥）和 lemomemo-tauri-prod.key.pub（公钥），已刷到盘上，读回来逐字核对一致'
        Say '  全部做完以后，先在任务栏点“安全删除硬件并弹出媒体”弹出 U 盘，再拔下来放好；不要一直插在开发电脑上。'
    }

    Step "存进 Google 密码管理器：「$gpmName」"
    if (-not (Save-ToPasswordManager $gpmName $Target)) {
        if ($usbDir) { Fail "$saveWhy，Google 密码管理器里的私钥没存好。U 盘上那份是好的：在聊天里告诉主持人，不要把公钥交给前端" }
        Fail "$saveWhy，Google 密码管理器里的私钥没存好。这把密钥作废（不要把公钥交给任何人），删掉 Google 密码管理器里那一条（如果存了），重新运行本脚本"
    }
    $skB64 = $null

    Step "公钥（公开值，不是密钥）：交给前端 B 写进 $conf 的 plugins.updater.pubkey"
    Say ''
    [Console]::WriteLine("      $pkB64")
    Say ''
    Say "  key id：$keyId。把上面那一行原样贴进聊天，说「$label 签名公钥」；前端 B 写进配置，desktop_scan 编译后会核对两套环境各用一把。"
    Say ''
    Say "全部做好。私钥只在 Google 密码管理器$(if ($usbDir) { '和 U 盘' })里，这台电脑上没有留文件。"
}
catch {
    throw (Hide-Secrets ([string]$_.Exception.Message))
}
finally {
    if ($held) { try { $held.Dispose() } catch { } }
    $skB64 = $null; $rawOut = $null; $rawErr = $null; $back = $null
    if ($clipUsed) {
        Clear-Clip
        $fin = '已清剪贴板、清掉内存里的变量。最后关掉这个 PowerShell 窗口。'
    } else {
        $fin = '没放过私钥，剪贴板没动过；已清掉内存里的变量。最后关掉这个 PowerShell 窗口。'
    }
    [GC]::Collect()
    $Error.Clear()
    Write-Host $fin -ForegroundColor Green
}
