// tools/keys/set-vapid-keys.ps1 的测试（不连真实的 Supabase、不用任何真实令牌；B2 O-1、架构审 M9、安全审查 C-8、C-9）。
// ① 静态：解析无错、无中文引号、每个 Invoke-RestMethod 带 -MaximumRedirection 0、Set-Clipboard 只清空；点源、& 调用被拒；
//    -ApiBase、-Target、-Subject 的反面用例（含大写协议、大写 mailto、带端口：代码审查 M1、安全审查 O1-S5）；LEMO_TEST_API=1 对着官方地址被拒（O1-S6）；
//    -Subject 的正则和后端 vapid.ts 的 SUBJECT 逐字一致（直接从 vapid.ts 读出来比，防止两边以后改得不一样）
// ② 从头跑到尾（本机假服务）：写入的 VAPID_PRIVATE_KEY 是一行 JWK、d/x/y 各 32 字节；用 Node 的 crypto 独立核对
//    “私钥签、公钥验”成对；VAPID_PUBLIC_KEY 和屏幕上的公钥是同一串、等于 0x04‖x‖y；屏幕和报错里没有私钥、没有令牌
// ③ 出错路径：写 secrets 400 回显正文时不打印私钥、红字提示重跑；项目名不对时不生成、不写
// ④ 写完后只拿两个公开值判断列表接口的 value 是明文、摘要还是不清楚，屏幕上只报这一个词、不打印值（安全审查 O1-S3）
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, q, root, writePs } from './login-token-fake.ts';

const SCRIPT = join(root, 'tools', 'keys', 'set-vapid-keys.ps1');
const REF = 'yoeqwhygehbaftkppati';
const BASE = `/v1/projects/${REF}`;
const TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_token_'.padEnd(40, 'z');
const FINALLY = '已清剪贴板、清掉内存里的变量';
const RERUN = 'VAPID_PRIVATE_KEY 可能已换、公钥还没拿到';
const JWK_RE = /^\{"kty":"EC","crv":"P-256","d":"([A-Za-z0-9_-]{43})","x":"([A-Za-z0-9_-]{43})","y":"([A-Za-z0-9_-]{43})"\}$/;

let dir = '';
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env });

type Req = { method: string; path: string; auth: string; body: string };
/** 假服务 GET /secrets 返回的 value：plain 原值、sha 原值的 SHA-256 十六进制、other（默认）固定串 'digest' */
type Opts = { projName?: string; failPost?: boolean; subject?: string; valueMode?: 'plain' | 'sha' | 'other' };

async function runScript(opts: Opts = {}) {
  const reqs: Req[] = [];
  const secrets = new Map<string, string>([['CRON_SECRET', 'x'], ['OPS_SECRET', 'y']]);
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
      if (req.method === 'GET' && path === `${BASE}/secrets`) {
        const shown = (v: string) => (opts.valueMode === 'plain' ? v : opts.valueMode === 'sha' ? createHash('sha256').update(v, 'utf8').digest('hex') : 'digest');
        return send(res, 200, [...secrets.entries()].map(([name, v]) => ({ name, value: shown(v) })));
      }
      if (req.method === 'POST' && path === `${BASE}/secrets`) {
        // 出错时对方把请求正文（含私钥）原样带回来：脚本不能打印
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
  const subj = opts.subject === undefined ? '' : ` -Subject ${q(opts.subject)}`;
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
function global:Out-File { $global:ev.Add('file') }
function global:Set-Content { $global:ev.Add('file') }
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  if ($AsSecureString) { $global:ev.Add('read:secure'); return (ConvertTo-SecureString (${q(String.fromCharCode(0x200b) + TOKEN)}) -AsPlainText -Force) }
  $global:ev.Add('read:' + $Prompt.Trim()); throw 'test: 不该再问负责人' }
$code = 0
try { & ${q(SCRIPT)} -Target preview${subj} -ApiBase 'http://127.0.0.1:${port}' }
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
  const posted = reqs.filter((r) => r.method === 'POST' && r.path === `${BASE}/secrets`).map((r) => JSON.parse(r.body) as { name: string; value: string }[]);
  return { code, out, err, reqs, secrets, ev, posted };
}

