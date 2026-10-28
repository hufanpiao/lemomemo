// tools/keys/set-fn-role-passwords.ps1 的测试（不连真实的 Supabase、不用任何真实令牌）：
// ① 静态：PowerShell 解析无错；双引号字符串里没有中文引号（会被当成引号导致参数错位，10-28 出过）；每个 Read-Value 调用 4 个参数、第 3 个是能编译的正则常量；
//    _shared/db.ts 写死 ssl: 'require'（安全审查严重 1）
// ② SCRAM-SHA-256 校验串：从脚本里按 AST 取出函数单独跑，和 Python（hashlib.pbkdf2_hmac + hmac）、Node（crypto）独立算出的结果逐字比对；
//    再用 RFC 7677 第 3 节示例的 ClientProof、ServerSignature 当固定标准答案核对（安全审查低 10）
// ③ -ApiBase 的反面用例：evil 后缀、@ 主机、结尾斜杠、结尾换行一律被参数校验拒绝；本机地址不设 LEMO_TEST_API=1 也被拒（低 6）
// ④ 从头跑到尾的用例在 set-fn-role-passwords-run.test.ts
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过。会清一次本机剪贴板历史（脚本收尾的 Clear-Clip）
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const SCRIPT = join(root, 'tools', 'keys', 'set-fn-role-passwords.ps1');

