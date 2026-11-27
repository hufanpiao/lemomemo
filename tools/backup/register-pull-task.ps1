<#
.SYNOPSIS
  注册每天 09:00 拉备份的 Windows 计划任务（架构第 10 节“拉回本机”；B7a 复审第 8 条）：由产品负责人本人在自己电脑的 PowerShell 窗口里运行一次。

.DESCRIPTION
  建一个名叫 lemomemo-backup-pull 的计划任务（已有就按同样的设置覆盖，可以放心重跑）：
    • 每天本机时间 09:00 运行 powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本仓库>\tools\backup\pull.ps1"（不带参数）；
    • 错过了（电脑关着、睡眠）开机后尽快补跑（StartWhenAvailable）；用电池时也跑、不因为换成电池停下；
    • 以当前登录的这个 Windows 用户、只在登录时运行（凭据管理器里的 lemomemo.backup.pull、lemomemo.backup.r2-pull 只有这个用户读得到；
      不存 Windows 密码，不要管理员权限）；一次最多跑 2 小时，上一次还没跑完不另起一份；
    • 工作目录是本仓库根目录。
  pull.ps1 退出码不是 0 时计划任务显示“上次运行结果”不是 0x0；lemo-ops 超过 26 小时没收到 backup-pull 心跳会发邮件（第 6.1 节）。
  先要做完：tools\keys\set-backup-pull-token.ps1 -Target prod（BACKUP_PULL_TOKEN）、tools\backup\pull.ps1 -Setup（R2 只读令牌、配置.json）。
  这个脚本不读、不写任何密钥。

.PARAMETER Unregister
  删掉这个计划任务（不再每天拉）。

.PARAMETER PrintOnly
  只打印要注册的设置（JSON），不注册（测试和核对用）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记\柠檬记APP\tools\backup\register-pull-task.ps1"
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\claude code\柠檬记\柠檬记APP\tools\backup\register-pull-task.ps1" -Unregister
#>
[CmdletBinding()]
param(
    [switch]$Unregister,
    [switch]$PrintOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$TaskName = 'lemomemo-backup-pull'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Pull = Join-Path $RepoRoot 'tools\backup\pull.ps1'
if (-not (Test-Path -LiteralPath $Pull -PathType Leaf)) { throw "已停止：找不到 $Pull" }
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Pull`""
$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $PsExe -Argument $Arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
if ($PrintOnly) {
    # 只建设置对象、不注册，打印出来核对（tests/build/backup-pull.test.ts）
    $plan = [ordered]@{
        task = $TaskName; execute = $action.Execute; arguments = $action.Arguments; workdir = $action.WorkingDirectory
        at = ([datetime]$trigger.StartBoundary).ToString('HH:mm'); days_interval = $trigger.DaysInterval
        start_when_available = $settings.StartWhenAvailable; battery = (-not $settings.DisallowStartIfOnBatteries -and -not $settings.StopIfGoingOnBatteries)
        limit = $settings.ExecutionTimeLimit; multiple = [string]$settings.MultipleInstances
        logon = [string]$principal.LogonType; run_level = [string]$principal.RunLevel; user_is_me = ($principal.UserId -eq $User)
    }
    [Console]::Out.Write(($plan | ConvertTo-Json -Compress))
    exit 0
}

if ($Unregister) {
    if (Get-ScheduledTask -TaskName ${TaskName} -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName ${TaskName} -Confirm:$false
        Write-Host "已删掉计划任务 ${TaskName}。" -ForegroundColor Green
    } else {
        Write-Host "没有计划任务 ${TaskName}，不用删。"
    }
    exit 0
}

$null = Register-ScheduledTask -TaskName ${TaskName} -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description '柠檬记：每天把服务器备份拉回本机（tools\backup\pull.ps1；错过了开机补跑）' -Force

# 注册完读回来核对
$t = Get-ScheduledTask -TaskName ${TaskName}
$a = @($t.Actions)[0]
if ($a.Execute -ne $PsExe -or $a.Arguments -ne $Arguments -or -not $t.Settings.StartWhenAvailable) { throw "已停止：计划任务 ${TaskName} 读回来的设置对不上，请在聊天里告诉运维" }
$next = (Get-ScheduledTaskInfo -TaskName ${TaskName}).NextRunTime
Write-Host "已注册计划任务 ${TaskName}：每天 09:00 运行 pull.ps1，错过了开机补跑。下次运行：$next" -ForegroundColor Green
Write-Host '想马上试一次：在“任务计划程序”里右键这个任务点“运行”，或运行 pull.ps1（不带参数），看到「已写心跳 backup-pull」、退出码 0 就好了。'
