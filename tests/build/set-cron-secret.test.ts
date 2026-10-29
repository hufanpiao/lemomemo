// tools/keys/set-cron-secret.ps1 的测试（不连真实的 Supabase、不用任何真实令牌；架构 0.38 第 46 条，R-228 方案 A：值在数据库里生成）：
// ① 静态：PowerShell 解析无错；字符串里没有中文引号；每个 Invoke-RestMethod 都带 -MaximumRedirection 0；-ApiBase、-Target 的反面用例；
//    点源、& 调用被拒（只许 -File）；Ctrl+C 会走的 finally 里有 Clear-Clip、$Error.Clear()；剪贴板只会被清空，脚本不往里放东西
// ② 从头跑到尾：外壳屏蔽 Read-Host（从队列取值）、注册表检查，把 Set-Clipboard、Start-Process 换成「记下来」，-ApiBase 指向本机假服务（另设 LEMO_TEST_API=1）。
//    假服务的 database/query：do 块在「库里」生成 64 位十六进制值写进 Vault，select 读回。核对：SQL 文本里没有值也没有 32 位以上的十六进制串、
//    读回的值原样写成 CRON_SECRET、原有 secrets 不少、屏幕不显示值和令牌；出错时（读回、写 secrets 回显明文）不打印响应体、提示重跑
// ③ 本机 Supabase 开着（容器 supabase_db_lemomemo）时，把脚本发出的两段 SQL 在事务里真跑，最后回滚
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, root, writePs } from './login-token-fake.ts';

const SCRIPT = join(root, 'tools', 'keys', 'set-cron-secret.ps1');
const REF = 'yoeqwhygehbaftkppati';
const BASE = `/v1/projects/${REF}`;
const FN_URL = `https://${REF}.supabase.co/functions/v1`;
const TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_token_'.padEnd(40, 'z');
const FINALLY = '已清剪贴板、清掉内存里的变量';
const RERUN = '数据库 Vault 的 cron_secret 已换、函数侧的 CRON_SECRET 还没换好';
const HEX32 = /[0-9a-fA-F]{32,}/;
const DB = 'supabase_db_lemomemo';
const dbUp = spawnSync('docker', ['exec', DB, 'pg_isready', '-q'], { encoding: 'utf8' }).status === 0;

let dir = '';
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env });

type Req = { method: string; path: string; auth: string; body: string };
type Opts = { projName?: string; failWrite?: boolean; failRead?: boolean; badRead?: boolean; failPost?: boolean; token?: string[] };

