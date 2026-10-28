// tools/keys/set-fn-role-passwords.ps1 从头跑到尾（不连真实的 Supabase、不用任何真实令牌；静态检查和 SCRAM 向量在 set-fn-role-passwords.test.ts）：
// 用模拟输入（屏蔽 Read-Host、进程和注册表检查、剪贴板），把 -ApiBase 指向本机假服务（另设 LEMO_TEST_API=1），核对发出的请求：
// SQL 里没有明文密码、校验串和连接串里的密码对得上、secrets 请求格式对（带 sslmode=require）、先写删占位 LEMO_PROBE、屏幕输出里没有密码和令牌；
// 出错路径：贴错项目、缺角色、角色属于别的角色、连接池不对、alter 之后写 secrets 失败（对方回显请求正文）、第二个 alter 失败
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过。会清一次本机剪贴板历史（脚本收尾的 Clear-Clip）
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const SCRIPT = join(root, 'tools', 'keys', 'set-fn-role-passwords.ps1');
const PREVIEW_REF = 'yoeqwhygehbaftkppati';
const FINALLY = '已清剪贴板、清掉内存里的变量';
const RERUN = '角色密码已改、secrets 未写，请立刻重跑本脚本';

function findPs(): string | null {
  const cands = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const PS = findPs();

let dir = '';
function writePs(name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, '﻿' + text, 'utf8');
  return p;
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const b64 = (s: string) => Buffer.from(s, 'base64');

// 独立实现（Node crypto）：用来核对校验串确实由连接串里的密码算出
function scramNode(password: string, salt: Buffer): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

describe.skipIf(!PS)('set-fn-role-passwords.ps1 从头跑到尾', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-fnpw-run-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ───── 从头跑到尾 ─────
  type Req = { method: string; path: string; auth: string; body: string };
  type Opts = {
    projName?: string;
    roles?: string[];
    members?: { member: string; granted: string }[];
    pools?: unknown[];
    failAlter?: string;          // 这个角色的 alter 返回 500
    failSecretsPost?: boolean;    // 写 FN_* 的 POST 返回 400，并把请求正文原样回显
    failDelete?: boolean;         // DELETE /secrets 返回 403
    leftoverProbe?: boolean;      // 项目里本来就有上次留下的 LEMO_PROBE
  };
  const pool = (mode: string, port: number, extra: Record<string, unknown> = {}) => ({
    identifier: PREVIEW_REF, database_type: 'PRIMARY', pool_mode: mode, db_host: 'aws-0-ap-northeast-2.pooler.supabase.com',
    db_port: port, db_name: 'postgres', db_user: `postgres.${PREVIEW_REF}`, is_using_scram_auth: true, ...extra,
  });
  const POOLS = [pool('session', 5432), pool('transaction', 6543)];
  const TOKEN = 'sbp_' + 'TEST_ONLY_not_a_real_token_'.padEnd(40, 'z');

  async function runScript(opts: Opts = {}) {
    const reqs: Req[] = [];
    const roleNames = opts.roles ?? ['fn_vault', 'fn_ai'];
    const canLogin = new Set<string>();
    const secrets = new Map<string, string>([['GEMINI_API_KEY', 'x'], ['PROXY_SECRET', 'y']]);
    if (opts.leftoverProbe) secrets.set('LEMO_PROBE', 'old');
    // 带 content-length、connection: close：否则 Windows PowerShell 5.1 读不到错误响应的正文（ErrorDetails 为空），「回显请求正文」的用例就测不到
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
        const base = `/v1/projects/${PREVIEW_REF}`;
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Unauthorized' });
        if (req.method === 'GET' && path === base) return send(res, 200, { id: PREVIEW_REF, ref: PREVIEW_REF, name: opts.projName ?? 'lemomemo-preview', region: 'ap-northeast-2', status: 'ACTIVE_HEALTHY' });
        if (req.method === 'POST' && path === `${base}/database/query`) {
          const sql = String(JSON.parse(body).query);
          if (sql.startsWith('select rolname')) {
            return send(res, 201, roleNames.map((r) => ({ rolname: r, rolcanlogin: canLogin.has(r), rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolreplication: false, rolcreatedb: false })));
          }
          if (sql.includes('from pg_auth_members')) return send(res, 201, opts.members ?? []);
          const m = /^alter role (fn_vault|fn_ai) with login password '/.exec(sql);
          if (m) {
            if (opts.failAlter === m[1]) return send(res, 500, { message: 'Failed to run sql query: internal error' });
            canLogin.add(m[1] ?? '');
            return send(res, 201, []);
          }
          return send(res, 400, { message: 'unexpected sql' });
        }
        if (req.method === 'GET' && path === `${base}/config/database/pooler`) return send(res, 200, opts.pools ?? POOLS);
        if (req.method === 'GET' && path === `${base}/secrets`) return send(res, 200, [...secrets.keys()].map((name) => ({ name, value: 'digest' })));
        if (req.method === 'POST' && path === `${base}/secrets`) {
          const items = JSON.parse(body) as { name: string; value: string }[];
          if (opts.failSecretsPost && items.some((s) => s.name.startsWith('FN_'))) return send(res, 400, `{"message":"bad request: ${body.replace(/"/g, '\\"')}"}`);
          for (const s of items) secrets.set(s.name, s.value);
          return send(res, 201, undefined);
        }
        if (req.method === 'DELETE' && path === `${base}/secrets`) {
          if (opts.failDelete) return send(res, 403, { message: 'Your account does not have the necessary privileges' });
          for (const n of JSON.parse(body) as string[]) secrets.delete(n);
          return send(res, 200, {});
        }
        return send(res, 404, { message: 'not found' });
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    // 模拟：Read-Host 从队列取值（粘贴时前面带一个零宽空格，核对会被去掉）；进程、node 命令行、注册表检查都返回「没有」；不碰剪贴板
    const harness = writePs(
      `run-${port}.ps1`,
      `$ErrorActionPreference = 'Stop'
$env:LEMO_TEST_API = '1'
function global:Get-Process { @() }
function global:Get-CimInstance { @() }
function global:Get-ItemProperty { $null }
function global:Set-Clipboard { }
function global:Add-Type { throw 'test: Add-Type 已屏蔽' }
$global:inputs = New-Object System.Collections.Queue
$global:inputs.Enqueue([string][char]0x200B + ${q(TOKEN)})
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)][string]$Prompt)
  $v = $global:inputs.Dequeue()
  if ($AsSecureString) { return (ConvertTo-SecureString $v -AsPlainText -Force) }
  return $v }
try { & ${q(SCRIPT)} -Target preview -ApiBase 'http://127.0.0.1:${port}'; exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
    );
    const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    const code = await new Promise<number | null>((ok) => child.on('close', ok));
    await new Promise<void>((ok) => server.close(() => ok()));
    return { code, out, err, reqs, secrets };
  }

  const base = `/v1/projects/${PREVIEW_REF}`;
  const connRe = (role: string) =>
    new RegExp(`^postgresql://${role}\\.${PREVIEW_REF}:([A-Za-z0-9_-]{43})@aws-0-ap-northeast-2\\.pooler\\.supabase\\.com:6543/postgres\\?sslmode=require$`);
  // 失败路径的共同要求：退出码 1、finally 跑过、屏幕和错误里没有令牌和连接串
  function expectCleanFailure(r: { code: number | null; out: string; err: string }) {
    expect(r.code).toBe(1);
    expect(r.out).toContain(FINALLY);
    for (const s of [r.out, r.err]) {
      expect(s.includes(TOKEN)).toBe(false);
      expect(s.includes('TEST_ONLY')).toBe(false);
      expect(s.includes('postgresql://')).toBe(false);
    }
  }

  it('从头跑到尾：只发校验串、连接串格式对、原有 secrets 不少、屏幕不显示任何值', async () => {
    const { code, out, err, reqs, secrets } = await runScript();
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain(FINALLY);
    for (const r of reqs) expect(r.auth).toBe(`Bearer ${TOKEN}`);

    const sqls = reqs.filter((r) => r.path === `${base}/database/query`).map((r) => String(JSON.parse(r.body).query));
    expect(sqls).toHaveLength(5);
    expect(sqls[0]).toMatch(/^select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolreplication, rolcreatedb from pg_roles where rolname in \('fn_vault', 'fn_ai'\)/);
    expect(sqls[1]).toMatch(/from pg_auth_members m join pg_roles r on r\.oid = m\.member .* where r\.rolname in \('fn_vault', 'fn_ai'\)/);
    expect(sqls[4]).toBe(sqls[0]);
    const verRe = /^alter role (fn_vault|fn_ai) with login password '(SCRAM-SHA-256\$4096:([A-Za-z0-9+/]{22}==)\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=)'$/;
    const verifiers = new Map<string, { ver: string; salt: string }>();
    for (const s of sqls.slice(2, 4)) {
      const m = verRe.exec(s);
      expect(m, s.slice(0, 40)).not.toBeNull();
      verifiers.set(m?.[1] ?? '', { ver: m?.[2] ?? '', salt: m?.[3] ?? '' });
    }
    expect([...verifiers.keys()].sort()).toEqual(['fn_ai', 'fn_vault']);

    // 先写删占位 LEMO_PROBE，再写正式的两项
    const posts = reqs.filter((r) => r.method === 'POST' && r.path === `${base}/secrets`).map((r) => JSON.parse(r.body) as { name: string; value: string }[]);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual([{ name: 'LEMO_PROBE', value: 'probe-not-a-secret' }]);
    const dels = reqs.filter((r) => r.method === 'DELETE' && r.path === `${base}/secrets`);
    expect(dels.map((r) => JSON.parse(r.body))).toEqual([['LEMO_PROBE']]);
    expect(secrets.has('LEMO_PROBE')).toBe(false);
    const list = posts[1] ?? [];
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((x) => x.name).sort()).toEqual(['FN_AI_DB_URL', 'FN_VAULT_DB_URL']);
    for (const x of list) expect(Object.keys(x).sort()).toEqual(['name', 'value']);

    const pws: string[] = [];
    for (const [role, name] of [['fn_vault', 'FN_VAULT_DB_URL'], ['fn_ai', 'FN_AI_DB_URL']] as const) {
      const url = list.find((x) => x.name === name)?.value ?? '';
      const m = connRe(role).exec(url);
      expect(m, `${name} 格式（不显示值）`).not.toBeNull();
      const pw = m?.[1] ?? '';
      pws.push(pw);
      // 校验串确实由这个密码算出（独立实现）
      const v = verifiers.get(role);
      expect(scramNode(pw, b64(v?.salt ?? ''))).toBe(v?.ver);
      // 明文密码不在任何 SQL、任何请求路径里，也不在屏幕输出里
      for (const s of sqls) expect(s.includes(pw)).toBe(false);
      for (const r of reqs) expect(r.path.includes(pw)).toBe(false);
      expect(out.includes(pw)).toBe(false);
      expect(out.includes(url)).toBe(false);
    }
    expect(pws[0]).not.toBe(pws[1]);
    expect(verifiers.get('fn_vault')?.salt).not.toBe(verifiers.get('fn_ai')?.salt);
    expect(out.includes(TOKEN)).toBe(false);
    expect(out.includes('TEST_ONLY')).toBe(false);

    // 先后：核对项目 → 查角色 → 查成员关系 → 连接池 → 记下 secrets → 写删占位并核对 → alter ×2 → 再查角色 → 写 secrets → 核对
    const seq = reqs.map((r) => `${r.method} ${r.path.replace(base, '')}${r.path.endsWith('/query') ? ':' + String(JSON.parse(r.body).query).split(' ')[0] : ''}`);
    expect(seq).toEqual([
      'GET ',
      'POST /database/query:select',
      'POST /database/query:select',
      'GET /config/database/pooler',
      'GET /secrets',
      'POST /secrets',
      'DELETE /secrets',
      'GET /secrets',
      'POST /database/query:alter',
      'POST /database/query:alter',
      'POST /database/query:select',
      'POST /secrets',
      'GET /secrets',
    ]);
    expect([...secrets.keys()].sort()).toEqual(['FN_AI_DB_URL', 'FN_VAULT_DB_URL', 'GEMINI_API_KEY', 'PROXY_SECRET']);
    expect(out).toContain('已写入 Supabase：FN_VAULT_DB_URL、FN_AI_DB_URL');
  }, 120_000);

  it('alter 之后写 secrets 返回 400 并回显请求正文：退出码 1，屏幕和错误里没有密码、连接串、令牌，提示立刻重跑', async () => {
    const r = await runScript({ failSecretsPost: true });
    expectCleanFailure(r);
    const fnPost = r.reqs.find((x) => x.method === 'POST' && x.path === `${base}/secrets` && x.body.includes('FN_VAULT_DB_URL'));
    const list = JSON.parse(fnPost?.body ?? '[]') as { name: string; value: string }[];
    expect(list).toHaveLength(2);
    for (const x of list) {
      const pw = /:([A-Za-z0-9_-]{43})@/.exec(x.value)?.[1] ?? '';
      expect(pw).toHaveLength(43);
      expect(r.out.includes(pw) || r.err.includes(pw)).toBe(false);
    }
    expect(r.err).toContain(RERUN);
    expect(r.err).toContain('HTTP 400');
    expect(r.err).toContain('不显示对方的说明');
    expect(r.out).toContain(RERUN);
  }, 60_000);

  it('DELETE LEMO_PROBE 报错：停在改密码之前，提示到网页手动删 LEMO_PROBE（值不敏感）', async () => {
    const r = await runScript({ failDelete: true });
    expectCleanFailure(r);
    expect(r.err).toContain('HTTP 403');
    expect(r.err).toContain('请到 Supabase › Edge Functions › Secrets 手动删掉 LEMO_PROBE（值不敏感）');
    expect(r.err).not.toContain(RERUN);
    expect(r.reqs.some((x) => x.body.includes('alter role'))).toBe(false);
  }, 60_000);

  it('项目里本来就有 LEMO_PROBE：先提示会一并删掉，照常跑完，不算进原有 secrets', async () => {
    const r = await runScript({ leftoverProbe: true });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('发现上次留下的 LEMO_PROBE，会一并删掉');
    expect(r.secrets.has('LEMO_PROBE')).toBe(false);
    expect(r.out).toContain('原有的 2 个 secrets 都在');
  }, 120_000);

  it('第二个 alter 失败：退出码 1，没写 secrets，屏幕和错误里没有连接串、令牌，提示立刻重跑', async () => {
    const r = await runScript({ failAlter: 'fn_ai' });
    expectCleanFailure(r);
    expect(r.err).toContain(RERUN);
    expect(r.err).toContain('HTTP 500');
    expect(r.reqs.filter((x) => x.body.includes('alter role'))).toHaveLength(2);
    expect(r.reqs.some((x) => x.method === 'POST' && x.body.includes('FN_'))).toBe(false);
  }, 60_000);

  it('项目名不对：核对完就停，不查角色、不设密码', async () => {
    const r = await runScript({ projName: 'lemomemo-prod' });
    expectCleanFailure(r);
    expect(r.err).toContain('不是 lemomemo-preview');
    expect(r.err).not.toContain(RERUN);
    expect(r.reqs.map((x) => x.method + ' ' + x.path)).toEqual([`GET ${base}`]);
  }, 60_000);

  it('少一个角色：停在设密码之前', async () => {
    const r = await runScript({ roles: ['fn_vault'] });
    expectCleanFailure(r);
    expect(r.err).toContain('数据库里没有角色 fn_ai');
    expect(r.reqs.some((x) => x.body.includes('alter role'))).toBe(false);
    expect(r.reqs.some((x) => x.method === 'POST' && x.path.endsWith('/secrets'))).toBe(false);
  }, 60_000);

  it('fn 角色属于别的角色：停在设密码之前', async () => {
    const r = await runScript({ members: [{ member: 'fn_ai', granted: 'authenticated' }] });
    expectCleanFailure(r);
    expect(r.err).toContain('fn_ai 属于 authenticated');
    expect(r.reqs.some((x) => x.body.includes('alter role'))).toBe(false);
  }, 60_000);

  it('连接池接口没有事务模式那条：停在设密码之前，报清楚', async () => {
    const r = await runScript({ pools: [POOLS[0]] });
    expectCleanFailure(r);
    expect(r.err).toContain('没有返回事务模式');
    expect(r.reqs.some((x) => x.body.includes('alter role'))).toBe(false);
  }, 60_000);

  it('连接池的 identifier 或 db_user 对不上本项目：停在设密码之前', async () => {
    const a = await runScript({ pools: [pool('transaction', 6543, { identifier: 'abcdefghijklmnopqrst' })] });
    expectCleanFailure(a);
    expect(a.err).toContain('identifier 不是本项目的 ref');
    const b = await runScript({ pools: [pool('transaction', 6543, { db_user: 'postgres' })] });
    expectCleanFailure(b);
    expect(b.err).toContain('db_user 不是');
    for (const r of [a, b]) expect(r.reqs.some((x) => x.body.includes('alter role'))).toBe(false);
  }, 60_000);
});
