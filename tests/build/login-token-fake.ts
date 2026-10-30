// tools/keys/login-token-tests.ps1 测试用的本机假服务和运行器（不连真实的 Supabase、不用任何真实令牌）：
// 一个端口同时当 Supabase（/auth、/rest、/functions）和预览站（/app、/sb、/files）；Read-Host、进程和注册表检查、剪贴板、Start-Process 都在外壳脚本里屏蔽。
// 用它的测试：login-token-tests-run.test.ts（从头跑到尾）、login-token-tests.test.ts（静态检查和拒绝运行方式）
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { p6Route } from './login-token-fake-p6.ts';

export const root = join(import.meta.dirname, '..', '..');
export const SCRIPT = join(root, 'tools', 'keys', 'login-token-tests.ps1');
export const FINALLY = '已退出这次的登录会话、清剪贴板、清掉内存里的变量';

function findPs(): string | null {
  const cands = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
export const PS = findPs();

export function writePs(dir: string, name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, '\uFEFF' + text, 'utf8');
  return p;
}
export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

// 独立于脚本的另一份解析：private 的表、函数，以及 grant 给 authenticated 的函数（白名单）
const migSql = readdirSync(join(root, 'supabase', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(root, 'supabase', 'migrations', f), 'utf8'))
  .join('\n');
