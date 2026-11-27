// tools/keys/set-signup-secrets.ps1 的测试（不连真实的 Supabase、不用任何真实令牌和密钥；明早清单第 24 条、验收清单 D3）：
// ① 静态：PowerShell 解析无错；字符串里没有中文引号；每个 Invoke-RestMethod 都带 -MaximumRedirection 0；Set-Clipboard 只清空；
//    finally 里清变量、清剪贴板、$Error.Clear()；点源、& 调用、-ApiBase、-Target、-Rotate 的反面用例
// ② 从头跑到尾：外壳屏蔽 Read-Host（从队列取值）、注册表检查，把 Set-Clipboard、Start-Process 换成「记下来」，-ApiBase 指向本机假服务
//    （另设 LEMO_TEST_API=1）。核对：只写缺的、-Rotate 点名的才换、SIGNUP_HASH_SECRET 是本机生成的 64 位小写十六进制、
//    粘贴的值原样写入、原有 secrets 不少、屏幕不显示值和令牌；格式粗检（re_、0x4、测试密钥 1x/2x/3x 拒收）；写 secrets 出错不打印响应体
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, root, writePs } from './login-token-fake.ts';

const SCRIPT = join(root, 'tools', 'keys', 'set-signup-secrets.ps1');
const REF = 'yoeqwhygehbaftkppati';
const BASE = `/v1/projects/${REF}`;
const TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_token_'.padEnd(40, 'z');
const RESEND = 're_TESTONLY_fake_resend_key_123';
const TURNSTILE = '0x4AAAAAAA_TESTONLY-fake-turnstile';
const FINALLY = '已清剪贴板、清掉内存里的变量';
const HEX32 = /[0-9a-fA-F]{32,}/;
const ZW = String.fromCharCode(0x200b);
const NAMES = ['RESEND_API_KEY', 'TURNSTILE_SECRET', 'SIGNUP_HASH_SECRET'];

let dir = '';
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env });

type Req = { method: string; path: string; auth: string; body: string };
type Opts = { projName?: string; have?: string[]; rotate?: string; paste?: string[]; failPost?: boolean; dropOnPost?: boolean };

