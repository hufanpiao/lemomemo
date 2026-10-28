# 版本前备份的加密（ADR-009，R-105）。**只由负责人本人运行**，AI 不运行、不接触密码。
#
# 用法（build/backup.py 跑完会打印这条命令）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\待办APP\build\backup_encrypt.ps1" -Tag "2026-10-28_4.0.0开发前"
#
# 做五件事：
# 1. 找 7z.exe（常见安装路径和 PATH），找不到就停下，提示先装 7-Zip。
# 2. 创建 E:\柠檬记-备份\版本前\。
# 3. 用 7z a -t7z -mhe=on -p 把暂存目录 E:\柠檬记-备份\暂存\<Tag>\ 打成 版本前\<Tag>.7z。
#    -p 后面不写密码，由 7z 自己提示输入（输两次）；本脚本不接收、不保存、不记录密码。
# 4. 用 7z t 测试压缩包（7z 会再提示输入一次密码），确认密码对、文件完整。
# 5. 测试通过后删除明文：暂存目录、项目内 data\backups\<Tag>\；输出 .7z 的路径、大小、SHA256。
# 任何一步失败都停下，不删明文。
# 本文件存成 UTF-8 with BOM（Windows PowerShell 5.1 才能正确读中文）。

param(
    [Parameter(Mandatory = $true)][string]$Tag
)

$ErrorActionPreference = 'Stop'
$BackupHome = 'E:\柠檬记-备份'
$Stage = Join-Path $BackupHome "暂存\$Tag"
$OutDir = Join-Path $BackupHome '版本前'
$Archive = Join-Path $OutDir "$Tag.7z"
$ProjectData = Join-Path (Split-Path $PSScriptRoot -Parent) "data\backups\$Tag"

function Stop-Backup([string]$Msg) {
    Write-Host "加密失败：$Msg" -ForegroundColor Red
    Write-Host '明文没有删除，处理好以后可以重新运行本脚本。' -ForegroundColor Yellow
    exit 1
}

# 1. 找 7z.exe
$SevenZip = $null
$candidates = @(
    "$env:ProgramFiles\7-Zip\7z.exe",
    "${env:ProgramFiles(x86)}\7-Zip\7z.exe",
    "$env:LOCALAPPDATA\Programs\7-Zip\7z.exe"
)
foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { $SevenZip = $p; break }
}
if (-not $SevenZip) {
    $cmd = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if ($cmd) { $SevenZip = $cmd.Source }
}
if (-not $SevenZip) {
    Stop-Backup '没找到 7z.exe。请先从 https://www.7-zip.org/ 下载安装 7-Zip（64 位），装在默认位置 C:\Program Files\7-Zip\，再运行本脚本。'
}
Write-Host "使用 7-Zip：$SevenZip"

# 检查暂存目录和目标文件
if (-not (Test-Path -LiteralPath $Stage -PathType Container)) {
    Stop-Backup "没找到暂存目录 $Stage。请先运行 python build/backup.py <时机>。"
}
if (-not (Test-Path -LiteralPath (Join-Path $Stage '清单.json'))) {
    Stop-Backup "暂存目录里没有 清单.json，可能 backup.py 没跑完：$Stage"
}
if (Test-Path -LiteralPath $Archive) {
    Stop-Backup "$Archive 已经存在。为了不覆盖旧备份，本脚本不会往里追加；请确认后换一个时机名重新备份。"
}

# 2. 创建输出文件夹
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 3. 加密打包（7z 自己提示输入密码，输两次）
Write-Host ''
Write-Host '第 1 步：加密打包。7-Zip 会提示输入密码（屏幕上不显示），再输一次确认。' -ForegroundColor Cyan
Write-Host '请用 iPhone“密码”App 里保存的柠檬记备份密码；第一次备份就先在 App 里新建一条再输入。' -ForegroundColor Cyan
& $SevenZip a -t7z -mhe=on -mx=9 -p $Archive (Join-Path $Stage '*')
if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
    Stop-Backup "7z 打包出错（退出码 $LASTEXITCODE）。"
}

# 4. 测试压缩包（7z 再提示输入一次密码）
Write-Host ''
Write-Host '第 2 步：测试压缩包。请再输入一次同一个密码，确认密码记对了、文件完整。' -ForegroundColor Cyan
& $SevenZip t -p $Archive
if ($LASTEXITCODE -ne 0) {
    Stop-Backup "7z 测试没通过（退出码 $LASTEXITCODE）：可能密码输错或文件损坏。压缩包 $Archive 留着没删，请确认后删掉它再重新运行。"
}

# 5. 删除明文
Write-Host ''
Write-Host '第 3 步：测试通过，删除明文。' -ForegroundColor Cyan
Remove-Item -LiteralPath $Stage -Recurse -Force
Write-Host "已删除暂存目录：$Stage"
$StageRoot = Split-Path $Stage -Parent
if ((Test-Path -LiteralPath $StageRoot) -and -not (Get-ChildItem -LiteralPath $StageRoot -Force)) {
    Remove-Item -LiteralPath $StageRoot -Force
}
if (Test-Path -LiteralPath $ProjectData) {
    Remove-Item -LiteralPath $ProjectData -Recurse -Force
    Write-Host "已删除项目内的明文数据：$ProjectData"
} else {
    Write-Host "项目内没有 $ProjectData（只备份了源码，或已删除）。"
}

# 输出结果
$item = Get-Item -LiteralPath $Archive
$hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
Write-Host ''
Write-Host '备份完成。' -ForegroundColor Green
Write-Host "文件：$($item.FullName)"
Write-Host ("大小：{0:N0} 字节（{1:N1} MB）" -f $item.Length, ($item.Length / 1MB))
Write-Host "SHA256：$hash"
Write-Host '请把上面三行发给主持人记进发布记录（这三行不含密码，可以发）。密码不要发给任何人，也不要发到聊天里。'
