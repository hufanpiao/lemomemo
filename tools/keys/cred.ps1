# ==== Windows 凭据管理器的读写（tools 下处理凭据的脚本共用；B7a 复审“重复和简化”）====
# 原来 tools/backup/pull.ps1、tools/keys/set-r2-tokens.ps1、tools/claude-intake/add.ps1 各抄一份 CredWriteW / CredReadW 的 C# 封装和 Read-Secret，
# 收到这一份。用法（点引用，只定义函数，不能单独运行）：
#   . (Join-Path $PSScriptRoot '..\keys\cred.ps1')      # tools/keys 下的脚本写 Join-Path $PSScriptRoot 'cred.ps1'
#   Write-LemoCred 'lemomemo.backup.pull' 'lemomemo' $value
#   $c = Read-LemoCred 'lemomemo.backup.pull'           # 没有这一条回 $null；有就是 @{ User; Secret; LastWritten（UTC 时刻） }
#   $s = Read-Secret '粘贴 …（屏幕不显示），回车'        # Read-Host -AsSecureString 读一行、去掉首尾空白
# 用 Win32 CredWriteW 写（一般凭据、本机持久），不经 cmdkey（cmdkey 要把密码写在命令行参数里）。值不打印、不写文件。
# 只给测试用：LEMO_TEST_CRED_DIR 指向一个目录、且 LEMO_TEST_API=1 时，读写改成这个目录下的 <target>.json（假值），不碰真凭据管理器。

function Get-LemoCredTestFile([string]$Target) {
    $dir = [Environment]::GetEnvironmentVariable('LEMO_TEST_CRED_DIR')
    if (-not $dir -or [Environment]::GetEnvironmentVariable('LEMO_TEST_API') -ne '1') { return $null }
    if ($Target -cnotmatch '\A[a-z0-9.-]{1,64}\z') { throw "凭据名不对：$Target" }
    return Join-Path $dir "$Target.json"
}

function Initialize-LemoCred {
    if ('LemoCredStore' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LemoCredStore {
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
    public static void Write(string target, string user, string secret) {
        IntPtr blob = Marshal.StringToCoTaskMemUni(secret);
        try {
            var c = new CREDENTIAL { Type = 1, TargetName = target, UserName = user, Persist = 2,
                CredentialBlob = blob, CredentialBlobSize = secret.Length * 2 };
            if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
    }
    /** 没有这一条回 null；有就回 { 用户名, 值, 最后写入时刻（FILETIME 的 UTC ticks，十进制） } */
    public static string[] Read(string target) {
        IntPtr p;
        if (!CredReadW(target, 1, 0, out p)) return null;
        try {
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize <= 0) return null;
            long ft = ((long)(uint)c.LastWritten.dwHighDateTime << 32) | (uint)c.LastWritten.dwLowDateTime;
            return new string[] { c.UserName, Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2), DateTime.FromFileTimeUtc(ft).Ticks.ToString() };
        } finally { CredFree(p); }
    }
}
'@
}

function Write-LemoCred([string]$Target, [string]$User, [string]$Secret) {
    $f = Get-LemoCredTestFile $Target
    if ($f) {
        $doc = @{ user = $User; secret = $Secret; written = [datetime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($f, $doc, (New-Object System.Text.UTF8Encoding($false)))
        return
    }
    Initialize-LemoCred
    [LemoCredStore]::Write($Target, $User, $Secret)
}

function Read-LemoCred([string]$Target) {
    $f = Get-LemoCredTestFile $Target
    if ($f) {
        if (-not (Test-Path -LiteralPath $f)) { return $null }
        $j = [IO.File]::ReadAllText($f) | ConvertFrom-Json
        $at = $j.written
        if (-not ($at -is [datetime])) { $at = [datetime]::Parse([string]$at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal) }
        return [pscustomobject]@{ User = [string]$j.user; Secret = [string]$j.secret; LastWritten = $at.ToUniversalTime() }
    }
    Initialize-LemoCred
    $r = [LemoCredStore]::Read($Target)
    if (-not $r) { return $null }
    return [pscustomobject]@{ User = $r[0]; Secret = $r[1]; LastWritten = [datetime]::new([long]$r[2], [DateTimeKind]::Utc) }
}

function Read-Secret([string]$Prompt) {
    $sec = Read-Host -AsSecureString $Prompt
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $sec.Dispose() }
}