async function runScript(opts: Opts = {}) {
  const reqs: Req[] = [];
  const secrets = new Map<string, string>([['GEMINI_API_KEY', 'x'], ['OPS_SECRET', 'y'], ...(opts.have ?? []).map((n) => [n, `old-${n}`] as [string, string])]);
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
      if (req.method === 'GET' && path === BASE) return send(res, 200, { ref: REF, name: opts.projName ?? 'lemomemo-preview', region: 'ap-northeast-2' });
      // 列表响应里带着值的摘要：脚本只能取 name
      if (req.method === 'GET' && path === `${BASE}/secrets`) return send(res, 200, [...secrets.entries()].map(([name, v]) => ({ name, value: `digest-${v.length}` })));
      if (req.method === 'POST' && path === `${BASE}/secrets`) {
        if (opts.failPost) return send(res, 400, `{"message":"bad request: ${body.replace(/"/g, '\\"')}"}`);
        if (!opts.dropOnPost) for (const s of JSON.parse(body) as { name: string; value: string }[]) secrets.set(s.name, s.value);
        return send(res, 201, undefined);
      }
      return send(res, 404, { message: 'not found' });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const events = join(dir, `events-${port}.json`);
  const values = [ZW + TOKEN, ...(opts.paste ?? [])];
  const rotate = opts.rotate ? ` -Rotate ${q(opts.rotate)}` : '';
  const harness = writePs(
    dir,
    `run-${port}.ps1`,
    `$ErrorActionPreference = 'Stop'
$env:LEMO_TEST_API = '1'
function global:Get-ItemProperty { $null }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
$global:ev = New-Object System.Collections.Generic.List[string]
function global:Set-Clipboard { param([string]$Value) $global:ev.Add('clip:' + $Value) }
function global:Start-Process { $global:ev.Add('spawn') }
$global:sec = New-Object System.Collections.Queue
${values.map((t) => `$global:sec.Enqueue(${q(t)})`).join('\n')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  if ($AsSecureString) {
    $global:ev.Add('read:secure')
    if ($global:sec.Count -eq 0) { throw 'test: 队列空了，不该再问' }
    return (ConvertTo-SecureString $global:sec.Dequeue() -AsPlainText -Force) }
  $global:ev.Add('read:' + $Prompt.Trim()); throw 'test: 不该再问负责人' }
$code = 0
try { & ${q(SCRIPT)} -Target preview${rotate} -ApiBase 'http://127.0.0.1:${port}' }
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
  const posts = reqs.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body) as { name: string; value: string }[]);
  return { code, out, err, reqs, secrets, ev, posts };
}

type Run = Awaited<ReturnType<typeof runScript>>;
function expectClean(r: Run) {
  expect(r.out).toContain(FINALLY);
  for (const s of [r.out, r.err]) {
    for (const v of [TOKEN, 'TEST_ONLY', 'TESTONLY', r.secrets.get('SIGNUP_HASH_SECRET') ?? 'n/a']) expect(s.includes(v), v).toBe(false);
    expect(s).not.toMatch(HEX32);
  }
  // 不往剪贴板放东西、不起别的进程、不问明文输入
  expect(r.ev.filter((e) => e.startsWith('clip:') && e !== 'clip: ')).toEqual([]);
  expect(r.ev.filter((e) => e === 'spawn' || (e.startsWith('read:') && e !== 'read:secure'))).toEqual([]);
}
const paths = (r: Run) => r.reqs.map((x) => `${x.method} ${x.path.replace(BASE, '')}`);

describe.skipIf(!PS)('set-signup-secrets.ps1', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-signup-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('静态：解析无错、无中文引号、Invoke-RestMethod 带 -MaximumRedirection 0、Set-Clipboard 只清空、主流程的 finally 清变量和 $Error', () => {
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
$tries = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.TryStatementAst] -and $n.Body.Extent.Text.Contains('New-HashSecret') }, $true))
$fin = if ($tries.Count -eq 1 -and $tries[0].Finally) { $tries[0].Finally.Extent.Text } else { '' }
[Console]::Out.Write((@{ errors = @($e | ForEach-Object { $_.Message }); curly = $bad; web = $web; clip = $clip; fin = @($fin.Contains('Clear-Clip'), $fin.Contains('$Error.Clear()'), $fin.Contains('$resendKey = $null'), $fin.Contains('$turnstileKey = $null'), $fin.Contains('$hashKey = $null'), $fin.Contains('$sbTok = $null')) } | ConvertTo-Json -Depth 4 -Compress))`,
    );
    const r = JSON.parse(run(['-File', f]).stdout);
    expect(r.errors).toEqual([]);
    expect(r.curly, '字符串里出现了中文引号（所在行）').toEqual([]);
    const web = Array.isArray(r.web) ? r.web : [r.web];
    expect(web).toHaveLength(2);
    for (const w of web) expect(w.ok, `第 ${w.line} 行没带 -MaximumRedirection 0`).toBe(true);
    expect([r.clip].flat()).toEqual(["Set-Clipboard -Value ' '"]);
    expect(r.fin).toEqual([true, true, true, true, true, true]);
    // 用 Management API、不用 supabase CLI；SIGNUP_HASH_SECRET 用 RandomNumberGenerator 生成 32 字节
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).not.toMatch(/^\s*(&\s*)?supabase(\.exe)?\s/m);
    expect(text).toContain('[Security.Cryptography.RandomNumberGenerator]::Create()');
    expect(text).toContain('New-Object byte[] 32');
  }, 60_000);

  it('运行方式和参数：点源、& 调用被拒；没设 LEMO_TEST_API 时本机 -ApiBase 被拒；-Target、-Rotate 只认规定的写法', () => {
    const env = { ...process.env };
    delete env.LEMO_TEST_API;
    const rs = [
      [run(['-Command', `. ${q(SCRIPT)} -Target preview`], env), '不要点源'],
      [run(['-Command', `& ${q(SCRIPT)} -Target preview`], env), '不要在已打开的窗口里用 & 调用'],
      [run(['-File', SCRIPT, '-Target', 'preview', '-ApiBase', 'http://127.0.0.1:9'], env), '只给测试用'],
      [run(['-File', SCRIPT, '-Target', 'preview', '-ApiBase', 'https://api.supabase.com.evil.io'], { ...env, LEMO_TEST_API: '1' }), ''],
      [run(['-File', SCRIPT, '-Target', 'production'], env), ''],
      ...['PROXY_SECRET', 'RESEND_API_KEY,', 'resend_api_key', 'ALL', 'RESEND_API_KEY TURNSTILE_SECRET'].map((v) => [run(['-File', SCRIPT, '-Target', 'preview', '-Rotate', v], env), ''] as const),
    ] as const;
    for (const [x, msg] of rs) {
      expect(x.status).not.toBe(0);
      expect(x.stdout + x.stderr).toContain(msg);
      expect(x.stdout).not.toContain('先检查');
    }
  }, 60_000);

  it('三个都没有：粘贴两个、本机生成一个，一次写入；原有 secrets 不少；屏幕不显示值', async () => {
    const r = await runScript({ paste: [ZW + RESEND + ' ', TURNSTILE] });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expectClean(r);
    for (const x of r.reqs) expect(x.auth).toBe(`Bearer ${TOKEN}`);
    expect(paths(r)).toEqual(['GET ', 'GET /secrets', 'POST /secrets', 'GET /secrets']);
    expect(r.posts[0]?.map((s) => s.name)).toEqual(NAMES);
    expect(r.secrets.get('RESEND_API_KEY')).toBe(RESEND);
    expect(r.secrets.get('TURNSTILE_SECRET')).toBe(TURNSTILE);
    expect(r.secrets.get('SIGNUP_HASH_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect([...r.secrets.keys()].sort()).toEqual(['GEMINI_API_KEY', 'OPS_SECRET', ...NAMES].sort());
    expect(r.ev).toEqual(['read:secure', 'clip: ', 'read:secure', 'clip: ', 'read:secure', 'clip: ', 'clip: ']);
    expect(r.out).toContain('三个名字都在，原有的 2 个 secrets 都在');
    expect(r.out).toContain('全部写好');
  }, 60_000);

  it('两次运行生成的 SIGNUP_HASH_SECRET 不一样', async () => {
    const a = await runScript({ have: ['RESEND_API_KEY', 'TURNSTILE_SECRET'] });
    const b = await runScript({ have: ['RESEND_API_KEY', 'TURNSTILE_SECRET'] });
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.posts[0]?.map((s) => s.name)).toEqual(['SIGNUP_HASH_SECRET']);
    expect(a.secrets.get('SIGNUP_HASH_SECRET')).not.toBe(b.secrets.get('SIGNUP_HASH_SECRET'));
    expect(a.ev).toEqual(['read:secure', 'clip: ', 'clip: ']);   // 只问了令牌
  }, 60_000);

  it('三个都已有、没带 -Rotate：什么都不写，也不问密钥', async () => {
    const r = await runScript({ have: NAMES });
    expect(r.code).toBe(0);
    expectClean(r);
    expect(paths(r)).toEqual(['GET ', 'GET /secrets']);
    expect(r.out).toContain('三个都已经有了，这次什么都没写');
    for (const n of NAMES) expect(r.secrets.get(n)).toBe(`old-${n}`);
  }, 60_000);

  it('已有的不覆盖：只缺 TURNSTILE_SECRET 时只问它、只写它', async () => {
    const r = await runScript({ have: ['RESEND_API_KEY', 'SIGNUP_HASH_SECRET'], paste: [TURNSTILE] });
    expect(r.code).toBe(0);
    expectClean(r);
    expect(r.posts).toEqual([[{ name: 'TURNSTILE_SECRET', value: TURNSTILE }]]);
    expect(r.secrets.get('RESEND_API_KEY')).toBe('old-RESEND_API_KEY');
    expect(r.secrets.get('SIGNUP_HASH_SECRET')).toBe('old-SIGNUP_HASH_SECRET');
    expect(r.out).toContain('已有，不覆盖（要换的话加 -Rotate RESEND_API_KEY）');
  }, 60_000);

  it('-Rotate 点名的才换：-Rotate RESEND_API_KEY,SIGNUP_HASH_SECRET；-Rotate all 三个都换', async () => {
    const r = await runScript({ have: NAMES, rotate: 'RESEND_API_KEY,SIGNUP_HASH_SECRET', paste: [RESEND] });
    expect(r.code).toBe(0);
    expectClean(r);
    expect(r.posts[0]?.map((s) => s.name)).toEqual(['RESEND_API_KEY', 'SIGNUP_HASH_SECRET']);
    expect(r.secrets.get('RESEND_API_KEY')).toBe(RESEND);
    expect(r.secrets.get('TURNSTILE_SECRET')).toBe('old-TURNSTILE_SECRET');
    expect(r.secrets.get('SIGNUP_HASH_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    const all = await runScript({ have: NAMES, rotate: 'all', paste: [RESEND, TURNSTILE] });
    expect(all.code).toBe(0);
    expect(all.posts[0]?.map((s) => s.name)).toEqual(NAMES);
  }, 60_000);

  it('Turnstile 测试密钥（1x/2x/3x）和 Site Key 样子的值（0x4 开头、约 24 个字符）被拒，连错 3 次停下，不写', async () => {
    const r = await runScript({ have: ['RESEND_API_KEY', 'SIGNUP_HASH_SECRET'], paste: ['1x0000000000000000000000000000000AA', '2x0000000000000000000000000000000AA', '0x4AAAAAAAABcdEfGhIjKlMn'] });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.out).toContain('这是 Cloudflare 的测试密钥');
    expect(r.out).toContain('收到 24 个字符，以 0x4 开头');
    expect(r.err).toContain('Turnstile Secret Key 连续 3 次格式不对');
    expect(r.reqs.some((x) => x.method === 'POST')).toBe(false);
  }, 60_000);

  it('Resend 密钥格式不对（不是 re_ 开头、太短）连错 3 次停下，只报长度和开头', async () => {
    const r = await runScript({ paste: ['not-a-resend-key-abcdefghijklmn', 're_short', 'RE_ABCDEFGHIJKLMNOPQRSTUV'] });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.out).toContain('不是以 re_ 开头');
    expect(r.out).toContain('收到 8 个字符，以 re_ 开头');
    expect(r.err).toContain('Resend API 密钥 连续 3 次格式不对');
    expect(r.reqs.some((x) => x.method === 'POST')).toBe(false);
  }, 60_000);

  it('写 secrets 返回 400 并回显请求正文：不打印值；写后名字不在：报出缺哪个', async () => {
    const r = await runScript({ failPost: true, paste: [RESEND, TURNSTILE] });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('HTTP 400');
    expect(r.err).toContain('不显示对方的说明');
    const d = await runScript({ dropOnPost: true, have: ['RESEND_API_KEY', 'TURNSTILE_SECRET'] });
    expect(d.code).toBe(1);
    expectClean(d);
    expect(d.err).toContain('写入后 Supabase 上还是没有：SIGNUP_HASH_SECRET');
  }, 60_000);

  it('项目名不对：核对完就停，不问密钥、不写', async () => {
    const r = await runScript({ projName: 'lemomemo-prod', paste: [RESEND, TURNSTILE] });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('不是 lemomemo-preview');
    expect(r.reqs.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${BASE}`]);
    expect(r.ev.filter((e) => e === 'read:secure')).toHaveLength(1);
  }, 60_000);
});
