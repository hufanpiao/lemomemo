// tools/ 下所有 .ps1 的静态检查（只解析，不运行脚本）：
// ① Windows PowerShell 5.1 解析无错；
// ② 双引号字符串里没有中文弯引号——PowerShell 把 “ ” ‘ ’ 当成引号，字符串会被截断、参数错位
//   （10-28 set-fn-role-passwords.ps1、10-29 publish.ps1 第 94/265/422/452 行和 new-proxy-secret.ps1 第 154 行都出过）。
// 新加的 .ps1 自动纳入。需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就跳过。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function findPs(): string | null {
  const cands = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const PS = findPs();

function listPs1(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listPs1(p));
    else if (e.name.toLowerCase().endsWith('.ps1')) out.push(p);
  }
  return out;
}
const FILES = listPs1(join(root, 'tools'));
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe.skipIf(!PS)('tools/ 下的 .ps1：解析无错、双引号字符串里没有中文弯引号', () => {
  let dir = '';
  type R = { file: string; errors: number; curly: number[] };
  let results: R[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-ps1-static-'));
    const f = join(dir, 'scan.ps1');
    writeFileSync(
      f,
      '\uFEFF' +
        `$curly = [string][char]0x201C + [char]0x201D + [char]0x2018 + [char]0x2019
$res = foreach ($p in @(${FILES.map(q).join(', ')})) {
  $t = $null; $e = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e)
  $bad = @($t | Where-Object { ($_.Kind -eq 'StringExpandable' -or $_.Kind -eq 'StringLiteral') -and $_.Text.Length -gt 0 -and ($curly.Contains($_.Text[0]) -or $curly.Contains($_.Text[$_.Text.Length - 1])) } | ForEach-Object { $_.Extent.StartLineNumber })
  [pscustomobject]@{ file = $p; errors = @($e).Count; curly = $bad }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($res) -Compress -Depth 3))`,
      'utf8',
    );
    const r = spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    results = (JSON.parse(r.stdout) as R[]).map((x) => ({ ...x, curly: Array.isArray(x.curly) ? x.curly : [] }));
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('找到了 tools/ 下的脚本（至少有 publish.ps1 和 tools/keys 的几个）', () => {
    expect(FILES.some((f) => f.endsWith(join('release', 'publish.ps1')))).toBe(true);
    expect(results).toHaveLength(FILES.length);
  });

  it('每个脚本解析 0 错误', () => {
    for (const r of results) expect(r.errors, r.file).toBe(0);
  });

  it('每个脚本的双引号字符串里没有中文弯引号（所在行）', () => {
    for (const r of results) expect(r.curly, r.file).toEqual([]);
  });
});
