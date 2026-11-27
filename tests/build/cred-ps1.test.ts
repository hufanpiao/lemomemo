// tools/keys/cred.ps1：Windows 凭据管理器的读写全仓库只有这一份（B7a 复审“重复和简化”：原来 pull.ps1、set-r2-tokens.ps1、
// claude-intake/add.ps1 各抄一份 C# 封装）。不碰真凭据管理器：C# 只编译不调用；读写走 LEMO_TEST_CRED_DIR + LEMO_TEST_API=1 的测试分支。
// ① 用凭据的脚本都点引用它；② C# 封装编译得过（Add-Type）；③ 测试分支写了读得回（用户名、值、写入时刻）；
// ④ add.ps1 从头跑到尾：经 cred.ps1 读出连接码，只出现在发往本机假服务的 Authorization 头里，屏幕不显示。
// 起 PowerShell 子进程，登记在 vitest.config.ts 的 SLOW_NODE_TESTS；没有 PowerShell 时整组跳过
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, root, writePs } from './login-token-fake.ts';

const CRED = join(root, 'tools', 'keys', 'cred.ps1');
const ADD = join(root, 'tools', 'claude-intake', 'add.ps1');
const CODE = 'lmc_' + 'TESTONLYnotarealcode'.padEnd(43, 'z');
let dir = '';

const ps = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', env });

describe('用凭据的脚本都点引用 tools/keys/cred.ps1', () => {
  it('pull.ps1、restore-files.ps1、set-backup-pull-token.ps1、set-r2-tokens.ps1、claude-intake/add.ps1', () => {
    const uses: Record<string, RegExp> = {
      'tools/backup/pull.ps1': /\. \(Join-Path \$PSScriptRoot '\.\.\\keys\\cred\.ps1'\)/,
      'tools/backup/restore-files.ps1': /\. \(Join-Path \$PSScriptRoot '\.\.\\keys\\cred\.ps1'\)/,
      'tools/claude-intake/add.ps1': /\. \(Join-Path \$PSScriptRoot '\.\.\\keys\\cred\.ps1'\)/,
      'tools/keys/set-r2-tokens.ps1': /Join-Path \$PSScriptRoot 'cred\.ps1'/,
      'tools/keys/set-backup-pull-token.ps1': /cred\.ps1/,
    };
    for (const [f, re] of Object.entries(uses)) expect(readFileSync(join(root, f), 'utf8'), f).toMatch(re);
  });
});

describe.skipIf(!PS)('cred.ps1 本身', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lemo-cred-ps1-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('C# 封装编译得过（只 Add-Type，不读写真凭据管理器）', () => {
    const f = writePs(dir, 'compile.ps1', `$ErrorActionPreference = 'Stop'\n. ${q(CRED)}\nInitialize-LemoCred\n[Console]::Out.Write([bool]('LemoCredStore' -as [type]))\n`);
    const r = ps(f, [], process.env);
    expect([r.status, r.stderr, r.stdout]).toEqual([0, '', 'True']);
  }, 60_000);

  it('测试分支：Write-LemoCred 写进 <目标>.json，Read-LemoCred 读回用户名、值和 UTC 写入时刻；没有这一条回 $null；目标名不对就停', () => {
    const credDir = mkdtempSync(join(dir, 'c-'));
    const f = writePs(dir, 'rw.ps1', `$ErrorActionPreference = 'Stop'\n. ${q(CRED)}
Write-LemoCred 'lemomemo.test.one' 'u1' 's1'
$c = Read-LemoCred 'lemomemo.test.one'
$none = Read-LemoCred 'lemomemo.test.none'
$bad = try { Read-LemoCred 'Bad Name'; 'no' } catch { 'threw' }
[Console]::Out.Write((@{ user = $c.User; secret = $c.Secret; utc = [string]$c.LastWritten.Kind; age = ([datetime]::UtcNow - $c.LastWritten).TotalSeconds; none = ($null -eq $none); bad = $bad } | ConvertTo-Json -Compress))\n`);
    const r = ps(f, [], { ...process.env, LEMO_TEST_API: '1', LEMO_TEST_CRED_DIR: credDir });
    expect([r.status, r.stderr]).toEqual([0, '']);
    const o = JSON.parse(r.stdout) as { user: string; secret: string; utc: string; age: number; none: boolean; bad: string };
    expect([o.user, o.secret, o.utc, o.none, o.bad]).toEqual(['u1', 's1', 'Utc', true, 'threw']);
    expect(o.age).toBeGreaterThanOrEqual(0);
    expect(o.age).toBeLessThan(120);
    expect(JSON.parse(readFileSync(join(credDir, 'lemomemo.test.one.json'), 'utf8'))).toMatchObject({ user: 'u1', secret: 's1' });
  }, 60_000);
});

describe.skipIf(!PS)('claude-intake/add.ps1 经 cred.ps1 读连接码', () => {
  let server: Server | null = null;
  let port = 0;
  const seen: { auth: string; body: string }[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-cred-add-'));
    // add.ps1 的自测地址只认 127.0.0.1:8840～8849：挑一个空的
    for (let p = 8840; p <= 8849 && !server; p++) {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => (body += c));
        req.on('end', () => { seen.push({ auth: String(req.headers.authorization ?? ''), body }); res.writeHead(200, { 'content-type': 'application/json' }).end('{"created":1}'); });
      });
      const ok = await new Promise<boolean>((done) => { s.once('error', () => done(false)); s.listen(p, '127.0.0.1', () => done(true)); });
      if (ok) { server = s; port = p; }
    }
  });
  afterAll(async () => {
    if (server) await new Promise<void>((ok) => server?.close(() => ok()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('凭据里有连接码：发出去的 Authorization 是 Bearer <码>，屏幕只有服务器回的 JSON；凭据里没有：退出码 1、不发请求', async () => {
    expect(port).toBeGreaterThan(0);
    const credDir = mkdtempSync(join(dir, 'c-'));
    const env = { ...process.env, LEMO_TEST_API: '1', LEMO_TEST_CRED_DIR: credDir, LEMO_INTAKE_TEST_ENDPOINT: `http://127.0.0.1:${port}/functions/v1/claude-intake` };
    const none = await runAsync(['-Text', '买牛奶'], env);
    expect(none.code).toBe(1);
    expect(none.err).toContain('凭据管理器里没有可用的连接码');
    expect(seen).toEqual([]);
    writeFileSync(join(credDir, 'lemomemo.claude.intake.test.json'), JSON.stringify({ user: 'lemomemo', secret: CODE, written: new Date().toISOString() }));
    const r = await runAsync(['-Text', '买牛奶'], env);
    expect([r.code, r.err, r.out.trim()]).toEqual([0, '', '{"created":1}']);
    expect(seen).toEqual([{ auth: `Bearer ${CODE}`, body: '{"text":"买牛奶"}' }]);
  }, 60_000);
});

/** 假服务和子进程在同一个 node 进程里，要异步起子进程 */
function runAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  // 外壳只把输出编码设成 UTF-8（中文报错才读得对），再原样调 add.ps1
  const wrap = writePs(dir, 'wrap-add.ps1', `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$OutputEncoding = [Text.Encoding]::UTF8\n& ${q(ADD)} @args\nexit $LASTEXITCODE\n`);
  const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrap, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
  return new Promise((ok) => child.on('close', (code) => ok({ code, out, err })));
}
