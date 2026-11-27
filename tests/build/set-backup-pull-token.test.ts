// tools/keys/set-backup-pull-token.ps1 的测试（B7a 复审第 8 条；不连真实的 Supabase、不用任何真实令牌、不碰真凭据管理器）：
// ① 静态：PowerShell 解析无错；字符串里没有中文引号；每个 Invoke-RestMethod 都带 -MaximumRedirection 0；Set-Clipboard 只清空；
//    -ApiBase、-Target 的反面用例；点源、& 调用被拒（只许 -File）
// ② 从头跑到尾：外壳屏蔽 Read-Host（从队列取值）、注册表检查，把 Set-Clipboard、Start-Process 换成「记下来」，-ApiBase 指向本机假服务（另设 LEMO_TEST_API=1），
//    凭据管理器换成 LEMO_TEST_CRED_DIR 下的文件（tools/keys/cred.ps1 的测试分支）。核对：值在本机生成（64 位十六进制）、原样写成 BACKUP_PULL_TOKEN、
//    正式环境同一个值写进 lemomemo.backup.pull、原有 secrets 不少、屏幕不显示值和令牌；写 secrets 出错不打印正文、提示重跑；预览不写凭据管理器
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, root, writePs } from './login-token-fake.ts';

const SCRIPT = join(root, 'tools', 'keys', 'set-backup-pull-token.ps1');
const REFS = { preview: 'yoeqwhygehbaftkppati', prod: 'uvlnwawwsdfihziaielj' } as const;
const NAMES = { preview: 'lemomemo-preview', prod: 'lemomemo-prod' } as const;
const TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_token_'.padEnd(40, 'z');
const FINALLY = '已清剪贴板、清掉内存里的变量';
const RERUN = '函数侧的 BACKUP_PULL_TOKEN 已换、本机凭据管理器还没换好';
const HEX32 = /[0-9a-fA-F]{32,}/;
const CRED_TARGET = 'lemomemo.backup.pull';

let dir = '';
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env });

type Req = { method: string; path: string; auth: string; body: string };
type Opts = { target?: 'preview' | 'prod'; projName?: string; failPost?: boolean; credDir?: string };