function findPs(): string | null {
  const cands = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const PS = findPs();

let dir = '';
function writePs(name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, '﻿' + text, 'utf8');
  return p;
}
function psFile(file: string, args: string[] = []): string {
  return execFileSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8' });
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const b64 = (s: string) => Buffer.from(s, 'base64');

// 独立实现：Node crypto
function scramNode(password: string, salt: Buffer): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
// 独立实现：Python 标准库
function scramPython(password: string, saltB64: string): string {
  const code = [
    'import sys, hashlib, hmac, base64',
    'pw = sys.argv[1].encode("utf-8"); salt = base64.b64decode(sys.argv[2])',
    'sp = hashlib.pbkdf2_hmac("sha256", pw, salt, 4096)',
    'ck = hmac.new(sp, b"Client Key", hashlib.sha256).digest()',
    'sk = hmac.new(sp, b"Server Key", hashlib.sha256).digest()',
    'b = lambda x: base64.b64encode(x).decode()',
    'print("SCRAM-SHA-256$4096:" + b(salt) + "$" + b(hashlib.sha256(ck).digest()) + ":" + b(sk))',
  ].join('\n');
  return execFileSync('python', ['-I', '-c', code, password, saltB64], { encoding: 'utf8' }).trim();
}

describe('_shared/db.ts 强制 TLS', () => {
  it("connect() 写死 ssl: 'require'，不依赖连接串里的 sslmode", () => {
    const code = readFileSync(join(root, 'supabase', 'functions', '_shared', 'db.ts'), 'utf8');
    expect(code).toMatch(/postgres\(url, \{[^}]*\bssl: 'require'/);
  });
});

describe.skipIf(!PS)('set-fn-role-passwords.ps1', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-fnpw-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('静态检查：解析无错、双引号串里没有中文引号、Read-Value 调用都是 4 个参数且第 3 个是正则', () => {
    const f = writePs(
      'ast.ps1',
      `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$t, [ref]$e)
$curly = [string][char]0x201C + [char]0x201D + [char]0x2018 + [char]0x2019
$bad = @($t | Where-Object { ($_.Kind -eq 'StringExpandable' -or $_.Kind -eq 'StringLiteral') -and $_.Text.Length -gt 0 -and ($curly.Contains($_.Text[0]) -or $curly.Contains($_.Text[$_.Text.Length - 1])) } | ForEach-Object { $_.Extent.StartLineNumber })
$calls = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Read-Value' }, $true) | ForEach-Object {
  $el = $_.CommandElements
  $third = $null; $ok = $false
  if ($el.Count -ge 4 -and $el[3] -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    $third = $el[3].Value
    try { $null = [regex]::new($third); $ok = $true } catch { }
  }
  [pscustomobject]@{ line = $_.Extent.StartLineNumber; args = $el.Count - 1; regex = $third; compiles = $ok }
})
$def = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-Value' }, $true))
[Console]::Out.Write((@{ errors = @($e | ForEach-Object { $_.Message }); curly = $bad; calls = $calls; defParams = $def[0].Parameters.Count } | ConvertTo-Json -Depth 4 -Compress))`,
    );
    const r = JSON.parse(psFile(f));
    expect(r.errors).toEqual([]);
    expect(r.curly, '双引号字符串里出现了中文引号（所在行）').toEqual([]);
    expect(r.defParams).toBe(4);
    const calls = Array.isArray(r.calls) ? r.calls : [r.calls];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.args, `第 ${c.line} 行 Read-Value 参数个数`).toBe(4);
      expect(c.compiles, `第 ${c.line} 行第 3 个参数不是能编译的正则常量`).toBe(true);
      expect(c.regex, `第 ${c.line} 行正则要锚定首尾`).toMatch(/^\^.*\$$/);
    }
  });

  const scramPs = () =>
    writePs(
      'scram.ps1',
      `param([string]$pw, [string]$salt)
$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$t, [ref]$e)
foreach ($name in 'Get-Pbkdf2Sha256', 'New-ScramVerifier') {
  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  . ([scriptblock]::Create($fn.Extent.Text))
}
[Console]::Out.Write((New-ScramVerifier $pw ([Convert]::FromBase64String($salt))))`,
    );

  it('SCRAM-SHA-256 校验串和 Python、Node 独立算出的一致', () => {
    const vectors = [
      { pw: 'pencil', salt: 'W22ZaJ0SNY7soEsUEjb6gQ==' },
      { pw: 'Ab3_-xyzXYZ0123456789abcdefghijklmnopqrst_-', salt: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex').toString('base64') },
    ];
    const f = scramPs();
    for (const v of vectors) {
      const fromPs = psFile(f, [v.pw, v.salt]).trim();
      const fromPy = scramPython(v.pw, v.salt);
      expect(fromPy).toBe(scramNode(v.pw, b64(v.salt)));
      expect(fromPs).toBe(fromPy);
    }
  }, 60_000);

  it('RFC 7677 第 3 节示例：用校验串里的 StoredKey、ServerKey 复核 ClientProof 和 ServerSignature（固定标准答案）', () => {
    // RFC 7677 第 3 节（user / pencil，盐 W22ZaJ0SNY7soEsUEjb6gQ==，4096 轮）原文的四行交换：
    //   C: n,,n=user,r=rOprNGfwEbeRWgbNEkqO
    //   S: r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096
    //   C: c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=
    //   S: v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
    const CLIENT_PROOF = 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
    const SERVER_SIGNATURE = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';
    // 安全审查员独立算出的校验串（10-28），和本仓库的 Python 结果一致
    const REVIEWER = 'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=';

    const ver = psFile(scramPs(), ['pencil', 'W22ZaJ0SNY7soEsUEjb6gQ==']).trim();
    expect(ver).toBe(REVIEWER);
    const m = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(ver);
    expect(m).not.toBeNull();
    const storedKey = b64(m?.[2] ?? '');
    const serverKey = b64(m?.[3] ?? '');
    // 服务器一侧的验证：ClientKey = ClientProof XOR HMAC(StoredKey, AuthMessage)，SHA256(ClientKey) 必须等于 StoredKey
    const clientSig = createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = b64(CLIENT_PROOF);
    const clientKey = Buffer.from(proof.map((x, i) => x ^ (clientSig[i] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest().toString('base64')).toBe(storedKey.toString('base64'));
    expect(createHmac('sha256', serverKey).update(authMessage).digest().toString('base64')).toBe(SERVER_SIGNATURE);
  }, 60_000);

  it('Hide-Secrets：报错里的两个密码和令牌换成 ***（变量还没建时原样返回、不报错）', () => {
    const f = writePs(
      'hide.ps1',
      `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$t, [ref]$e)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Hide-Secrets' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$early = Hide-Secrets 'x-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-x'
$pw = @{ fn_vault = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; fn_ai = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }
$sbTok = 'sbp_CCCCCCCCCCCCCCCCCCCCCCCC'
$late = Hide-Secrets 'u=postgresql://fn_vault.r:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@h,v=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB,t=Bearer sbp_CCCCCCCCCCCCCCCCCCCCCCCC'
[Console]::Out.Write((@{ early = $early; late = $late } | ConvertTo-Json -Compress))`,
    );
    const r = JSON.parse(psFile(f));
    expect(r.early).toBe('x-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-x');
    expect(r.late).toBe('u=postgresql://fn_vault.r:***@h,v=***,t=Bearer ***');
  });

  it('-ApiBase：evil 后缀、@ 主机、结尾斜杠、结尾换行被参数校验拒绝；本机地址不设 LEMO_TEST_API=1 也被拒', () => {
    const f = writePs(
      'apibase.ps1',
      `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$vals = @('http://127.0.0.1:1234.evil.com', 'http://127.0.0.1:1234@evil.com', 'http://127.0.0.1:1234/', ('http://127.0.0.1:1234' + [char]10),
  'https://api.supabase.com.evil.com', 'https://api.supabase.com/', ('https://api.supabase.com' + [char]10), 'http://127.0.0.1', 'http://evil.com:1234')
$out = @()
$env:LEMO_TEST_API = '1'
foreach ($v in $vals) {
  $r = 'accepted'
  try { & ${q(SCRIPT)} -Target preview -ApiBase $v } catch { $r = if ($_.FullyQualifiedErrorId -like 'ParameterArgumentValidationError*') { 'validation' } else { 'other' } }
  $out += $r
}
Remove-Item Env:LEMO_TEST_API
$noEnv = 'accepted'
try { & ${q(SCRIPT)} -Target preview -ApiBase 'http://127.0.0.1:1234' } catch { $noEnv = [string]$_.Exception.Message }
[Console]::Out.Write((@{ vals = $out; noEnv = $noEnv } | ConvertTo-Json -Compress))`,
    );
    const r = JSON.parse(psFile(f));
    expect(r.vals).toEqual(Array(9).fill('validation'));
    expect(r.noEnv).toContain('-ApiBase 只给测试用');
  }, 60_000);
});
