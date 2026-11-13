// tools/keys/gen-vault-keys.ps1 和 check-vault-keys-leak.ps1 的测试（B5 任务单 S19；TC-B5-15 的脚本一半）。
// 不连真实的 Supabase、不用任何真实令牌和钥匙：外壳屏蔽 Read-Host（从队列取值）、注册表检查、Clear-Host，
// 把 Write-Host 记下来（“只显示一次”的值要能被复制回来核对），-ApiBase 指向本机假服务（另设 LEMO_TEST_API=1）。
// 泄漏检查在临时目录里放一把假钥匙（只用于测试），USERPROFILE、APPDATA 指到临时目录，-CiRuns 0。
// 需要 Windows PowerShell（Windows 上）或 pwsh；都没有就整组跳过
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, root, writePs } from './login-token-fake.ts';

const GEN = join(root, 'tools', 'keys', 'gen-vault-keys.ps1');
const LEAK = join(root, 'tools', 'keys', 'check-vault-keys-leak.ps1');
const REF = 'yoeqwhygehbaftkppati';
const BASE = `/v1/projects/${REF}`;
const TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_token_'.padEnd(40, 'z');
const ECHO = '<<复制回刚显示的值>>';
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
// 测试专用假钥匙（32 字节的 base64），只用于测试
const FAKE_KEY = Buffer.from('TEST-ONLY-fake-vault-key-32-byte').toString('base64');
const FAKE_PEPPER = Buffer.from('TEST-ONLY-fake-pin-pepper-32-byt').toString('base64');

let dir = '';

type Opts = { have?: string[]; rotate?: boolean; paste?: string[]; script?: string; args?: string; env?: Record<string, string> };

async function runPs(opts: Opts, port: number | null) {
  const events = join(dir, `events-${port ?? Math.random().toString(16).slice(2)}.json`);
  const values = opts.paste ?? [];
  const api = port === null ? '' : ` -Target preview -ApiBase 'http://127.0.0.1:${port}'${opts.rotate ? ' -RotateTokenSecret' : ''}`;
  const harness = writePs(dir, `run-${Math.random().toString(16).slice(2)}.ps1`, `$ErrorActionPreference = 'Stop'
$env:LEMO_TEST_API = '1'
${Object.entries(opts.env ?? {}).map(([k, v]) => `$env:${k} = ${q(v)}`).join('\n')}
function global:Get-ItemProperty { $null }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
function global:Clear-Host { $global:ev.Add('cls') }
$global:ev = New-Object System.Collections.Generic.List[string]
$global:shown = ''
function global:Write-Host { param([Parameter(Position = 0)]$Object, $ForegroundColor)
  $s = [string]$Object
  if ($ForegroundColor -eq 'Yellow' -and $s -match '\\A\\s+\\S+\\z') { $global:shown = $s.Trim(); $global:ev.Add('shown') }
  [Console]::Out.WriteLine($s) }
function global:Set-Clipboard { param([string]$Value) $global:ev.Add('clip:' + $Value) }
$global:sec = New-Object System.Collections.Queue
${values.map((t) => `$global:sec.Enqueue(${q(t)})`).join('\n')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  if ($AsSecureString) {
    $global:ev.Add('read:secure')
    if ($global:sec.Count -eq 0) { throw 'test: 队列空了，不该再问' }
    $v = $global:sec.Dequeue(); if ($v -eq ${q(ECHO)}) { $v = $global:shown }
    return (ConvertTo-SecureString $v -AsPlainText -Force) }
  $global:ev.Add('enter'); return '' }
$code = 0
try { & ${q(opts.script ?? GEN)}${api}${opts.args ?? ''} }
catch { [Console]::Error.WriteLine($_.Exception.Message); $code = 1 }
finally { [IO.File]::WriteAllText(${q(events)}, (ConvertTo-Json -InputObject @($global:ev) -Compress), [Text.UTF8Encoding]::new($false)) }
exit $code`);
  const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  const ev = JSON.parse(readFileSync(events, 'utf8') || '[]') as string[];
  return { code, out, err, ev };
}