async function runScript(opts: Opts = {}) {
  const target = opts.target ?? 'prod';
  const base = `/v1/projects/${REFS[target]}`;
  const reqs: Req[] = [];
  const secrets = new Map<string, string>([['GEMINI_API_KEY', 'x'], ['OPS_SECRET', 'y']]);
  const send = (res: ServerResponse, code: number, obj: unknown) => {
    const text = obj === undefined ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' });
    res.end(text);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      const path = req.url ?? '';
      reqs.push({ method: req.method ?? '', path, auth: String(req.headers.authorization ?? ''), body });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Unauthorized' });
      if (req.method === 'GET' && path === base) return send(res, 200, { ref: REFS[target], name: opts.projName ?? NAMES[target], region: 'ap-northeast-2' });
      if (req.method === 'GET' && path === `${base}/secrets`) return send(res, 200, [...secrets.keys()].map((name) => ({ name, value: 'digest' })));
      if (req.method === 'POST' && path === `${base}/secrets`) {
        if (opts.failPost) return send(res, 400, `{"message":"bad request: ${body.replace(/"/g, '\\"')}"}`);
        for (const s of JSON.parse(body) as { name: string; value: string }[]) secrets.set(s.name, s.value);
        return send(res, 201, undefined);
      }
      return send(res, 404, { message: 'not found' });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const events = join(dir, `events-${port}.json`);
  const credDir = opts.credDir ?? mkdtempSync(join(dir, 'cred-'));
  const harness = writePs(
    dir,
    `run-${port}.ps1`,
    `$ErrorActionPreference = 'Stop'
$env:LEMO_TEST_API = '1'
$env:LEMO_TEST_CRED_DIR = ${q(credDir)}
function global:Get-ItemProperty { $null }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
$global:ev = New-Object System.Collections.Generic.List[string]
function global:Set-Clipboard { param([string]$Value) $global:ev.Add('clip:' + $Value) }
function global:Start-Process { $global:ev.Add('spawn') }
$global:sec = New-Object System.Collections.Queue
$global:sec.Enqueue(${q(String.fromCharCode(0x200b) + TOKEN)})
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  if ($AsSecureString) { $global:ev.Add('read:secure'); return (ConvertTo-SecureString $global:sec.Dequeue() -AsPlainText -Force) }
  $global:ev.Add('read:' + $Prompt.Trim()); throw 'test: 不该再问负责人' }
$code = 0
try { & ${q(SCRIPT)} -Target ${target} -ApiBase 'http://127.0.0.1:${port}' }
catch { [Console]::Error.WriteLine($_.Exception.Message); $code = 1 }
finally { [IO.File]::WriteAllText(${q(events)}, (ConvertTo-Json -InputObject @($global:ev) -Compress), [Text.UTF8Encoding]::new($false)) }
exit $code`,
  );
  const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  await new Promise<void>((ok) => server.close(() => ok()));
  const ev = JSON.parse(readFileSync(events, 'utf8') || '[]') as string[];
  const credFile = join(credDir, `${CRED_TARGET}.json`);   // cred.ps1 测试分支：<目标>.json
  const cred = existsSync(credFile) ? (JSON.parse(readFileSync(credFile, 'utf8')) as { user: string; secret: string }) : null;
  return { code, out, err, reqs, secrets, ev, cred, base, value: secrets.get('BACKUP_PULL_TOKEN') ?? '' };
}

type Run = Awaited<ReturnType<typeof runScript>>;
function expectClean(r: Run) {
  expect(r.out).toContain(FINALLY);
  for (const s of [r.out, r.err]) {
    expect(s.includes(TOKEN) || s.includes('TEST_ONLY')).toBe(false);
    expect(s).not.toMatch(HEX32);
  }
  expect(r.ev.filter((e) => e.startsWith('clip:') && e !== 'clip: ')).toEqual([]);
  expect(r.ev.filter((e) => e === 'spawn' || (e.startsWith('read:') && e !== 'read:secure'))).toEqual([]);
}

describe.skipIf(!PS)('set-backup-pull-token.ps1', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lemo-pulltok-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('静态：解析无错、无中文引号、Invoke-RestMethod 带 -MaximumRedirection 0、Set-Clipboard 只清空；点引用 cred.ps1、safe-window.ps1', () => {
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
$cmds = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))
$web = @($cmds | Where-Object { @('Invoke-WebRequest', 'Invoke-RestMethod') -contains $_.GetCommandName() } | ForEach-Object { @{ line = $_.Extent.StartLineNumber; ok = ($_.Extent.Text -match '-MaximumRedirection\\s+0(\\s|$)') } })
$clip = @($cmds | Where-Object { $_.GetCommandName() -eq 'Set-Clipboard' } | ForEach-Object { $_.Extent.Text })
[Console]::Out.Write((@{ errors = @($e | ForEach-Object { $_.Message }); curly = $bad; web = $web; clip = $clip } | ConvertTo-Json -Depth 4 -Compress))`,
    );
    const r = JSON.parse(run(['-File', f]).stdout);
    expect(r.errors).toEqual([]);
    expect(r.curly, '字符串里出现了中文引号（所在行）').toEqual([]);
    const web = Array.isArray(r.web) ? r.web : [r.web];
    expect(web).toHaveLength(2);
    for (const w of web) expect(w.ok, `第 ${w.line} 行没带 -MaximumRedirection 0`).toBe(true);
    expect([r.clip].flat()).toEqual(["Set-Clipboard -Value ' '"]);
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain(". (Join-Path $PSScriptRoot 'cred.ps1')");
    expect(text).toMatch(/^\. \$SafeWindow$/m);
  }, 60_000);

  it('运行方式和参数：点源、& 调用被拒；没设 LEMO_TEST_API 时本机 -ApiBase 被拒；-Target 只认 preview、prod', () => {
    const env = { ...process.env };
    delete env.LEMO_TEST_API;
    const rs = [
      [run(['-Command', `. ${q(SCRIPT)} -Target prod`], env), '不要点源'],
      [run(['-Command', `& ${q(SCRIPT)} -Target prod`], env), '不要在已打开的窗口里用 & 调用'],
      [run(['-File', SCRIPT, '-Target', 'prod', '-ApiBase', 'http://127.0.0.1:9'], env), '只给测试用'],
      [run(['-File', SCRIPT, '-Target', 'prod', '-ApiBase', 'https://api.supabase.com.evil.io'], { ...env, LEMO_TEST_API: '1' }), ''],
      [run(['-File', SCRIPT, '-Target', 'production'], env), ''],
    ] as const;
    for (const [x, msg] of rs) {
      expect(x.status).not.toBe(0);
      expect(x.stdout + x.stderr).toContain(msg);
      expect(x.stdout).not.toContain('先检查');
    }
  }, 60_000);

  it('正式：本机生成 64 位十六进制，写成 BACKUP_PULL_TOKEN，同一个值写进 lemomemo.backup.pull；原有 secrets 不少；屏幕不显示值；给出 90 天后的轮换日期', async () => {
    const r = await runScript();
    expect([r.code, r.err]).toEqual([0, '']);
    expectClean(r);
    for (const x of r.reqs) expect(x.auth).toBe(`Bearer ${TOKEN}`);
    expect(r.reqs.map((x) => `${x.method} ${x.path.replace(r.base, '')}`)).toEqual(['GET ', 'GET /secrets', 'POST /secrets', 'GET /secrets']);
    expect(r.value).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r.reqs[2]?.body ?? '[]')).toEqual([{ name: 'BACKUP_PULL_TOKEN', value: r.value }]);
    expect([...r.secrets.keys()].sort()).toEqual(['BACKUP_PULL_TOKEN', 'GEMINI_API_KEY', 'OPS_SECRET']);
    expect(r.cred).toEqual({ user: 'lemomemo', secret: r.value, written: expect.any(String) });
    const next = new Date(Date.now() + 90 * 86_400_000);
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect([ymd(next), ymd(new Date(next.getTime() - 86_400_000)), ymd(new Date(next.getTime() + 86_400_000))].some((d) => r.out.includes(`下次轮换：${d}`))).toBe(true);
    expect(r.out).toContain('已写心跳 backup-pull');
    expect(r.ev).toEqual(['read:secure', 'clip: ', 'clip: ']);
  }, 120_000);

  it('预览：只写函数 secret，不写凭据管理器', async () => {
    const r = await runScript({ target: 'preview' });
    expect([r.code, r.err]).toEqual([0, '']);
    expectClean(r);
    expect(r.value).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cred).toBeNull();
    expect(r.out).toContain('不写凭据管理器');
  }, 120_000);

  it('写 secrets 返回 400 并回显请求正文：不打印值，红字提示重跑，不写凭据管理器', async () => {
    const r = await runScript({ failPost: true });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('HTTP 400');
    expect(r.err).toContain('不显示对方的说明');
    expect(r.err).toContain(RERUN);
    expect(r.cred).toBeNull();
  }, 60_000);

  it('项目名不对：核对完就停，不写 secrets、不写凭据管理器', async () => {
    const r = await runScript({ projName: 'lemomemo-preview' });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('不是 lemomemo-prod');
    expect(r.err).not.toContain(RERUN);
    expect(r.reqs.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${r.base}`]);
    expect(r.cred).toBeNull();
  }, 60_000);
});
