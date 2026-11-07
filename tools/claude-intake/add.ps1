<#
.SYNOPSIS
  在电脑上的 Claude App 聊天里记事（架构 5.7；R-65；S-B3 中 6；B3 任务单 BE-5）：把一句话或几条整理好的条目发给 claude-intake。

.DESCRIPTION
  两种用法：
    -Setup：由用户本人在自己的 PowerShell 窗口里运行一次（不经过 Claude）。按提示粘贴设置页“在 Claude 聊天里记事”里只显示一次的连接码，
        脚本用 Read-Host -AsSecureString 读（屏幕不显示、不进历史），用 Win32 CredWrite 写进 Windows 凭据管理器，
        目标名 lemomemo.claude.intake（架构 B6：lemomemo.claude.* 前缀，exe 的命令读不到）。不经 cmdkey（cmdkey 要把码写在命令行参数里）。
    -Text '明天下午三点开会'、-ItemsJson '[{...}]'，或 -ItemsStdin（从标准输入读 UTF-8 的 JSON 数组，免得命令行引号被吃掉）：
        由 Claude App 在聊天里调用。脚本自己用 CredRead 从凭据管理器读出连接码，
        POST https://lemomemo.com/sb/functions/v1/claude-intake；请求头 Authorization: Bearer <连接码>、X-App-Version，
        请求体 {"text": ...} 或 {"items": [...]}。
  安全约定（S-B3 中 6）：
    • 连接码永远不出现在命令行参数、屏幕输出、文件里；Claude 的命令行里只有要记的内容，所以聊天记录里也没有连接码；
    • 只打印服务器回的 JSON（建了几条、要确认的、被跳过的）或一句中文错误，不打印请求头；
    • 只能新增：claude-intake 只收 POST、只 insert；吊销（设置页“断开连接”）后立刻 401。
  退出码：0 成功；1 参数或本机问题（没有连接码、请求体太大）；2 服务器拒绝或网络失败。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\claude-intake\add.ps1 -Setup
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\claude-intake\add.ps1 -Text '周五下午三点和小王开会'
.EXAMPLE
  '[{"kind":"todo","title":"买牛奶"}]' | powershell -NoProfile -ExecutionPolicy Bypass -File tools\claude-intake\add.ps1 -ItemsStdin