async function runGen(opts: Opts = {}) {
  const posts: { name: string; value: string }[][] = [];
  const secrets = new Map<string, string>([['GEMINI_API_KEY', 'x'], ...(opts.have ?? []).map((n) => [n, `old-${n}`] as [string, string])]);
  const send = (res: ServerResponse, code: number, obj: unknown) => {
    const text = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' });
    res.end(text);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      const path = req.url ?? '';
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Unauthorized' });
      if (req.method === 'GET' && path === BASE) return send(res, 200, { ref: REF, name: 'lemomemo-preview', region: 'ap-northeast-2' });
      if (req.method === 'GET' && path === `${BASE}/secrets`) return send(res, 200, [...secrets.keys()].map((name) => ({ name, value: 'digest' })));
      if (req.method === 'POST' && path === `${BASE}/secrets`) {
        const items = JSON.parse(body) as { name: string; value: string }[];
        posts.push(items);
        for (const s of items) secrets.set(s.name, s.value);
        return send(res, 201, undefined);
      }
      return send(res, 404, { message: 'not found' });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const r = await runPs({ ...opts, paste: [TOKEN, ...(opts.paste ?? [])] }, port);
  await new Promise<void>((ok) => server.close(() => ok()));
  return { ...r, posts, secrets };
}

describe.skipIf(!PS)('gen-vault-keys.ps1', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lemo-vaultkeys-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('第一次：三把都生成并写入；两把各显示一次、复制回来核对后才写；VAULT_TOKEN_SECRET 不显示；令牌不出现在屏幕上', async () => {
    const r = await runGen({ paste: [ECHO, ECHO] });
    expect(r.code, r.err).toBe(0);
    expect(r.posts).toHaveLength(1);
    const w = Object.fromEntries((r.posts[0] ?? []).map((s) => [s.name, s.value]));
    expect(Object.keys(w).sort()).toEqual(['VAULT_KEY', 'VAULT_PIN_PEPPER', 'VAULT_TOKEN_SECRET']);
    for (const v of Object.values(w)) expect(v).toMatch(KEY_RE);
    expect(new Set(Object.values(w)).size).toBe(3);
    expect(r.ev.filter((e) => e === 'shown')).toHaveLength(2);
    expect(r.out).toContain(w.VAULT_KEY);
    expect(r.out).toContain(w.VAULT_PIN_PEPPER);
    expect(r.out.includes(w.VAULT_TOKEN_SECRET ?? 'n/a')).toBe(false);
    expect(r.out + r.err).not.toContain('TEST_ONLY');
    // 每把显示之后都清屏；不往剪贴板放东西
    expect(r.ev.filter((e) => e === 'cls').length).toBeGreaterThanOrEqual(3);
    expect(r.ev.filter((e) => e.startsWith('clip:') && e !== 'clip: ')).toEqual([]);
    expect(r.out).toContain('已清剪贴板、清掉内存里的变量');
  });

  it('复制回来的对不上（3 次）：什么都不写', async () => {
    const r = await runGen({ paste: [FAKE_KEY, FAKE_KEY, FAKE_KEY] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('连续 3 次对不上');
    expect(r.posts).toEqual([]);
  });

  it('VAULT_KEY、VAULT_PIN_PEPPER 已经有了：不换、不显示；只缺令牌密钥时只写它', async () => {
    const r = await runGen({ have: ['VAULT_KEY', 'VAULT_PIN_PEPPER'] });
    expect(r.code, r.err).toBe(0);
    expect(r.posts.map((p) => p.map((s) => s.name))).toEqual([['VAULT_TOKEN_SECRET']]);
    expect(r.ev).not.toContain('shown');
    expect(r.secrets.get('VAULT_KEY')).toBe('old-VAULT_KEY');
  });

  it('三把都在：什么都不写；-RotateTokenSecret 只换令牌密钥', async () => {
    const all = ['VAULT_KEY', 'VAULT_PIN_PEPPER', 'VAULT_TOKEN_SECRET'];
    const a = await runGen({ have: all });
    expect(a.code, a.err).toBe(0);
    expect(a.posts).toEqual([]);
    expect(a.out).toContain('三把都已经有了');
    const b = await runGen({ have: all, rotate: true });
    expect(b.code, b.err).toBe(0);
    expect(b.posts.map((p) => p.map((s) => s.name))).toEqual([['VAULT_TOKEN_SECRET']]);
    expect(b.secrets.get('VAULT_PIN_PEPPER')).toBe('old-VAULT_PIN_PEPPER');
  });

  it('只有一把主钥匙在：不正常，停下不写', async () => {
    const r = await runGen({ have: ['VAULT_KEY'] });
    expect(r.code).toBe(1);
    expect(r.posts).toEqual([]);
  });
});

describe.skipIf(!PS)('check-vault-keys-leak.ps1', () => {
  let home = '';
  let repo = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-vaultkeys-'));
    home = mkdtempSync(join(tmpdir(), 'lemo-leak-home-'));
    repo = join(home, 'repo');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 'clean.jsonl'), '{"text":"没有钥匙"}\n');
  });
  afterAll(() => { for (const d of [home, dir]) if (d) rmSync(d, { recursive: true, force: true }); });
  const leak = () => runPs({
    script: LEAK, args: ` -RepoRoot ${q(repo)} -CiRuns 0`, paste: [FAKE_KEY, FAKE_PEPPER],
    env: { USERPROFILE: home, APPDATA: join(home, 'AppData') },
  }, null);

  it('都干净：全部没找到；屏幕上不出现钥匙', async () => {
    const r = await leak();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('结果：全部没找到');
    expect(r.out + r.err).not.toContain(FAKE_KEY);
  });

  it('会话记录里有原样和 UTF-16 写法、仓库里有十六进制写法：各报找到，不显示文件名', async () => {
    writeFileSync(join(home, '.claude', 'projects', 'leaky-name.jsonl'), `{"text":"${FAKE_KEY}"}\n`);
    writeFileSync(join(repo, 'docs', 'hex-copy.txt'), Buffer.from(FAKE_PEPPER, 'base64').toString('hex'));
    writeFileSync(join(home, '.claude', 'utf16-log.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`x ${FAKE_PEPPER} y`, 'utf16le')]));
    const r = await leak();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/①[^\n]*找到 2 处/);
    expect(r.out).toMatch(/仓库工作区[^\n]*找到 1 处/);
    expect(r.out).toContain('结果：一共找到 3 处');
    for (const s of ['leaky-name', 'hex-copy', 'utf16-log', FAKE_KEY]) expect(r.out + r.err).not.toContain(s);
  });
});