type Run = Awaited<ReturnType<typeof runScript>>;
/** 屏幕、报错里没有令牌、没有私钥 JWK、没有 d；不往剪贴板放东西、不起进程、不写文件、不再问 */
function expectClean(r: Run, priv: string[]) {
  expect(r.out).toContain(FINALLY);
  for (const s of [r.out, r.err]) {
    expect(s.includes(TOKEN) || s.includes('TEST_ONLY')).toBe(false);
    for (const p of priv) expect(s.includes(p), '屏幕上出现了私钥').toBe(false);
    expect(s).not.toContain('"d":"');
  }
  expect(r.ev.filter((e) => e.startsWith('clip:') && e !== 'clip: ')).toEqual([]);
  expect(r.ev.filter((e) => e === 'spawn' || e === 'file' || (e.startsWith('read:') && e !== 'read:secure'))).toEqual([]);
}

const b64u = (b: Buffer) => b.toString('base64url');

// 代码审查 M1：脚本的 -Subject 正则必须和后端 vapid.ts 的 SUBJECT 一致（后端判不合格会回 vapid_bad_subject、推送全停）。
// 直接从 vapid.ts 读出正则，把 JS 写法换成 .NET 写法（^ → \A、$ → \z、\/ → /）后和脚本里的 $SubjectRe 逐字比对；
// 再拿同一组样例跑一遍后端的正则，确认脚本测试里用的反例在后端也是不合格的
describe('-Subject 的正则和 vapid.ts 的 SUBJECT 一致（不用 PowerShell）', () => {
  const vapidSrc = readFileSync(join(root, 'supabase', 'functions', '_shared', 'push', 'vapid.ts'), 'utf8');
  const js = /^const SUBJECT = \/(.+)\/([a-z]*);$/m.exec(vapidSrc);
  const ps = /^\$SubjectRe = '([^']+)'$/m.exec(readFileSync(SCRIPT, 'utf8'));

  it('逐字一致（JS 的 ^…$ 对 .NET 的 \\A…\\z）', () => {
    expect(js, 'vapid.ts 里找不到 const SUBJECT = /…/;').not.toBeNull();
    expect(ps, '脚本里找不到 $SubjectRe').not.toBeNull();
    const body = js?.[1] ?? '';
    expect(js?.[2], 'SUBJECT 带了标志（例如 i 会不分大小写）').toBe('');
    expect(body.startsWith('^') && body.endsWith('$')).toBe(true);
    const asNet = String.raw`\A` + body.slice(1, -1).replaceAll(String.raw`\/`, '/') + String.raw`\z`;
    expect(ps?.[1]).toBe(asNet);
  });

  it('后端的正则：默认值、带路径、mailto 收；大写协议、大写 mailto、带端口、有空白、http 不收', () => {
    const re = new RegExp(js?.[1] ?? '(?!)', js?.[2] ?? '');
    for (const ok of ['https://lemomemo.com', 'https://lemomemo.com/contact', 'mailto:ops@lemomemo.com']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['HTTPS://lemomemo.com', 'MAILTO:ops@lemomemo.com', 'https://lemomemo.com:443', 'https://lemomemo.com x', 'http://lemomemo.com', 'mailto:']) {
      expect(re.test(bad), bad).toBe(false);
    }
  });
});