#>
[CmdletBinding(DefaultParameterSetName = 'Text')]
param(
    [Parameter(ParameterSetName = 'Setup', Mandatory = $true)][switch]$Setup,
    [Parameter(ParameterSetName = 'Text', Mandatory = $true)][string]$Text,
    [Parameter(ParameterSetName = 'Items', Mandatory = $true)][string]$ItemsJson,
    [Parameter(ParameterSetName = 'Stdin', Mandatory = $true)][switch]$ItemsStdin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$Endpoint = 'https://lemomemo.com/sb/functions/v1/claude-intake'
$CredTarget = 'lemomemo.claude.intake'
# 只给本机自测用：LEMO_INTAKE_TEST_ENDPOINT 是 http://127.0.0.1:8840～8849 的地址时，改发到这个地址、改读 lemomemo.claude.intake.test；
# 别的值一律不认（不能借环境变量把连接码发到别处）
$testEp = [Environment]::GetEnvironmentVariable('LEMO_INTAKE_TEST_ENDPOINT')
if ($testEp -and $testEp -match '^http://127\.0\.0\.1:884[0-9]/[A-Za-z0-9/_-]*$') {
    $Endpoint = $testEp
    $CredTarget = 'lemomemo.claude.intake.test'
}
$AppVersion = '4.0.0'
$TokenPattern = '^lmc_[A-Za-z0-9_-]{43}$'   # 和 supabase/functions/_shared/intake-token.ts 的 TOKEN_RE 一致
$TextMax = 2000                              # 和 shared/schema/ai.ts 的 AI_TEXT_MAX 一致
$BodyMaxBytes = 32KB                          # 和 claude-intake/core.ts 的 MAX_BODY 一致（超了服务器回 400）

function Fail([string]$msg, [int]$code = 1) {
    [Console]::Error.WriteLine("add.ps1：$msg")
    exit $code
}

function Initialize-LemoClaudeCred {
    if ('LemoClaudeCred' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LemoClaudeCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWriteW(ref CREDENTIAL c, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr cred);
    public static void Write(string target, string secret) {
        IntPtr blob = Marshal.StringToCoTaskMemUni(secret);
        try {
            var c = new CREDENTIAL { Type = 1, TargetName = target, UserName = "lemomemo", Persist = 2,
                CredentialBlob = blob, CredentialBlobSize = secret.Length * 2 };
            if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
    }
    public static string Read(string target) {
        IntPtr p;
        if (!CredReadW(target, 1, 0, out p)) return null;
        try {
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize <= 0) return null;
            return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
        } finally { CredFree(p); }
    }
}
'@
}

# ───────────────────────── -Setup：存连接码 ─────────────────────────
if ($PSCmdlet.ParameterSetName -eq 'Setup') {
    $sec = Read-Host -AsSecureString '粘贴设置页显示的连接码（屏幕不显示），回车'
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
        $code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim()
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if ($code -notmatch $TokenPattern) { Fail '连接码格式不对：应以 lmc_ 开头、共 47 个字符。请回设置页重新复制' }
    Initialize-LemoClaudeCred
    [LemoClaudeCred]::Write($CredTarget, $code)
    $code = $null
    try { Set-Clipboard -Value ' ' } catch { }
    Write-Output ('已存进 Windows 凭据管理器（' + $CredTarget + '）。以后在 Claude App 聊天里说「记到柠檬记」就行。')
    Write-Output '如果连接码是复制粘贴进来的，请按 Win+V 打开剪贴板历史，把那一条删掉（或点“全部清除”）。'
    exit 0
}

# ───────────────────────── 记事：组请求体 ─────────────────────────
if ($PSCmdlet.ParameterSetName -eq 'Text') {
    $t = $Text.Trim()
    if ($t.Length -eq 0) { Fail '要记的内容是空的' }
    if ($t.Length -gt $TextMax) { Fail "一次最多 $TextMax 个字，请分几次记" }
    $body = @{ text = $t } | ConvertTo-Json -Compress
} else {
    if ($PSCmdlet.ParameterSetName -eq 'Stdin') {
        [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
        $ItemsJson = [Console]::In.ReadToEnd()
    }
    try { $items = $ItemsJson | ConvertFrom-Json } catch { Fail '-ItemsJson 不是合法的 JSON 数组' }
    if ($null -eq $items) { Fail '-ItemsJson 是空的' }
    # ConvertFrom-Json 把单元素数组拆成对象；用原文拼，服务器端按 schema 校验
    if (-not $ItemsJson.TrimStart().StartsWith('[')) { Fail '-ItemsJson 要是 JSON 数组（[ ... ]）' }
    $body = '{"items":' + $ItemsJson.Trim() + '}'
}
$bytes = [Text.Encoding]::UTF8.GetBytes($body)
if ($bytes.Length -gt $BodyMaxBytes) { Fail '请求体太大，请分几次记' }

# ───────────────────────── 读连接码、发请求 ─────────────────────────
Initialize-LemoClaudeCred
$token = [LemoClaudeCred]::Read($CredTarget)
if ($null -eq $token -or $token -notmatch $TokenPattern) {
    Fail '凭据管理器里没有可用的连接码。请先在设置 › 在 Claude 聊天里记事 生成连接码，再在自己的 PowerShell 里运行 add.ps1 -Setup'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ Authorization = "Bearer $token"; 'X-App-Version' = $AppVersion }
$token = $null
try {
    $resp = Invoke-WebRequest -Uri $Endpoint -Method Post -Headers $headers -Body $bytes `
        -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 30
    $headers = $null
    $json = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
    Write-Output $json
    exit 0
} catch {
    $headers = $null
    $status = 0
    $r = $_.Exception.Response
    if ($null -ne $r) { try { $status = [int]$r.StatusCode } catch { $status = 0 } }
    switch ($status) {
        0 { Fail '连不上 lemomemo.com（网络问题或超时），稍后再试' 2 }
        400 { Fail '内容格式不对或太长，服务器没收（400）' 2 }
        401 { Fail '连接码无效、已断开或已过期（180 天）。请在设置里重新生成，再运行 add.ps1 -Setup' 2 }
        403 { Fail '账号现在不能写入（403），请打开柠檬记看看' 2 }
        405 { Fail '请求方法不对（405）' 2 }
        413 { Fail '内容太大（413），请分几次记' 2 }
        429 { Fail '记得太频繁了：每个连接码每小时 60 次、每天 200 条（429），稍后再试' 2 }
        503 { Fail '服务器暂时没存上，这次什么都没记（503），稍后再试' 2 }
        default { Fail "服务器出错（$status），稍后再试" 2 }
    }
}