async function runScript(opts: Opts = {}) {
  const reqs: Req[] = [];
  const secrets = new Map<string, string>([['GEMINI_API_KEY', 'x'], ['OPS_SECRET', 'y']]);
  const vault = new Map<string, string>();
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
      if (req.method === 'POST' && path === `${BASE}/database/query`) {
        const sql = String((JSON.parse(body) as { query: string }).query);
        if (sql.includes('do $lemo$')) {
          if (opts.failWrite) return send(res, 400, { message: 'Failed to run sql query: ERROR:  schema "vault" does not exist' });
          // 「库里」生成值：和 encode(gen_random_bytes(32), 'hex') 一样是 64 位十六进制
          vault.set('cron_secret', randomBytes(32).toString('hex'));
          vault.set('functions_url', /create_secret\('(https:[^']+)', 'functions_url'\)/.exec(sql)?.[1] ?? '');
          return send(res, 201, []);
        }
        if (sql.startsWith('select name, decrypted_secret')) {
          // 出错时对方把明文原样带回来：脚本不能打印
          if (opts.failRead) return send(res, 500, { message: `internal error near ${vault.get('cron_secret') ?? ''}` });
          const rows = [...vault.entries()].map(([name, v]) => ({ name, decrypted_secret: opts.badRead && name === 'cron_secret' ? v.toUpperCase() : v, n: 1 }));
          return send(res, 201, rows);
        }
        return send(res, 400, { message: 'unexpected sql' });
      }
      if (req.method === 'GET' && path === `${BASE}/secrets`) return send(res, 200, [...secrets.keys()].map((name) => ({ name, value: 'digest' })));
      if (req.method === 'POST' && path === `${BASE}/secrets`) {
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
  const tokens = opts.token ?? [String.fromCharCode(0x200b) + TOKEN];
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
${tokens.map((t) => `$global:sec.Enqueue(${q(t)})`).join('\n')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  if ($AsSecureString) { $global:ev.Add('read:secure'); return (ConvertTo-SecureString $global:sec.Dequeue() -AsPlainText -Force) }
  $global:ev.Add('read:' + $Prompt.Trim()); throw 'test: 不该再问负责人' }
$code = 0
try { & ${q(SCRIPT)} -Target preview -ApiBase 'http://127.0.0.1:${port}' }
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
  const sqls = reqs.filter((r) => r.path === `${BASE}/database/query`).map((r) => String((JSON.parse(r.body) as { query: string }).query));
  return { code, out, err, reqs, secrets, ev, sqls, value: vault.get('cron_secret') ?? '' };
}

type Run = Awaited<ReturnType<typeof runScript>>;
function expectClean(r: Run) {
  expect(r.out).toContain(FINALLY);
  for (const s of [r.out, r.err]) {
    expect(s.includes(TOKEN) || s.includes('TEST_ONLY')).toBe(false);
    if (r.value) expect(s.toLowerCase().includes(r.value)).toBe(false);
    expect(s).not.toMatch(HEX32);
  }
  // SQL 文本里没有值：没有 32 位以上的十六进制串
  for (const s of r.sqls) expect(s).not.toMatch(HEX32);
  // 不往剪贴板放东西、不起别的进程、不再问负责人
  expect(r.ev.filter((e) => e.startsWith('clip:') && e !== 'clip: ')).toEqual([]);
  expect(r.ev.filter((e) => e === 'spawn' || (e.startsWith('read:') && e !== 'read:secure'))).toEqual([]);
}

describe.skipIf(!PS)('set-cron-secret.ps1', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-cron-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('静态：解析无错、无中文引号、Invoke-RestMethod 带 -MaximumRedirection 0、Set-Clipboard 只清空、读回那段的 finally 清变量和 $Error', () => {
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
$tries = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.TryStatementAst] -and $n.Body.Extent.Text.Contains('$ReadSql -NoDetail') }, $true))
$fin = if ($tries.Count -eq 1 -and $tries[0].Finally) { $tries[0].Finally.Extent.Text } else { '' }
[Console]::Out.Write((@{ errors = @($e | ForEach-Object { $_.Message }); curly = $bad; web = $web; clip = $clip; fin = @($fin.Contains('Clear-Clip'), $fin.Contains('$Error.Clear()'), $fin.Contains('$cron = $null')) } | ConvertTo-Json -Depth 4 -Compress))`,
    );
    const r = JSON.parse(run(['-File', f]).stdout);
    expect(r.errors).toEqual([]);
    expect(r.curly, '字符串里出现了中文引号（所在行）').toEqual([]);
    const web = Array.isArray(r.web) ? r.web : [r.web];
    expect(web).toHaveLength(2);
    for (const w of web) expect(w.ok, `第 ${w.line} 行没带 -MaximumRedirection 0`).toBe(true);
    expect([r.clip].flat()).toEqual(["Set-Clipboard -Value ' '"]);
    expect(r.fin).toEqual([true, true, true]);
  }, 60_000);

  it('运行方式和参数：点源、& 调用被拒；没设 LEMO_TEST_API 时本机 -ApiBase 被拒；evil 后缀、@ 主机、结尾斜杠被拒；-Target 只认 preview、prod', () => {
    const env = { ...process.env };
    delete env.LEMO_TEST_API;
    const rs = [
      [run(['-Command', `. ${q(SCRIPT)} -Target preview`], env), '不要点源'],
      [run(['-Command', `& ${q(SCRIPT)} -Target preview`], env), '不要在已打开的窗口里用 & 调用'],
      [run(['-File', SCRIPT, '-Target', 'preview', '-ApiBase', 'http://127.0.0.1:9'], env), '只给测试用'],
      ...['https://api.supabase.com.evil.io', 'https://api.supabase.com@evil.io', 'https://api.supabase.com/'].map((b) => [run(['-File', SCRIPT, '-Target', 'preview', '-ApiBase', b], { ...env, LEMO_TEST_API: '1' }), ''] as const),
      [run(['-File', SCRIPT, '-Target', 'production'], env), ''],
    ] as const;
    for (const [x, msg] of rs) {
      expect(x.status).not.toBe(0);
      expect(x.stdout + x.stderr).toContain(msg);
      expect(x.stdout).not.toContain('先检查');
    }
  }, 60_000);

  it('从头跑到尾：值在库里生成、SQL 里没有值、读回原样写成 CRON_SECRET、原有 secrets 不少、屏幕不显示值', async () => {
    const r = await runScript();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expectClean(r);
    for (const x of r.reqs) expect(x.auth).toBe(`Bearer ${TOKEN}`);
    expect(r.reqs.map((x) => `${x.method} ${x.path.replace(BASE, '')}`)).toEqual([
      'GET ', 'GET /secrets', 'POST /database/query', 'POST /database/query', 'POST /secrets', 'GET /secrets',
    ]);
    const [write, read] = r.sqls;
    expect(write).toContain("declare v text := encode(extensions.gen_random_bytes(32), 'hex');");
    expect(write).toContain("perform vault.update_secret((select id from vault.secrets where name = 'cron_secret'), v);");
    expect(write).toContain("perform vault.create_secret(v, 'cron_secret');");
    expect(write).toContain(`perform vault.create_secret('${FN_URL}', 'functions_url');`);
    expect(read).toMatch(/^select name, decrypted_secret, .* from vault\.decrypted_secrets d where name in \('cron_secret', 'functions_url'\)/);
    expect(r.value).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r.reqs[4]?.body ?? '[]')).toEqual([{ name: 'CRON_SECRET', value: r.value }]);
    expect([...r.secrets.keys()].sort()).toEqual(['CRON_SECRET', 'GEMINI_API_KEY', 'OPS_SECRET']);
    expect(r.ev).toEqual(['read:secure', 'clip: ', 'clip: ']);
    expect(r.out).toContain('已写入 CRON_SECRET；原有的 2 个 secrets 都在');
    expect(r.out).toContain('全部写好');

    // 本机库开着时：脚本发出的两段 SQL 真跑（写两遍：create 或 update 都走到），读回 64 位十六进制、每个名字一条，最后回滚
    if (dbUp) {
      const p = spawnSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'], {
        encoding: 'utf8',
        input: `begin;\n${write}\n${write}\nselect name, decrypted_secret ~ '^[0-9a-f]{64}$' or decrypted_secret = '${FN_URL}', n from (${read}) x;\nrollback;\n`,
      });
      expect(p.status, p.stderr).toBe(0);
      expect(p.stdout).toContain('cron_secret|t|1');
      expect(p.stdout).toContain('functions_url|t|1');
    }
  }, 120_000);

  it('读回那次出错、对方把明文带回来：不打印响应体，红字提示立刻重跑，不写 secrets', async () => {
    const r = await runScript({ failRead: true });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('HTTP 500');
    expect(r.err).toContain('不显示对方的说明');
    expect(r.err).toContain(RERUN);
    expect(r.out).toContain(RERUN);
    expect(r.reqs.some((x) => x.method === 'POST' && x.path.endsWith('/secrets'))).toBe(false);
  }, 60_000);

  it('读回的值格式不对：只报长度，不写 secrets，提示重跑', async () => {
    const r = await runScript({ badRead: true });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('收到 64 个字符');
    expect(r.err).toContain(RERUN);
    expect(r.reqs.some((x) => x.method === 'POST' && x.path.endsWith('/secrets'))).toBe(false);
  }, 60_000);

  it('写 secrets 返回 400 并回显请求正文：不打印值，提示立刻重跑', async () => {
    const r = await runScript({ failPost: true });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('HTTP 400');
    expect(r.err).toContain('不显示对方的说明');
    expect(r.err).toContain(RERUN);
  }, 60_000);

  it('写 Vault 出错（例如没有 vault）：报对方的说明（SQL 里没有值），提示重跑，不读回、不写 secrets', async () => {
    const r = await runScript({ failWrite: true });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('schema \\"vault\\" does not exist');
    expect(r.err).toContain(RERUN);
    expect(r.sqls).toHaveLength(1);
    expect(r.reqs.some((x) => x.method === 'POST' && x.path.endsWith('/secrets'))).toBe(false);
  }, 60_000);

  it('项目名不对：核对完就停，不动数据库、不写 secrets', async () => {
    const r = await runScript({ projName: 'lemomemo-prod' });
    expect(r.code).toBe(1);
    expectClean(r);
    expect(r.err).toContain('不是 lemomemo-preview');
    expect(r.err).not.toContain(RERUN);
    expect(r.reqs.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${BASE}`]);
  }, 60_000);

  it('令牌连续 3 次格式不对：停下，不发任何请求，只报长度', async () => {
    const r = await runScript({ token: ['abc', 'sbp_x', 'nope'] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('连续 3 次格式不对');
    expect(r.out).toContain('收到 5 个字符，以 sbp_ 开头');
    expect(r.reqs).toHaveLength(0);
  }, 60_000);
});
