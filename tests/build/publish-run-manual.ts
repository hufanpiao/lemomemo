// publish-run-deploy.test.ts 用的两样辅助（从那个文件拆出来，免得超过 300 行）：
// R-264 判断本机真的 system 一级 git 配置是不是只有 Git for Windows 自带的四项 git-lfs；
// OPS-deploy-sugg ⑤ 取出上线与回滚手册第三节“设六个密钥”那段 PowerShell，在演练台的假仓库里用假 npm、假 node、假令牌跑。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { ACCT, CF_TOKEN, ctx, PS, root } from './publish-run-harness.ts';

// 本机真的 system 一级配置里，filter.* 和 core.attributesfile 是否正好是 Git for Windows 自带的那四项（值也一样）
export function realSystemIsLfsOnly(): boolean {
  if (!PS) return false;
  const env = { ...process.env };
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_CONFIG_NOSYSTEM;
  const r = spawnSync('git', ['config', '--system', '--list', '-z'], { encoding: 'utf8', env });
  if (r.status !== 0) return false;
  const want: Record<string, string> = { 'filter.lfs.clean': 'git-lfs clean -- %f', 'filter.lfs.smudge': 'git-lfs smudge -- %f', 'filter.lfs.process': 'git-lfs filter-process', 'filter.lfs.required': 'true' };
  const got = r.stdout.split('\0').filter((e) => e !== '').map((e) => e.split('\n')).filter(([k]) => /^filter\./iu.test(k ?? '') || (k ?? '').toLowerCase() === 'core.attributesfile');
  return got.length === 4 && got.every(([k, v]) => k !== undefined && want[k] === v);
}

// 手册第三节“按 .dev.vars.example 设好六个密钥”下面那个 powershell 代码块（去掉列表的 5 格缩进）
/** 手册里的两段 wrangler 命令：第三节“设六个密钥”（列表缩进 5 格）、第四节 2b“lemo-ops 跟着回滚”（缩进 3 格） */
export type ManualWhich = 'secrets' | 'rollback';
const ANCHOR: Record<ManualWhich, { find: string; indent: number }> = {
  secrets: { find: '设好六个密钥', indent: 5 },
  rollback: { find: '2b. **lemo-ops 跟着回滚到同一个 tag**', indent: 3 },
};
// 第四节 2b 那段也能取（锚点之后的第一个 powershell 代码块，去掉列表缩进）
export function manualBlock(which: ManualWhich = 'secrets'): string {
  const md = readFileSync(join(root, 'docs', '08-发布', '上线与回滚手册-v4.md'), 'utf8');
  const { find, indent } = ANCHOR[which];
  const at = md.indexOf(find);
  expect(at, find).toBeGreaterThan(0);
  const a = md.indexOf('```powershell', at);
  const b = md.indexOf('```', a + 13);
  const pad = ' '.repeat(indent);
  return md.slice(a + 13, b).split('\n').map((l) => (l.startsWith(pad) ? l.slice(indent) : l)).join('\n');
}