export const PRIVATE_TABLES = [...new Set([...migSql.matchAll(/^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?private\.([a-z_][a-z0-9_]*)/gim)].map((m) => m[1] ?? ''))];
export const PRIVATE_FNS = [...new Set([...migSql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+private\.([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1] ?? ''))];
export const WHITE = new Set(
  [...migSql.matchAll(/^\s*grant\s+execute\s+on\s+function\s+private\.([a-z_][a-z0-9_]*)\s*\([^)]*\)\s+to\s+([^;]+);/gim)]
    .filter((m) => /\bauthenticated\b/i.test(m[2] ?? ''))
    .map((m) => m[1] ?? ''),
);
// 触发器函数（returns trigger）：PostgREST 不暴露，P2 里回 404 PGRST202 算正常
export const TRIGGER_FNS = new Set(
  [...migSql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+private\.([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*returns\s+trigger\b/gi)].map((m) => m[1] ?? ''),
);
export const SAFE_POST = ['purge_deleted_impl', 'record_consent_impl', 'files_authorize_impl', 'report_tz_impl', 'remove_device_impl'];

export const UID = '11111111-2222-4333-8444-555555555555';
const SID = '99999999-8888-4777-8666-555555555555';
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const AMR = [{ method: 'otp', timestamp: 1761700000 }];
const mkTok = (note: string, amr: unknown, exp?: number) =>
  `${b64u({ alg: 'HS256' })}.${b64u({ sub: UID, session_id: SID, role: 'authenticated', amr, note, ...(exp ? { exp } : {}) })}.c2lnVEVTVE9OTFk`;
export const ACCESS = mkTok('TESTONLYACCESS', AMR);
export const ACCESS2 = mkTok('TESTONLYACCESS2', AMR);
export const REFRESH = 'TESTONLYrefresh-token-zz';
export const LEAK = 'TESTONLYleaked-password-session-token';
export const OTP = '864209';
export const PK = 'sb_publishable_TESTONLYpublishablekey123456';
// P6 用的假 service key（只认 apikey 头，和新格式 sb_secret_ 一样）
export const SERVICE = 'sb_secret_TESTONLYservicekey1234567890ab';
// 登录链接里的 token（哈希）：默认邮件模板只有链接、没有 6 位码时，脚本取出它按 token_hash 换会话。
// 和真实 GoTrue 一致：链接里是 pkce_ 前缀加哈希，verify 只认去掉前缀的哈希（HASH）
export const HASH = 'TESTONLY0123456789abcdef0123456789abcdef0123456789abcdef';

export type Req = { method: string; path: string; auth: string; headers: IncomingMessage['headers']; body: Buffer };
export type Opts = {
  captcha?: boolean;          // /otp 回 400 captcha_failed
  noKeyOnSite?: boolean;      // 页面脚本里没有 publishable key
  leakTable?: string;         // 这张 private 表竟然读得到（200）
  pwLogin?: 'ok' | '429';     // 设密码后密码登录竟然成功 / 被 429 挡住
  refreshFailAfterP8?: number; // P8 测试函数被调到第 n 次以后，刷新令牌一律失败
  amrStrings?: string[];      // amr 发成裸字符串数组（GoTrue 有的版本这样发）
  logoutFail?: boolean;       // 退出登录回 500（模拟 Ctrl+C 或网络断了，会话没作废）
  hashMagicOnly?: boolean;    // token_hash 只认 type=magiclink（type=email 回 403）
  errBodyStreamOnly?: boolean; // 模拟 PS 5.1：HTTP 出错时 ErrorDetails 为空，错误体只能从 $_.Exception.Response.GetResponseStream() 读到
  white404?: string[];        // 这些白名单函数回 404 PGRST202（触发器函数 PostgREST 不暴露；或预览缺迁移）
  inactive?: boolean;         // private.is_active 回 false（测试账号没有 profile 行）
  expIn?: number;             // 每把访问令牌（登录、每次刷新各发一把）带 exp = 发出时 + expIn 秒；过了 exp + p5Grace 秒，REST 回 401 PGRST303、logout 回 401
  p5Grace?: number;           // 过期后还放行几秒（默认 2）
  all?: boolean;              // 不加默认的 -Only（跑全部项目，含 P5、P9）
  verify429?: boolean;        // /auth/v1/verify 一律回 429（限流）
  userTotals?: number[];      // P6：GET /auth/v1/admin/users 依次报的 x-total-count（默认一直是 7；最后一个用到底）
  adminTotals?: (number | null)[];   // P6：GET /rest/v1/admins（Accept-Profile: private）依次报的 Content-Range 总数（默认一直是 0；null = 回 500）
  plain: string[];            // Read-Host（明文）依次的回答
  secure: string[];           // Read-Host -AsSecureString 依次的回答
  args?: string;              // 额外参数
};
export type RunResult = Awaited<ReturnType<typeof runScript>>;

export async function runScript(dir: string, opts: Opts) {
  const reqs: Req[] = [];
  const objects = new Map<string, { body: Buffer; ct: string }>();
  const passwords: string[] = [];
  let msSigns = 0;
  let p8 = 0;
  let refreshes = 0;
  // 这次运行实际发出去的访问令牌：amr 为字符串形状时另做一套。不带 expIn 时登录发 tokA、刷新一律发 tokB；
  // 带 expIn 时每次都发一把新的（exp = 发出时 + expIn 秒），记在 toks 里
  const tokA = opts.amrStrings ? mkTok('TESTONLYACCESS_S', opts.amrStrings) : ACCESS;
  const tokB = opts.amrStrings ? mkTok('TESTONLYACCESS2_S', opts.amrStrings) : ACCESS2;
  const toks = new Map<string, number | undefined>([[tokA, undefined], [tokB, undefined]]);
  let mints = 0;
  const mint = (first: boolean) => {
    if (!opts.expIn) return first ? tokA : tokB;
    mints++;
    const e = Math.floor(Date.now() / 1000) + opts.expIn;
    const t = mkTok(`TESTONLYACCESS_E${mints}`, opts.amrStrings ?? AMR, e);
    toks.set(t, e);
    return t;
  };
  const expired = (t: string) => {
    const e = toks.get(t);
    return e !== undefined && Date.now() / 1000 > e + (opts.p5Grace ?? 2);
  };
  const logouts: { auth: string; status: number }[] = [];
  const p6Calls = { users: 0, admins: 0 };
  const P8_SEQ: [number, unknown][] = [
    [200, { ok: true }],
    [403, { error: 'account_disabled' }],
    [403, { error: 'account_pending_deletion', purge_after: '2026-11-05T00:00:00Z' }],
    [503, { error: 'try_later' }],
    [200, { ok: true }],
    [401, { error: 'session_revoked' }],
  ];
  const send = (res: ServerResponse, code: number, obj: unknown, extra: Record<string, string> = {}) => {
    const buf = obj === undefined ? Buffer.alloc(0) : Buffer.isBuffer(obj) ? obj : Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length, connection: 'close', ...extra });
    res.end(buf);
  };
  let base = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      const auth = String(req.headers.authorization ?? '');
      reqs.push({ method: req.method ?? '', path: url, auth, headers: req.headers, body });
      const json = () => JSON.parse(body.toString('utf8') || '{}');
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const known = (!opts.expIn || mints > 0) && toks.has(bearer);
      const okUser = known && !expired(bearer);
      const p = url.startsWith('/sb/auth/') ? url.slice(3) : url;
      // 网站
      if (req.method === 'GET' && p === '/app/') return send(res, 200, '<html><script type="module" crossorigin src="/app/assets/index-abc.js"></script></html>', { 'content-type': 'text/html' });
      if (req.method === 'GET' && p === '/app/assets/index-abc.js') return send(res, 200, opts.noKeyOnSite ? 'const x=1;' : `const k="${PK}";`, { 'content-type': 'text/javascript' });
      // Auth
      // P6：GoTrue 管理端数账号、PostgREST 数 private.admins（只认 service key；login-token-fake-p6.ts）
      const p6 = p6Route(req, p, opts, SERVICE, UID, p6Calls);
      if (p6) return send(res, ...p6);
      if (p.startsWith('/auth/v1/')) {
        if (req.headers.apikey !== PK) return send(res, 401, { message: 'no apikey' });
        if (req.method === 'POST' && p === '/auth/v1/otp') return opts.captcha ? send(res, 400, { code: 400, error_code: 'captcha_failed' }) : send(res, 200, {});
        if (req.method === 'POST' && p === '/auth/v1/verify') {
          if (opts.verify429) return send(res, 429, { code: 429, error_code: 'over_request_rate_limit' });
          const v = json();
          if (v.token_hash !== undefined) {
            // 只收 { type, token_hash } 两个字段：不带 token、email
            const okHash = v.token_hash === HASH && Object.keys(v).length === 2 && (v.type === 'magiclink' || (v.type === 'email' && !opts.hashMagicOnly));
            return okHash ? send(res, 200, { access_token: mint(true), refresh_token: REFRESH, expires_in: 600, user: { id: UID } }) : send(res, 403, { code: 403, error_code: 'otp_expired' });
          }
          return v.token === OTP && v.type === 'email' ? send(res, 200, { access_token: mint(true), refresh_token: REFRESH, expires_in: 600, user: { id: UID } }) : send(res, 403, { code: 403, error_code: 'otp_expired' });
        }
        if (req.method === 'POST' && p === '/auth/v1/token?grant_type=refresh_token') {
          if (opts.refreshFailAfterP8 !== undefined && p8 >= opts.refreshFailAfterP8) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found' });
          refreshes++;
          return send(res, 200, { access_token: mint(false), refresh_token: `${REFRESH}${refreshes}` });
        }
        if (req.method === 'POST' && p === '/auth/v1/token?grant_type=password') {
          if (opts.pwLogin === 'ok') return send(res, 200, { access_token: LEAK, refresh_token: 'TESTONLYleakrefresh' });
          if (opts.pwLogin === '429') return send(res, 429, { code: 429, error_code: 'over_request_rate_limit' });
          return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        }
        if (req.method === 'PUT' && p === '/auth/v1/user') {
          if (!okUser) return send(res, 401, { error_code: 'bad_jwt' });
          passwords.push(String(json().password));
          return send(res, 200, { id: UID });
        }
        if (req.method === 'GET' && p === '/auth/v1/user') return okUser ? send(res, 200, { id: UID }) : send(res, 401, { error_code: 'bad_jwt' });
        if (req.method === 'POST' && p === '/auth/v1/logout?scope=local') {
          // 和 GoTrue 一样：过期的令牌退不了（401 bad_jwt），会话不作废
          const st = opts.logoutFail ? 500 : toks.has(bearer) && expired(bearer) ? 401 : 204;
          logouts.push({ auth, status: st });
          if (st === 500) return send(res, 500, { code: 500, error_code: 'unexpected_failure' });
          if (st === 401) return send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT: token is expired' });
          return send(res, 204, undefined);
        }
        return send(res, 404, { message: 'not found' });
      }
      // REST
      if (p.startsWith('/rest/v1/')) {
        // 过了 exp + 余量：和 PostgREST 一样回 401 PGRST303
        if (req.headers.apikey === PK && known && expired(bearer)) return send(res, 401, { code: 'PGRST303', message: 'JWT expired' });
        if (req.headers.apikey !== PK || !okUser) return send(res, 401, { code: '42501' });
        // P5：只读 settings 的 user_id
        if (req.method === 'GET' && p === '/rest/v1/settings?select=user_id&limit=1') return send(res, 200, []);
        const m = /^\/rest\/v1\/rpc\/([a-z_0-9]+)(\?.*)?$/.exec(p);
        if (m) {
          const name = m[1] ?? '';
          const profile = req.method === 'GET' ? req.headers['accept-profile'] : req.headers['content-profile'];
          if (profile !== 'private') return send(res, 404, { code: 'PGRST202' });
          if (opts.white404?.includes(name)) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function' });
          if (name === 'is_active' && req.method === 'GET') return send(res, 200, opts.inactive ? 'false' : 'true');
          // 白名单函数：权限放行，用占位参数跑下去会报错（只读事务、或者参数不对）
          return WHITE.has(name) ? send(res, 400, { code: req.method === 'GET' ? '25006' : 'P0001', message: 'probe' }) : send(res, 403, { code: '42501', message: 'permission denied for function' });
        }
        const t = /^\/rest\/v1\/([a-z_]+)\?select=\*&limit=1$/.exec(p);
        if (t && req.method === 'GET') {
          if (req.headers['accept-profile'] !== 'private') return send(res, 400, { code: 'x' });
          return t[1] === opts.leakTable ? send(res, 200, []) : send(res, 403, { code: '42501', message: 'permission denied for table' });
        }
        if (req.method === 'POST' && /^\/rest\/v1\/(notes|note_images|note_files)$/.test(p)) return send(res, 201, undefined);
        if (req.method === 'PATCH' && /^\/rest\/v1\/(notes|note_images|note_files)\?id=eq\.[0-9a-f-]{36}$/.test(p)) return send(res, 204, undefined);
        return send(res, 404, { code: 'PGRST205' });
      }
      // /files
      const o = /^\/files\/v1\/o\/(images|files)\/([^?]+)(\?.*)?$/.exec(p);
      if (o && req.method === 'PUT') {
        if (!okUser || req.headers['x-app-version'] !== '4.0.0') return send(res, 401, { code: 'unauthorized' });
        const key = `${o[1]}/${o[2]}`;
        if (objects.has(key)) return send(res, 409, { code: 'exists' });
        if (Number(req.headers['content-length']) !== body.length) return send(res, 400, { code: 'bad_request' });
        objects.set(key, { body, ct: String(req.headers['content-type']) });
        const etag = createHash('md5').update(body).digest('hex');
        return send(res, 200, { etag: `"${etag}"` }, { etag: `"${etag}"` });
      }
      if (o && req.method === 'GET') {
        const sig = String(req.headers['x-files-sig'] ?? '');
        const good = (sig.endsWith('&s=GOODSIG') && !o[3]) || (!sig && (o[3] ?? '').endsWith('&s=GOODSIG'));
        if (!good) return send(res, 403, { code: 'bad_signature' });
        const ob = objects.get(`${o[1]}/${o[2]}`);
        if (!ob) return send(res, 404, { code: 'not_found' });
        return send(res, 200, ob.body, { 'content-type': ob.ct, 'cf-cache-status': 'DYNAMIC' });
      }
      if (p === '/files/v1/sign' && req.method === 'POST') {
        if (!okUser) return send(res, 401, { code: 'unauthorized' });
        const e = Math.floor(Date.now() / 1000) + 300;
        const items = (json().items as { bucket: string; path: string; purpose: string }[]).map((it, i) => {
          if (it.purpose === 'ms') {
            msSigns++;
            if (msSigns === 1) return { i, ok: false, reason: 'not_checked' };
            return { i, ok: true, url: `${base}/files/v1/o/${it.bucket}/${it.path}?e=${e}&s=GOODSIG`, e };
          }
          return { i, ok: true, url: `${base}/files/v1/o/${it.bucket}/${it.path}`, sig: `p=${it.purpose}&e=${e}&s=GOODSIG`, e };
        });
        return send(res, 200, { items });
      }
      if (p === '/functions/v1/p8probe' && req.method === 'POST') {
        const [c, b] = P8_SEQ[Math.min(p8++, P8_SEQ.length - 1)] ?? [500, {}];
        return send(res, c, b);
      }
      return send(res, 404, { message: 'not found' });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  const opened = join(dir, `opened-${port}.txt`);
  // errBodyStreamOnly：包一层 Invoke-WebRequest，HTTP 出错时换成一个不带 ErrorDetails 的错误，错误体只放进 Response.GetResponseStream()
  // 只在 Windows PowerShell 5.1 下包：pwsh 7 下脚本带 SkipHttpErrorCheck、HTTP 出错不抛，用不着这层；而且这层包在 pwsh 7（CI 的 ubuntu）下
  // 会让正常请求也失败：CI（ubuntu 上的 pwsh 7）里这组用例报“还剩 0 个明文、1 个密文输入没用上”，正好是取不到预览站页面、
  // 脚本改为连问 3 次 publishable key 把明文输入吃光后停下（具体是 $args 转发还是 StrictMode 下读 .Response 出错，本机没有 pwsh 没能复现）
  const streamOnly = opts.errBodyStreamOnly
    ? `if ($PSVersionTable.PSVersion.Major -lt 7) {
function global:Invoke-WebRequest {
  try { Microsoft.PowerShell.Utility\\Invoke-WebRequest @args }
  catch {
    $src = $_.Exception.Response
    if ($null -eq $src) { throw }
    $msg = if ($null -ne $_.ErrorDetails) { [string]$_.ErrorDetails.Message } else { '' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
    $fake = [pscustomobject]@{ StatusCode = [int]$src.StatusCode; Headers = $src.Headers }
    $fake | Add-Member -MemberType ScriptMethod -Name GetResponseStream -Value ({ New-Object System.IO.MemoryStream (,$bytes) }.GetNewClosure())
    $ex = New-Object System.Exception 'test: 错误体只在响应流里'
    $ex | Add-Member -MemberType NoteProperty -Name Response -Value $fake
    throw (New-Object System.Management.Automation.ErrorRecord ($ex, 'test', [System.Management.Automation.ErrorCategory]::NotSpecified, $null))
  }
}
}
`
    : '';
  const harness = writePs(
    dir,
    `run-${port}.ps1`,
    `$ErrorActionPreference = 'Stop'
$env:LEMO_TEST_API = '1'
function global:Get-Process { @() }
function global:Get-CimInstance { @() }
function global:Get-ItemProperty { $null }
function global:Set-Clipboard { }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
${streamOnly}function global:Start-Process { param([Parameter(Position = 0)][string]$FilePath) Add-Content -LiteralPath ${q(opened)} -Value $FilePath -Encoding UTF8 }
$global:plain = New-Object System.Collections.Queue
$global:secure = New-Object System.Collections.Queue
${opts.plain.map((v) => `$global:plain.Enqueue(${q(v)})`).join('\n')}
${opts.secure.map((v) => `$global:secure.Enqueue(${q(v)})`).join('\n')}
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  if ($AsSecureString) {
    if ($global:secure.Count -eq 0) { throw "test: 密文输入用完了（$Prompt）" }
    return (ConvertTo-SecureString ([string]$global:secure.Dequeue()) -AsPlainText -Force) }
  if ($global:plain.Count -eq 0) { throw "test: 明文输入用完了（$Prompt）" }
  return [string]$global:plain.Dequeue() }
try { & ${q(SCRIPT)} -SupabaseBase '${base}' -SiteBase '${base}' -MsRemainSeconds 298 ${opts.all || opts.args?.includes('-Only') ? '' : "-Only 'S1,P2,R2,TC-B1-112,P8' "}${opts.args ?? ''}; if ($global:plain.Count -or $global:secure.Count) { [Console]::Error.WriteLine("test: 还剩 $($global:plain.Count) 个明文、$($global:secure.Count) 个密文输入没用上"); exit 2 }; exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
  );
  const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  await new Promise<void>((ok) => server.close(() => ok()));
  const opens = existsSync(opened) ? readFileSync(opened, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean) : [];
  return { code, out, err, reqs, objects, passwords, opens, p8, refreshes, tokens: [...toks.keys()], logouts };
}

export const summary = (out: string) => out.slice(out.indexOf('==== 结果摘要'), out.indexOf('==== 摘要结束'));

// 摘要里「标签：a、b、c」列出的函数名（排好序）。脚本按 $fnArgs（哈希表）的键顺序遍历函数：
// pwsh 7（.NET Core）下字符串哈希每个进程随机，列出的顺序不固定，只比集合
export function namesAfter(s: string, label: string): string[] {
  const i = s.indexOf(label);
  if (i < 0) return [];
  return (s.slice(i + label.length).split(/[；。\s]/)[0] ?? '').split('、').filter(Boolean).sort();
}
