// tools/keys/login-token-tests.ps1 的静态检查和运行方式检查（不连真实的 Supabase、不用任何真实令牌；从头跑到尾在 login-token-tests-run.test.ts）：
// ① PowerShell AST：解析无错；双引号字符串（含 here-string）里没有中文引号 “”‘’，单引号字符串里没有 ‘’（PS 会把它们当引号，参数错位，10-28 出过）；
//    每个 Invoke-WebRequest / Invoke-RestMethod 都带 -MaximumRedirection 0
// ② Hide-Secrets：纯数字的验证码只换整词，令牌照常整串换
// ③ 运行方式：没设 LEMO_TEST_API=1 时 -SupabaseBase 被拒；点源、在窗口里用 & 调用被拒（只许 -File）；都在发任何请求之前
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, SCRIPT, writePs } from './login-token-fake.ts';

let dir = '';
const psFile = (f: string) => execFileSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' });
// 不带 LEMO_TEST_API 的环境
function envNoTest(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LEMO_TEST_API;
  return env;
}

describe.skipIf(!PS)('login-token-tests.ps1 静态检查和运行方式', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-login-static-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('解析无错、字符串里没有中文引号、每个 Invoke-WebRequest / Invoke-RestMethod 都带 -MaximumRedirection 0', () => {
    const f = writePs(
      dir,
      'ast.ps1',
      `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$t, [ref]$e)
$dq = [string][char]0x201C + [char]0x201D + [char]0x2018 + [char]0x2019
$sq = [string][char]0x2018 + [char]0x2019
$bad = @($t | Where-Object {
  $k = [string]$_.Kind
  $chars = if ($k -eq 'StringExpandable' -or $k -eq 'HereStringExpandable') { $dq } elseif ($k -eq 'StringLiteral' -or $k -eq 'HereStringLiteral') { $sq } else { '' }
  $hit = $false
  if ($chars) { foreach ($c in $chars.ToCharArray()) { if ($_.Text.IndexOf($c) -ge 0) { $hit = $true } } }
  $hit
} | ForEach-Object { $_.Extent.StartLineNumber })
$web = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and @('Invoke-WebRequest', 'Invoke-RestMethod') -contains $n.GetCommandName() }, $true) | ForEach-Object {
  @{ line = $_.Extent.StartLineNumber; ok = ($_.Extent.Text -match '-MaximumRedirection\\s+0(\\s|$)') }
})
[Console]::Out.Write((@{ errors = @($e | ForEach-Object { $_.Message }); curly = $bad; web = $web } | ConvertTo-Json -Depth 4 -Compress))`,
    );
    const r = JSON.parse(psFile(f));
    expect(r.errors).toEqual([]);
    expect(r.curly, '字符串里出现了中文引号（所在行）').toEqual([]);
    const web = Array.isArray(r.web) ? r.web : [r.web];
    expect(web.length).toBeGreaterThan(0);
    for (const w of web) expect(w.ok, `第 ${w.line} 行没带 -MaximumRedirection 0`).toBe(true);
  }, 60_000);

  it('finally 清掉登录时的哈希、解码后的链接、SecureString 和 $Matches（两次 verify 之间按 Ctrl+C 也不留在作用域里）', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const fin = text.slice(text.lastIndexOf('\nfinally {'));
    expect(fin).toContain('$hash = $null; $u = $null; $sec = $null; $Matches = $null');
    // 去掉 pkce_ 前缀的哈希、解码循环里每一步的链接都登记成秘密
    expect(text).toContain("$hash = $hash -replace '\\Apkce_', ''");
    expect(text).toMatch(/for \(\$k = 0; \$k -lt 3; \$k\+\+\) \{ \$u = \[uri\]::UnescapeDataString\(\$u\); Add-Secret \$u \}/);
  });

  it('Hide-Secrets：验证码只换整词，令牌整串换', () => {
    const f = writePs(
      dir,
      'hide.ps1',
      `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$t, [ref]$e)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Hide-Secrets' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$script:secretVals = New-Object System.Collections.Generic.List[string]
$script:secretVals.Add('864209'); $script:secretVals.Add('tok-ABCDEFGH')
[Console]::Out.Write((Hide-Secrets 'a 864209 b 1864209 c 8642090 d tok-ABCDEFGHx'))`,
    );
    expect(psFile(f)).toBe('a *** b 1864209 c 8642090 d ***x');
  }, 60_000);

  it('没设 LEMO_TEST_API 时 -SupabaseBase 被拒；点源、在窗口里用 & 调用被拒；都在发请求之前', () => {
    const run = (args: string[]) => spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env: envNoTest() });
    const a = run(['-File', SCRIPT, '-SupabaseBase', 'http://127.0.0.1:9']);
    expect(a.status).not.toBe(0);
    expect(a.stdout + a.stderr).toContain('只给测试用');
    const b = run(['-Command', `. ${q(SCRIPT)}`]);
    expect(b.status).not.toBe(0);
    expect(b.stdout + b.stderr).toContain('不要点源');
    const c = run(['-Command', `& ${q(SCRIPT)}`]);
    expect(c.status).not.toBe(0);
    expect(c.stdout + c.stderr).toContain('不要在已打开的窗口里用 & 调用');
    for (const x of [a, b, c]) expect(x.stdout).not.toContain('登录令牌测试');
  }, 60_000);
});