// 在演练台的假仓库根目录跑手册那段命令：npm.cmd 装演练台的假依赖树（和假仓库里的 wrangler-tree.lock 一致；extra 时多一个文件），
// node 只记参数、哪些令牌环境变量有值（只记名字）和 wrangler 相关变量；Read-Host 依次答 Account ID、假令牌；私有 TEMP；
// Set-Clipboard 只记一行 clip（用例核对读完令牌紧接着清了剪贴板）；git 是真的（2b 核对 HEAD 和 tag 的提交一致）
// which / inputs：跑哪一段、Read-Host 依次答什么（默认第三节：Account ID、假令牌）
export async function runManualBlock(extra: boolean, which: ManualWhich = 'secrets', inputs: string[] = [ACCT, CF_TOKEN]): Promise<{ log: string[]; left: number }> {
  const id = Math.random().toString(36).slice(2, 10);
  const log = join(ctx.dir, `manual-${id}.txt`);
  const temp = join(ctx.dir, `manual-temp-${id}`);
  mkdirSync(temp);
  writeFileSync(log, '', 'utf8');
  const blockFile = join(ctx.dir, `manual-${id}.block.ps1`);
  writeFileSync(blockFile, '\uFEFF' + manualBlock(which), 'utf8');
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const names = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_BASE_URL', 'WRANGLER_WRITE_LOGS', 'WRANGLER_LOG_PATH', 'WRANGLER_SEND_METRICS', 'DO_NOT_TRACK', 'WRANGLER_SEND_ERROR_REPORTS', 'WRANGLER_HIDE_BANNER', 'WRANGLER_NO_SKILLS_UPDATE_PROMPTS'];
  const ps = `$ErrorActionPreference = 'Stop'
$env:TEMP = ${q(temp)}; $env:TMP = ${q(temp)}
$global:SEP = [string][char]9
function global:L([string]$s) { [IO.File]::AppendAllText(${q(log)}, $s + [char]10) }
function global:Set-Clipboard { L 'clip' }
function global:Write-Host { param([Parameter(Position = 0)]$Object) L ('out' + $global:SEP + [string]$Object) }
function global:npm.cmd {
  L ('npm' + $global:SEP + (@($args) -join ' '))
  $nm = Join-Path (Get-Location).Path 'node_modules'
  $bin = Join-Path $nm 'wrangler\\bin'
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $nm '.bin') | Out-Null
  Copy-Item -LiteralPath ${q(ctx.fakeExe)} -Destination (Join-Path $bin 'wrangler.exe')
  Copy-Item -LiteralPath ${q(ctx.fakeJs)} -Destination (Join-Path $bin 'wrangler.js')
  Set-Content -LiteralPath (Join-Path $nm '.bin\\wrangler.cmd') -Value '@echo off' -Encoding Ascii
  Set-Content -LiteralPath (Join-Path $nm '.package-lock.json') -Value '{}' -Encoding Ascii
  ${extra ? `Set-Content -LiteralPath (Join-Path $nm 'extra.js') -Value 'x' -Encoding Ascii` : ''}
  $global:LASTEXITCODE = 0 }
function global:node {
  $tok = (@('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID') | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }) -join ','
  $w = 'CLOUDFLARE_API_BASE_URL=' + $env:CLOUDFLARE_API_BASE_URL + ';WRANGLER_SEND_METRICS=' + $env:WRANGLER_SEND_METRICS + ';DO_NOT_TRACK=' + $env:DO_NOT_TRACK + ';WRANGLER_SEND_ERROR_REPORTS=' + $env:WRANGLER_SEND_ERROR_REPORTS + ';WRANGLER_HIDE_BANNER=' + $env:WRANGLER_HIDE_BANNER + ';WRANGLER_NO_SKILLS_UPDATE_PROMPTS=' + $env:WRANGLER_NO_SKILLS_UPDATE_PROMPTS
  L ('node' + $global:SEP + (@($args) -join ' ') + $global:SEP + $tok + $global:SEP + $w)
  $global:LASTEXITCODE = 0 }
$global:inputs = New-Object System.Collections.Queue
${inputs.map((v) => `$global:inputs.Enqueue(${q(v)})`).join('; ')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  L ('prompt' + $global:SEP + $Prompt)
  if ($global:inputs.Count -eq 0) { throw ('test: Read-Host 多问了一次：' + $Prompt) }
  $v = $global:inputs.Dequeue()
  if ($AsSecureString) { return (ConvertTo-SecureString $v -AsPlainText -Force) }
  return $v }
Push-Location ${q(ctx.repo)}
try { & ([scriptblock]::Create([IO.File]::ReadAllText(${q(blockFile)}))) } catch { L ('error' + $global:SEP + $_.Exception.Message) } finally { Pop-Location }
L ('left' + $global:SEP + $global:inputs.Count)
L ('envleft' + $global:SEP + ((@(${names.map(q).join(', ')}) | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }) -join ','))
foreach ($d in @(Get-ChildItem -LiteralPath ${q(temp)} -Force)) { L ('templeft' + $global:SEP + $d.Name) }
`;
  const file = join(ctx.dir, `manual-${id}.ps1`);
  writeFileSync(file, '\uFEFF' + ps, 'utf8');
  const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const code = await new Promise<number>((ok) => child.on('close', (x) => ok(x ?? -1)));
  expect(code, out).toBe(0);
  const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l !== '');
  const leftLine = lines.find((l) => l.startsWith('left\t'));
  return { log: lines, left: leftLine ? Number(leftLine.split('\t')[1]) : -1 };
}