describe.skipIf(!PS)('set-vapid-keys.ps1', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-vapid-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('静态：解析无错、无中文引号、Invoke-RestMethod 带 -MaximumRedirection 0、Set-Clipboard 只清空、文件是 UTF-8 BOM + LF、不提密码管理器', () => {
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
$files = @($cmds | Where-Object { @('Out-File', 'Set-Content', 'Add-Content', 'New-Item', 'Export-Clixml', 'Start-Transcript') -contains $_.GetCommandName() } | ForEach-Object { $_.GetCommandName() })
[Console]::Out.Write((@{ errors = @($e | ForEach-Object { $_.Message }); curly = $bad; web = $web; clip = $clip; files = $files } | ConvertTo-Json -Depth 4 -Compress))`,
    );
    const r = JSON.parse(run(['-File', f]).stdout);
    expect(r.errors).toEqual([]);
    expect(r.curly, '字符串里出现了中文引号（所在行）').toEqual([]);
    const web = [r.web].flat();
    expect(web).toHaveLength(2);
    for (const w of web) expect(w.ok, `第 ${w.line} 行没带 -MaximumRedirection 0`).toBe(true);
    expect([r.clip].flat()).toEqual(["Set-Clipboard -Value ' '"]);
    expect([r.files].flat().filter(Boolean)).toEqual([]);
    const raw = readFileSync(SCRIPT);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.includes(0x0d)).toBe(false);
    expect(raw.toString('utf8')).not.toMatch(/Google|密码管理器/);
  }, 60_000);

  it('运行方式和参数：点源、& 调用被拒；没设 LEMO_TEST_API 时本机 -ApiBase 被拒；-Target 只认 preview、prod；-Subject 只认 https 网址或 mailto', () => {
    const env = { ...process.env };
    delete env.LEMO_TEST_API;
    const rs = [
      [run(['-Command', `. ${q(SCRIPT)} -Target preview`], env), '不要点源'],
      [run(['-Command', `& ${q(SCRIPT)} -Target preview`], env), '不要在已打开的窗口里用 & 调用'],
      [run(['-File', SCRIPT, '-Target', 'preview', '-ApiBase', 'http://127.0.0.1:9'], env), '只给测试用'],
      ...['https://api.supabase.com.evil.io', 'https://api.supabase.com@evil.io'].map((b) => [run(['-File', SCRIPT, '-Target', 'preview', '-ApiBase', b], { ...env, LEMO_TEST_API: '1' }), ''] as const),
      [run(['-File', SCRIPT, '-Target', 'production'], env), ''],
      ...['http://lemomemo.com', 'lemomemo.com', 'https://lemomemo.com x', 'mailto:', 'javascript:alert(1)', 'https://lemomemo.com\nmailto:a@b'].map((s) => [run(['-File', SCRIPT, '-Target', 'preview', '-Subject', s], env), ''] as const),
      // 代码审查 M1、安全审查 O1-S5：大写协议、大写 mailto、带端口，后端 vapid.ts 判不合格（vapid_bad_subject），脚本也要拒
      ...['HTTPS://lemomemo.com', 'MAILTO:ops@lemomemo.com', 'https://lemomemo.com:443'].map((s) => [run(['-File', SCRIPT, '-Target', 'preview', '-Subject', s], env), '-Subject 格式不对'] as const),
      // 安全审查 O1-S6：LEMO_TEST_API=1 时 -ApiBase 是官方地址（含默认值）就停，测试模式不可能对着真接口跑
      [run(['-File', SCRIPT, '-Target', 'preview'], { ...env, LEMO_TEST_API: '1' }), 'LEMO_TEST_API=1 只给测试用'],
      [run(['-File', SCRIPT, '-Target', 'preview', '-ApiBase', 'https://api.supabase.com'], { ...env, LEMO_TEST_API: '1' }), 'LEMO_TEST_API=1 只给测试用'],
    ] as const;
    for (const [x, msg] of rs) {
      expect(x.status).not.toBe(0);
      expect(x.stdout + x.stderr).toContain(msg);
      expect(x.stdout).not.toContain('先检查');
    }
  }, 120_000);

  it('从头跑到尾：三项一次写入；JWK 一行、d/x/y 各 32 字节；Node 独立核对成对；VAPID_PUBLIC_KEY = 屏幕上的公钥 = 0x04‖x‖y；屏幕不显示私钥', async () => {
    const r = await runScript();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    for (const x of r.reqs) expect(x.auth).toBe(`Bearer ${TOKEN}`);
    expect(r.reqs.map((x) => `${x.method} ${x.path.replace(BASE, '')}`)).toEqual(['GET ', 'GET /secrets', 'POST /secrets', 'GET /secrets']);
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]?.map((s) => s.name)).toEqual(['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']);
    const jwk = r.secrets.get('VAPID_PRIVATE_KEY') ?? '';
    const m = JWK_RE.exec(jwk);
    expect(m, '私钥不是规定格式的一行 JWK').not.toBeNull();
    const [, d, x, y] = m as unknown as [string, string, string, string];
    for (const v of [d, x, y]) expect(Buffer.from(v, 'base64url')).toHaveLength(32);
    const pub = r.secrets.get('VAPID_PUBLIC_KEY') ?? '';
    expect(pub).toMatch(/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/); // 和 D1-7 的 p256dh 同一写法（安全审查 O1-S4）
    expect(pub).toBe(b64u(Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')])));
    expect(r.out).toContain(pub);
    expect(r.secrets.get('VAPID_SUBJECT')).toBe('https://lemomemo.com');
    // 用 Node 独立核对：JWK 私钥签、只用公钥（原始点）验
    const key = createPrivateKey({ key: JSON.parse(jwk), format: 'jwk' });
    const pubKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
    const msg = Buffer.from('lemo vapid self-test');
    const sig = sign('sha256', msg, key);
    expect(verify('sha256', msg, pubKey, sig)).toBe(true);
    expect(verify('sha256', Buffer.from('tampered'), pubKey, sig)).toBe(false);
    expect([...r.secrets.keys()].sort()).toEqual(['CRON_SECRET', 'OPS_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']);
    expect(r.ev).toEqual(['read:secure', 'clip: ', 'clip: ']);
    expect(r.out).toContain('已写入 VAPID_PRIVATE_KEY、VAPID_PUBLIC_KEY、VAPID_SUBJECT；原有的 2 个 secrets 都在');
    expect(r.out).toContain('PREVIEW_VAPID_PUBLIC_KEY');
    expect(r.out).toContain('全部写好');
    expect(r.out).toContain('接口返回：不清楚'); // 默认假服务回固定串 'digest'：既不是原值也不是 SHA-256
    expectClean(r, [jwk, d]);
  }, 120_000);

  it('跑两次得到两对不同的钥匙（换钥匙就是重跑）', async () => {
    const a = await runScript();
    const b = await runScript();
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.secrets.get('VAPID_PRIVATE_KEY')).not.toBe(b.secrets.get('VAPID_PRIVATE_KEY'));
    expect(a.secrets.get('VAPID_PUBLIC_KEY')).not.toBe(b.secrets.get('VAPID_PUBLIC_KEY'));
  }, 120_000);

  it('-Subject mailto: 原样写进 VAPID_SUBJECT', async () => {
    const r = await runScript({ subject: 'mailto:ops@lemomemo.com' });
    expect(r.code).toBe(0);
    expect(r.secrets.get('VAPID_SUBJECT')).toBe('mailto:ops@lemomemo.com');
    expectClean(r, [r.secrets.get('VAPID_PRIVATE_KEY') ?? '']);
  }, 60_000);

  it.each([
    ['plain', '明文'],
    ['sha', '摘要'],
  ] as const)('写完后判断列表接口的 value：%s → 接口返回：%s；不打印任何值（安全审查 O1-S3）', async (valueMode, kind) => {
    const r = await runScript({ valueMode });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`接口返回：${kind}`);
    const jwk = r.secrets.get('VAPID_PRIVATE_KEY') ?? '';
    const pub = r.secrets.get('VAPID_PUBLIC_KEY') ?? '';
    // 摘要也不打印；公钥只在“填进 GitHub”那一处出现一次
    for (const v of [jwk, pub, 'https://lemomemo.com']) {
      expect(r.out).not.toContain(createHash('sha256').update(v, 'utf8').digest('hex'));
    }
    expect(r.out.split(pub).length - 1).toBe(1);
    expectClean(r, [jwk, JWK_RE.exec(jwk)?.[1] ?? 'x'.repeat(43)]);
  }, 60_000);

  it('写 secrets 返回 400 并回显请求正文：不打印私钥，红字提示立刻重跑，不打印公钥', async () => {
    const r = await runScript({ failPost: true });
    expect(r.code).toBe(1);
    const jwk = r.posted[0]?.find((s) => s.name === 'VAPID_PRIVATE_KEY')?.value ?? '';
    const pub = r.posted[0]?.find((s) => s.name === 'VAPID_PUBLIC_KEY')?.value ?? '';
    expect(jwk).toMatch(JWK_RE);
    expectClean(r, [jwk, JWK_RE.exec(jwk)?.[1] ?? 'x'.repeat(43)]);
    expect(r.err).toContain('HTTP 400');
    expect(r.err).toContain('不显示对方的说明');
    expect(r.err).toContain(RERUN);
    expect(r.out).toContain(RERUN);
    expect(r.out).not.toContain(pub);
  }, 60_000);

  it('项目名不对：核对完就停，不生成、不写 secrets', async () => {
    const r = await runScript({ projName: 'lemomemo-prod' });
    expect(r.code).toBe(1);
    expectClean(r, []);
    expect(r.err).toContain('不是 lemomemo-preview');
    expect(r.err).not.toContain(RERUN);
    expect(r.reqs.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${BASE}`]);
  }, 60_000);
});
