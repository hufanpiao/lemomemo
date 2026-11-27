// tools/backup/pull.ps1、backup-lib.ps1、restore-files.ps1、restore.mjs（架构第 10 节；TC-B7a-07 三道保险、TC-B7a-26 30 天保留、TC-B7a-06 只删那一个、TC-B7a-10 恢复脚本能跑）。
// 不连真实的 Supabase、R2，不用任何真实令牌、不碰凭据管理器：LEMO_BACKUP_TEST=1 时脚本只认 http://127.0.0.1 的地址、凭据从测试环境变量读。
// ① 点引用 backup-lib.ps1 直接测：三道保险逐个触发、点名放行只放过数量闸、删一个账号只删它的四处并记 删除记录.txt、超过 30 天的每日备份删掉、
//    SigV4 签名和 aws4fetch 算的一样；
// ② pull.ps1 从头跑到尾（本机假服务：真的 backup-manifest handle、签名下载、带 SigV4 校验的 S3）：目录 → 按日期一页页拿、拉完写心跳（B7a 复审第 5～8 条）、下载并核对 sha256、写 清单.json、R2 增量同步（第二次不重下）、
//    deleted_accounts 里的账号过三道保险（不放行退出 3 写 需要人工确认.txt，点名放行后只删它）、令牌错 401 退出 2、文件被改过不换进去、
//    输出里没有令牌和签名链接的查询串；
// ③ restore-files.ps1 试运行不传、-Execute 才传、远端一样的跳过；restore.mjs 命令行的参数和连接串检查（真库链路见 B7a 交回报告）。
// 需要 Windows PowerShell（Windows 上）或 pwsh；都没有就整组跳过。
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsV4Signer } from 'aws4fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle, type BackupFiles, type BackupStore, type BackupTable, type Deps } from '../../supabase/functions/backup-daily/core.ts';
import { handle as manifestHandle, type HeartbeatDetail, type Listed, type ManifestStore } from '../../supabase/functions/backup-manifest/core.ts';

const root = join(import.meta.dirname, '..', '..');
const LIB = join(root, 'tools', 'backup', 'backup-lib.ps1');
const PULL = join(root, 'tools', 'backup', 'pull.ps1');
const RFILES = join(root, 'tools', 'backup', 'restore-files.ps1');
const RESTORE = join(root, 'tools', 'backup', 'restore.mjs');

function findPs(): string | null {
  const cands = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const c of cands) {
    const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const PS = findPs();
// pull.ps1、register-pull-task.ps1 只在负责人的 Windows 上用 Windows PowerShell 5.1 跑（计划任务、publish.ps1 都写死 powershell.exe），
// 这两组端到端只在 Windows 上跑，和 publish-run-harness.ts 的 PS 同一个做法；Linux CI 上的 pwsh 7 不是它的运行环境
// （11-27 第一次进主线，unit 三个时区在 pwsh 上 9 条全挂、本机 powershell.exe 全过）。只点引用 backup-lib.ps1 的那组照旧两边都跑。
const WIN_PS = process.platform === 'win32' ? PS : null;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const O = '00000000-0000-4000-8000-0000000000aa';   // 负责人自己（protected_user_ids）
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const TOKEN = 't'.repeat(48);
const AK = 'TESTACCESSKEYID00001';
const SK = 'test-secret-access-key-not-real-0123456789';
const WAK = 'TESTWRITEKEYID000002';   // restore-files 的临时写令牌（假的）
const WSK = 'test-write-secret-not-real-9876543210abc';
const EMPTY = createHash('sha256').update('').digest('hex');
const TODAY = '2026-12-02';

let dir = '';
function writePs(name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, '\uFEFF' + text, 'utf8');
  return p;
}
/** 起 PowerShell（异步，假服务在同一进程里要能回应） */
function runPs(file: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const wrap = writePs(`wrap-${Math.random().toString(36).slice(2)}.ps1`,
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$OutputEncoding = [Text.Encoding]::UTF8\ntry { & ${q(file)} @args } catch { [Console]::Error.WriteLine('未捕获：' + $_); exit 99 }\nexit $LASTEXITCODE\n`);
  const child = spawn(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrap, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
  return new Promise((ok) => child.on('close', (code) => ok({ code, out, err })));
}
/** 点引用 backup-lib.ps1 跑一段，结果按 JSON 读回来 */
async function lib(body: string): Promise<unknown> {
  const f = writePs(`lib-${Math.random().toString(36).slice(2)}.ps1`, `$ErrorActionPreference = 'Stop'\n. ${q(LIB)}\n${body}\n`);
  const r = await runPs(f, []);
  expect(r.err).toBe('');
  return JSON.parse(r.out);
}

// ───── 用 backup-daily 真的 core 造备份文件 ─────
const TABLES: BackupTable[] = [
  { name: 'profiles', schema: 'public', lookupCol: 'user_id', keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1 },
  { name: 'notes', schema: 'public', lookupCol: 'user_id', keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 25_000 },
];
async function serverBackups(users: string[]): Promise<Map<string, Buffer>> {
  const files = new Map<string, Uint8Array>();
  let n = 0;
  const data: Record<string, Record<string, unknown>[]> = {
    profiles: users.map((u) => ({ user_id: u })),
    notes: users.flatMap((u) => Array.from({ length: 30 }, () => ({ id: `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`, user_id: u, body: 'x'.repeat(80) }))),
  };
  const store: BackupStore = {
    async readPage(t, u, after, limit) {
      const k = (r: Record<string, unknown>) => String(r[t.keyCol]);
      return (data[t.name] ?? []).filter((r) => r[t.lookupCol] === u && (after === null || k(r) > String(after))).sort((x, y) => (k(x) < k(y) ? -1 : 1)).slice(0, limit);
    },
    async writeHeartbeat() {}, async takeRate() { return true; },
  };
  const bucket: BackupFiles = {
    async list(d) { return [...files.keys()].filter((p) => p.startsWith(`${d}/`)).map((p) => ({ name: p.slice(d.length + 1), updatedAt: null })); },
    async read(p) { return files.get(p) ?? null; },
    async remove(ps) { for (const p of ps) files.delete(p); },
    async upload(p, b) { files.set(p, b); },
    async create(p, b) { if (files.has(p)) return false; files.set(p, b); return true; },
  };
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    cronSecret: 's'.repeat(40), store, files: bucket, tables: TABLES, isUsable: async () => true, project: 'abcdefghijklmnopqrst',
    next: async (b) => (await call(b)).status, background: (p) => { pending.push(p); }, now: () => Date.UTC(2026, 11, 1, 15, 30), log: () => {},
    limits: { segmentRawBytes: 1500, firstPage: 5, page: 8 },
  };
  const call = (body: unknown) => handle(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': 's'.repeat(40) }, body: JSON.stringify(body) }), deps);
  for (const u of users) { await call({ user_id: u }); while (pending.length) await pending.shift(); }
  return new Map([...files].map(([p, b]) => [p, Buffer.from(b)]));
}

// ───── 假服务：backup-manifest、签名下载、S3（校验 SigV4） ─────
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
/** 签名对得上就回用的是哪把（'ro' 只读拉取令牌、'rw' restore-files 的临时写令牌），对不上回 null */
function sigOk(req: IncomingMessage, body: Buffer | null): 'ro' | 'rw' | null {
  const auth = String(req.headers.authorization ?? '');
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=([0-9a-f]{64})$/.exec(auth);
  const which = m?.[1] === AK ? 'ro' : m?.[1] === WAK ? 'rw' : null;
  if (!m || !which) return null;
  const secret = which === 'ro' ? SK : WSK;
  const amz = String(req.headers['x-amz-date'] ?? '');
  const payload = String(req.headers['x-amz-content-sha256'] ?? '');
  if (payload !== 'UNSIGNED-PAYLOAD' && payload !== createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex')) return null;
  const [path = '', query = ''] = (req.url ?? '').split('?');
  const canonQ = query ? query.split('&').map((p) => p.split('=').map((x) => enc(decodeURIComponent(x))).join('=')).sort().join('&') : '';
  const creq = `${req.method}\n${path}\n${canonQ}\nhost:${req.headers.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amz}\n\nhost;x-amz-content-sha256;x-amz-date\n${payload}`;
  const sts = `AWS4-HMAC-SHA256\n${amz}\n${m[2]}/auto/s3/aws4_request\n${createHash('sha256').update(creq).digest('hex')}`;
  let k = hmac(`AWS4${secret}`, m[2] ?? '');
  for (const p of ['auto', 's3', 'aws4_request']) k = hmac(k, p);
  return hmac(k, sts).toString('hex') === m[3] ? which : null;
}

type World = {
  backups: Map<string, Buffer>; deleted: string[]; r2: Map<string, Buffer>; tamper?: string;
  seen: { path: string; auth: string }[]; badSig: number; gets: string[]; puts: string[];
  /** S3 请求用的哪把令牌：'GET ro'、'PUT rw' …（B7a 复审第 13 条） */
  keys: string[];
  /** backup-manifest 收到的请求体、写的心跳；now 不写就是 NOW_PULL（首尔 2026-12-02） */
  manifestBodies: unknown[]; beats: HeartbeatDetail[]; now?: number;
};
const NOW_PULL = Date.UTC(2026, 11, 2, 0, 5);
/** backup-manifest 的桶接到 w.backups：目录一层、签名链接指回假服务的 /storage/v1/object/sign/backups/ */
function manifestStore(w: World, base: string): ManifestStore {
  return {
    async list(dir) {
      const pre = dir ? `${dir}/` : '';
      const seen = new Map<string, Listed>();
      for (const [p, b] of w.backups) {
        if (!p.startsWith(pre)) continue;
        const [head = '', ...rest] = p.slice(pre.length).split('/');
        if (!seen.has(head)) seen.set(head, rest.length ? { name: head, folder: true, bytes: null, updatedAt: null } : { name: head, folder: false, bytes: b.byteLength, updatedAt: '2026-12-01T15:31:00Z' });
      }
      return [...seen.values()].sort((x, y) => (x.name < y.name ? -1 : 1));
    },
    async sign(paths) { return paths.map((p) => `${base}/storage/v1/object/sign/backups/${p}?token=SIGNED-SECRET`); },
    async deletedAccounts() { return w.deleted.map((u) => ({ user_id: u, deleted_at: '2026-12-01T00:00:00Z' })); },
    async takeRate() { return true; },
    async writeHeartbeat(d) { w.beats.push(d); },
  };
}
async function withServer<T>(w: World, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      w.seen.push({ path: url.pathname, auth: String(req.headers.authorization ?? '') });
      if (url.pathname === '/functions/v1/backup-manifest') {
        // 真的 backup-manifest handle（B7a 复审第 5 条：分页协议只此一份，假服务不再另写一份清单格式），桶换成 w.backups
        void manifestHandle(new Request(`http://x${url.pathname}`, { method: req.method ?? 'POST', headers: { authorization: String(req.headers.authorization ?? '') }, body: Buffer.concat(chunks) }), {
          pullToken: TOKEN, now: () => w.now ?? NOW_PULL, store: manifestStore(w, `http://${req.headers.host}`),
        }).then(async (r) => { w.manifestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text()); });
        return;
      }
      if (url.pathname.startsWith('/storage/v1/object/sign/backups/')) {
        const p = url.pathname.slice('/storage/v1/object/sign/backups/'.length);
        const b = w.backups.get(p);
        if (!b || url.searchParams.get('token') !== 'SIGNED-SECRET') { res.writeHead(400).end(); return; }
        res.writeHead(200).end(p === w.tamper ? Buffer.concat([b, Buffer.from([1])]) : b);
        return;
      }
      // S3：/<桶>?list-type=2… 或 /<桶>/<键>
      const body = Buffer.concat(chunks);
      const who = sigOk(req, req.method === 'PUT' ? null : body);
      if (!who) { w.badSig++; res.writeHead(403).end(); return; }
      w.keys.push(`${req.method} ${who}`);
      const [, bucket = '', ...rest] = url.pathname.split('/');
      const key = rest.map(decodeURIComponent).join('/');
      if (req.method === 'PUT') {
        if (who !== 'rw') { res.writeHead(403).end(); return; }   // 只读令牌传不了（和 R2 一样）
        w.puts.push(`${bucket}/${key}`); w.r2.set(`${bucket}/${key}`, body); res.writeHead(200).end(); return;
      }
      if (!key) {
        const all = [...w.r2.keys()].filter((k) => k.startsWith(`${bucket}/`)).sort();
        const start = url.searchParams.get('continuation-token') === 'page+2/=' ? 2 : 0;
        const page = all.slice(start, start + 2);
        const more = start + 2 < all.length && start === 0;
        const items = page.map((k) => {
          const b = w.r2.get(k) ?? Buffer.alloc(0);
          return `<Contents><Key>${k.slice(bucket.length + 1)}</Key><ETag>"${createHash('md5').update(b).digest('hex')}"</ETag><Size>${b.byteLength}</Size></Contents>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name>${items}<IsTruncated>${more}</IsTruncated>${more ? '<NextContinuationToken>page+2/=</NextContinuationToken>' : ''}</ListBucketResult>`);
        return;
      }
      w.gets.push(`${bucket}/${key}`);
      const b = w.r2.get(`${bucket}/${key}`);
      if (!b) { res.writeHead(404).end(); return; }
      res.writeHead(200).end(b);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { return await fn(base); } finally { await new Promise<void>((ok) => server.close(() => ok())); }
}

describe.skipIf(!PS)('tools/backup：三道保险、30 天保留、SigV4（点引用 backup-lib.ps1）', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lemo-backup-pull-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('TC-B7a-07 三道保险逐个触发：受保护名单、数量闸、双向对账，每道都拦住、一个都不删；点名放行只放过数量闸', async () => {
    const six = [O, A, B, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    const plan = (o: { deleted: string[]; today?: string[]; known?: boolean; local?: string[]; prot?: string[]; ok?: string[] }) =>
      `Get-DeletionPlan -Deleted @(${o.deleted.map(q).join(',')}) -ServerToday @(${(o.today ?? [O]).map(q).join(',')}) -TodayKnown $${o.known ?? true} -LocalUsers @(${(o.local ?? six).map(q).join(',')}) -Protected @(${(o.prot ?? [O]).map(q).join(',')}) -Approved @(${(o.ok ?? []).map(q).join(',')})`;
    const cases = {
      normal: plan({ deleted: [B] }),                                     // 1/6 ≤ 20%：删
      already: plan({ deleted: ['00000000-0000-4000-8000-0000000000ff'] }), // 本机没有：不算候选
      protectedHit: plan({ deleted: [O, B] }),                            // ①
      protectedEmpty: plan({ deleted: [B], prot: [] }),                   // ① 没配
      two: plan({ deleted: [A, B] }),                                     // ② 超过 1 个
      pct: plan({ deleted: [B], local: [O, A, B] }),                      // ② 1/3 超过 20%
      pctApproved: plan({ deleted: [B], local: [O, A, B], ok: [B] }),     // ② 点名放行
      stillToday: plan({ deleted: [B], today: [O, B] }),                  // ③ 还在当天名单里
      todayUnknown: plan({ deleted: [B], known: false }),                 // ③ 当天名单拿不到
      approvedButToday: plan({ deleted: [B], today: [O, B], local: [O, A, B], ok: [B] }), // 放行不放过 ③
    };
    const out = await lib(`$r = [ordered]@{}\n${Object.entries(cases).map(([k, v]) => `$p = ${v}; $r['${k}'] = @{ del = @($p.Delete); n = @($p.Problems).Count; why = (@($p.Problems) -join ' | ') }`).join('\n')}\n$r | ConvertTo-Json -Depth 4 -Compress`) as Record<string, { del: string[]; n: number; why: string }>;
    expect(out.normal).toEqual({ del: [B], n: 0, why: '' });
    expect(out.already).toEqual({ del: [], n: 0, why: '' });
    for (const k of ['protectedHit', 'protectedEmpty', 'two', 'pct', 'stillToday', 'todayUnknown', 'approvedButToday']) {
      expect(out[k]?.del, k).toEqual([]);
      expect(out[k]?.n, k).toBeGreaterThan(0);
    }
    expect(out.protectedHit?.why).toContain('①');
    expect(out.protectedEmpty?.why).toContain('protected_user_ids');
    expect(out.two?.why).toContain('②');
    expect(out.pct?.why).toContain('②');
    expect(out.pctApproved).toEqual({ del: [B], n: 0, why: '' });
    expect(out.stillToday?.why).toContain('③');
    expect(out.todayUnknown?.why).toContain('③');
    expect(out.approvedButToday?.why).toContain('③');
    expect(out.approvedButToday?.why).not.toContain('②');
  }, 60_000);

  it('TC-B7a-06 删一个账号：每日、发布前、图片、附件四处只删它的，删除记录.txt 只有 user_id 和日期', async () => {
    const r = join(dir, 'rm');
    for (const p of [`每日/2026-11-30/${A}`, `每日/2026-11-30/${B}`, `每日/2026-12-01/${B}`, `发布前/2026-11-01_v4.0.0/${B}`, `发布前/2026-11-01_v4.0.0/${A}`, `图片/${B}/images`, `附件/${B}/files`, `图片/${A}/images`]) {
      mkdirSync(join(r, p), { recursive: true });
      writeFileSync(join(r, p, 'x.json.gz'), 'x');
    }
    const out = await lib(`$n = Remove-UserEverywhere ${q(r)} ${q(B)} ([datetime]'2026-12-02T09:00:00'); @{ n = $n; left = @(Get-LocalUserIds ${q(r)}) } | ConvertTo-Json -Compress`) as { n: number; left: string[] };
    expect(out).toEqual({ n: 5, left: [A] });
    const log = readFileSync(join(r, '删除记录.txt'), 'utf8');
    expect(log).toMatch(new RegExp(`^\\uFEFF?2026-12-02 09:00 删除 ${B}（5 处：`));
    expect(log).not.toContain(A);
  }, 60_000);

  it('TC-B7a-26 把日期推到 31 天后：超过 30 天的每日备份删掉，发布前的不动', async () => {
    const r = join(dir, 'keep');
    for (const d of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-12-01']) mkdirSync(join(r, '每日', d, A), { recursive: true });
    mkdirSync(join(r, '发布前', '2026-10-01_v4.0.0', A), { recursive: true });
    const out = await lib(`@{ gone = @(Remove-OldDaily ${q(r)} ([datetime]'2026-12-02')) } | ConvertTo-Json -Compress`) as { gone: string[] };
    expect(out.gone).toEqual(['2026-10-31', '2026-11-01']);
    expect(readdirSync(join(r, '每日')).sort()).toEqual(['2026-11-02', '2026-12-01']);
    expect(existsSync(join(r, '发布前', '2026-10-01_v4.0.0', A))).toBe(true);
  }, 60_000);

  it('SigV4：和 aws4fetch 对同一个请求算出的 Authorization 一样（带要编码的续页令牌）', async () => {
    const url = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/images?continuation-token=a%2Bb%2Fc%3D&list-type=2&max-keys=1000';
    const signer = new AwsV4Signer({ url, method: 'GET', accessKeyId: AK, secretAccessKey: SK, service: 's3', region: 'auto', datetime: '20261202T010203Z', headers: { 'x-amz-content-sha256': EMPTY } });
    const want = (await signer.sign()).headers.get('authorization');
    const out = await lib(`$h = Get-SigV4Headers '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com' '/images' 'continuation-token=a%2Bb%2Fc%3D&list-type=2&max-keys=1000' ${q(AK)} ${q(SK)} ([datetime]::new(2026,12,2,1,2,3,[DateTimeKind]::Utc)); @{ a = $h['Authorization']; e = (ConvertTo-S3Encoded 'a+b/c= ~') } | ConvertTo-Json -Compress`) as { a: string; e: string };
    expect(out.a).toBe(want);
    expect(out.e).toBe('a%2Bb%2Fc%3D%20~');
  }, 60_000);
});

describe.skipIf(!WIN_PS)('B7a 复审第 8 条：09:00 计划任务、90 天轮换提醒', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lemo-backup-rotate-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('register-pull-task.ps1 -PrintOnly：每天 09:00 跑本仓库的 pull.ps1、错过了开机补跑、只用当前用户登录时的权限、不注册', () => {
    const r = spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', 'backup', 'register-pull-task.ps1'), '-PrintOnly'], { encoding: 'utf8' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    const p = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(p).toMatchObject({
      task: 'lemomemo-backup-pull', arguments: `-NoProfile -ExecutionPolicy Bypass -File "${join(root, 'tools', 'backup', 'pull.ps1')}"`, workdir: root,
      at: '09:00', days_interval: 1, start_when_available: true, battery: true, limit: 'PT2H', multiple: 'IgnoreNew',
      logon: 'Interactive', run_level: 'Limited', user_is_me: true,
    });
    expect(String(p['execute']).toLowerCase().endsWith('\\system32\\windowspowershell\\v1.0\\powershell.exe')).toBe(true);
  }, 60_000);

  it('Get-RotateNote：凭据写入满 90 天才提示（89 天不提示），测试模式没有写入时刻不提示', async () => {
    const out = await lib(`$now = [datetime]::new(2026, 12, 2, 0, 0, 0, [DateTimeKind]::Utc)
@{ d89 = Get-RotateNote $now.AddDays(-89.9) $now; d90 = Get-RotateNote $now.AddDays(-90) $now; none = Get-RotateNote $null $now } | ConvertTo-Json -Compress`) as { d89: string | null; d90: string | null; none: string | null };
    expect([out.d89, out.none]).toEqual([null, null]);
    expect(out.d90).toContain('已经用了 90 天');
    expect(out.d90).toContain('set-backup-pull-token.ps1 -Target prod');
  }, 60_000);
});

describe.skipIf(!WIN_PS)('pull.ps1 从头跑到尾（本机假服务）', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lemo-backup-pull-run-')); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const env = (base: string) => ({
    LEMO_BACKUP_TEST: '1', LEMO_BACKUP_TEST_MANIFEST: `${base}/functions/v1/backup-manifest`, LEMO_BACKUP_TEST_TOKEN: TOKEN,
    LEMO_BACKUP_TEST_R2_ID: AK, LEMO_BACKUP_TEST_R2_SECRET: SK, LEMO_BACKUP_TEST_POLL: '0',
  });
  const setupRoot = (name: string, base: string) => {
    const r = join(dir, name);
    mkdirSync(r, { recursive: true });
    writeFileSync(join(r, '配置.json'), JSON.stringify({ protected_user_ids: [O], r2_endpoint: base, r2_bucket_prefix: '' }));
    return r;
  };
  const r2Objects = () => new Map<string, Buffer>([
    [`images/${A}/n1/i1.webp`, Buffer.from('img-a-1')], [`images/${A}/n1/i2.webp`, Buffer.from('img-a-2')], [`images/${A}/n2/i3.webp`, Buffer.from('img-a-3')],
    [`files/${A}/n1/f1.pdf`, Buffer.from('pdf-a')], [`vault-files/${B}/n9/v1.pdf`, Buffer.from('enc-b')], [`images/${B}/me/av.webp`, Buffer.from('av-b')],
  ]);
  const world = async (deleted: string[] = []): Promise<World> => ({
    backups: await serverBackups([O, A, B]), deleted, r2: r2Objects(), seen: [], badSig: 0, gets: [], puts: [], keys: [], manifestBodies: [], beats: [],
  });
  const noLeak = (s: string) => {
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain('SIGNED-SECRET');
    expect(s).not.toContain(SK);
  };

  it('下载、核对 sha256、写 清单.json、同步 R2（续页、SigV4 都对），第二次不重下；退出 0', async () => {
    const w = await world();
    await withServer(w, async (base) => {
      const r = setupRoot('ok', base);
      const first = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SyncFiles'], env(base));
      expect([first.code, first.err]).toEqual([0, '']);
      noLeak(first.out);
      for (const u of [O, A, B]) {
        const files = readdirSync(join(r, '每日', TODAY, u)).sort();
        expect(files).toEqual([...w.backups.keys()].filter((p) => p.startsWith(`${TODAY}/${u}/`)).map((p) => p.split('/')[2]).sort());
        for (const f of files) expect(readFileSync(join(r, '每日', TODAY, u, f))).toEqual(w.backups.get(`${TODAY}/${u}/${f}`));
      }
      const idx = JSON.parse(readFileSync(join(r, '每日', TODAY, '清单.json'), 'utf8').replace(/^\uFEFF/, '')) as { 日期: string; 账号: { user_id: string }[] };
      expect([idx.日期, idx.账号.map((x) => x.user_id).sort()]).toEqual([TODAY, [O, A, B].sort()]);
      expect(readFileSync(join(r, '图片', A, 'images', 'n2', 'i3.webp'), 'utf8')).toBe('img-a-3');
      expect(readFileSync(join(r, '附件', A, 'files', 'n1', 'f1.pdf'), 'utf8')).toBe('pdf-a');
      expect(readFileSync(join(r, '附件', B, 'vault-files', 'n9', 'v1.pdf'), 'utf8')).toBe('enc-b');
      expect(readFileSync(join(r, '图片', B, 'images', 'me', 'av.webp'), 'utf8')).toBe('av-b');
      expect(w.badSig).toBe(0);
      expect(w.gets.length).toBe(6);
      // 第二次：每日已有的不重下，R2 按 ETag 一个都不重下；远端改了一个的只下那一个
      w.r2.set(`images/${A}/n1/i1.webp`, Buffer.from('img-a-1-v2'));
      const gets = w.gets.length;
      const second = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SyncFiles'], env(base));
      expect(second.code).toBe(0);
      expect(second.out).toContain('新下 0 份、已有 3 份');
      expect(w.gets.slice(gets)).toEqual([`images/${A}/n1/i1.webp`]);
      expect(readFileSync(join(r, '图片', A, 'images', 'n1', 'i1.webp'), 'utf8')).toBe('img-a-1-v2');
      // 远端删了的：本机先留着，满 30 天才删（TC-B7a-26 图片、附件同样 30 天）
      w.r2.delete(`images/${A}/n2/i3.webp`);
      expect((await runPs(PULL, ['-Root', r, '-Today', '2026-12-03', '-SyncFiles'], env(base))).code).toBe(0);
      expect(existsSync(join(r, '图片', A, 'images', 'n2', 'i3.webp'))).toBe(true);
      expect((await runPs(PULL, ['-Root', r, '-Today', '2027-01-03', '-SyncFiles'], env(base))).code).toBe(0);
      expect(existsSync(join(r, '图片', A, 'images', 'n2', 'i3.webp'))).toBe(false);
      expect(existsSync(join(r, '图片', A, 'images', 'n1', 'i1.webp'))).toBe(true);
      // 2027-01-03 再跑时 2026-12-02 的每日备份超过 30 天，删掉
      expect(existsSync(join(r, '每日', TODAY))).toBe(false);
    });
  }, 120_000);

  it('B7a 复审第 5、7、8 条：不带 -Today 用服务器给的首尔今天；按日期一页页拿（第 51 个人在第二页）；全部成功才写心跳 backup-pull', async () => {
    const w = await world();
    const many = Array.from({ length: 55 }, (_, i) => `00000000-0000-4000-8000-${(0x100 + i).toString(16).padStart(12, '0')}`);
    for (const u of many) w.backups.set(`2026-11-30/${u}/a_profiles.json.gz`, Buffer.from('half'));   // 早几天没做完的：不下载、不算失败
    await withServer(w, async (base) => {
      const r = setupRoot('pages', base);
      const res = await runPs(PULL, ['-Root', r, '-SkipFiles'], env(base));
      expect([res.code, res.err]).toEqual([0, '']);
      expect(res.out).toContain('新下 3 份');
      expect(existsSync(join(r, '每日', TODAY, A, '_manifest.json.gz'))).toBe(true);
      expect(existsSync(join(r, '每日', '2026-11-30'))).toBe(false);
      expect(w.manifestBodies).toEqual([
        {}, { date: '2026-11-30', after: null, wait: false }, { date: '2026-11-30', after: many[49], wait: false },
        { date: TODAY, after: null, wait: false }, { done: true },
      ]);
      expect(w.beats).toEqual([{ accounts: 55, pull_calls: 5, pull_limit: 300, wait_pages: 1, wait_limit: 600 }]);
      // 服务器已经过了首尔零点（12-03）、当天还没有目录：今天按服务器算，当天的人一个都没有（三道保险按“当天名单不知道”处理）
      w.now = Date.UTC(2026, 11, 2, 15, 1);
      w.manifestBodies.length = 0;
      expect((await runPs(PULL, ['-Root', r, '-SkipFiles'], env(base))).code).toBe(0);
      expect(w.manifestBodies.filter((b) => (b as { date?: string }).date === '2026-12-03')).toEqual([]);
    });
  }, 120_000);

  it('TC-B7a-06、07 deleted_accounts 里有 B：本机只剩 3 个账号（1/3 超过 20%）先拦下退出 3、写 需要人工确认.txt；点名放行后只删 B', async () => {
    const w = await world();
    await withServer(w, async (base) => {
      const r = setupRoot('del', base);
      expect((await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SyncFiles'], env(base))).code).toBe(0);
      // B 注销满 7 天：服务器删了它的备份、写了 deleted_accounts
      for (const k of [...w.backups.keys()]) if (k.includes(`/${B}/`)) w.backups.delete(k);
      for (const k of [...w.r2.keys()]) if (k.includes(`/${B}/`) || k.split('/')[1] === B) w.r2.delete(k);
      w.deleted = [B];
      const held = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles'], env(base));
      expect(held.code).toBe(3);
      expect(readFileSync(join(r, '需要人工确认.txt'), 'utf8')).toContain('②');
      expect(existsSync(join(r, '每日', TODAY, B))).toBe(true);
      expect(existsSync(join(r, '删除记录.txt'))).toBe(false);
      const ok = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles', '-ApproveDeletion', B], env(base));
      expect([ok.code, ok.err]).toEqual([0, '']);
      for (const p of [join('每日', TODAY, B), join('图片', B), join('附件', B)]) expect(existsSync(join(r, p)), p).toBe(false);
      for (const p of [join('每日', TODAY, A), join('每日', TODAY, O), join('图片', A)]) expect(existsSync(join(r, p)), p).toBe(true);
      const log = readFileSync(join(r, '删除记录.txt'), 'utf8');
      expect(log).toContain(B);
      expect(log).not.toContain(A);
      // 受保护的账号出现在 deleted_accounts：不删，拦下
      w.deleted = [B, O];
      expect((await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles'], env(base))).code).toBe(3);
      expect(existsSync(join(r, '每日', TODAY, O))).toBe(true);
    });
  }, 120_000);

  it('令牌不对：backup-manifest 401、退出 2、写 失败原因.txt，输出里没有令牌', async () => {
    const w = await world();
    await withServer(w, async (base) => {
      const r = setupRoot('bad', base);
      const res = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles'], { ...env(base), LEMO_BACKUP_TEST_TOKEN: 'x'.repeat(48) });
      expect(res.code).toBe(2);
      expect(res.err).toContain('401');
      expect(readFileSync(join(r, '失败原因.txt'), 'utf8')).toContain('401');
      noLeak(res.out + res.err + readFileSync(join(r, '失败原因.txt'), 'utf8'));
      expect(existsSync(join(r, '每日'))).toBe(false);
    });
  }, 60_000);

  it('下载的文件和 _manifest 的 sha256 对不上：这个人这一天不换进去、退出 2；其他人照常', async () => {
    const w = await world();
    w.tamper = [...w.backups.keys()].find((p) => new RegExp(`^${TODAY}/${A}/[ab]_notes\\.`).test(p)) ?? '';
    expect(w.tamper).not.toBe('');
    await withServer(w, async (base) => {
      const r = setupRoot('tamper', base);
      const res = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles'], env(base));
      expect(res.code).toBe(2);
      expect(readFileSync(join(r, '失败原因.txt'), 'utf8')).toContain('sha256');
      expect(existsSync(join(r, '每日', TODAY, A))).toBe(false);
      expect(readdirSync(join(r, '每日', TODAY)).filter((n) => n.startsWith('.'))).toEqual([]);
      expect(existsSync(join(r, '每日', TODAY, O, '_manifest.json.gz'))).toBe(true);
      expect(w.beats).toEqual([]);   // 有失败：不写心跳（lemo-ops 26 小时后报“停了”）
    });
  }, 60_000);

  it('-WaitForToday -Snapshot：当天都做完了才往下走，复制一份到 发布前\\<日期>_<tag>\\（已有不覆盖）', async () => {
    const w = await world();
    await withServer(w, async (base) => {
      const r = setupRoot('snap', base);
      const res = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles', '-WaitForToday', '-ExpectCount', '3', '-Since', '2026-11-01T00:00:00Z', '-WaitMinutes', '1', '-Snapshot', 'v4.0.0'], env(base));
      expect([res.code, res.err, res.out]).toEqual([0, '', expect.any(String)]);
      expect(readdirSync(join(r, '发布前', `${TODAY}_v4.0.0`)).sort()).toEqual([O, A, B, '清单.json'].sort());
      // 等待用不签名的页（单独计数，B7a 复审第 6 条）
      expect(w.manifestBodies.slice(0, 2)).toEqual([{}, { date: TODAY, after: null, wait: true }]);
      const again = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles', '-Snapshot', 'v4.0.0'], env(base));
      expect(again.code).toBe(1);
      // 当天的 _manifest 比触发时刻早（还是 00:30 那份）：等到超时退出 2
      const late = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles', '-WaitForToday', '-ExpectCount', '3', '-Since', '2026-12-02T01:00:00Z', '-WaitMinutes', '0'], env(base));
      expect(late.code).toBe(2);
      expect(late.err).toContain('0/3');
      // -WaitForToday 不带 -ExpectCount：本机参数错，退出 1
      expect((await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles', '-WaitForToday', '-WaitMinutes', '0'], env(base))).code).toBe(1);
    });
  }, 120_000);

  it('B7a 评审第 7、8 条：只等这次发了请求的人；当天别的没做完的只记提示、不挡 -Snapshot；-SkipCleanup 跳过三道保险（不会退出 3）', async () => {
    const w = await world();
    // 当天还有一个只留下半截的人（这次没发请求：停用或早先没做完），没有 _manifest
    const C = '00000000-0000-4000-8000-00000000000c';
    w.backups.set(`${TODAY}/${C}/a_profiles.json.gz`, Buffer.from('half'));
    w.deleted = [B];   // 本机只有 3 个账号时会被数量闸拦下（退出 3）
    await withServer(w, async (base) => {
      const r = setupRoot('expect', base);
      const res = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles', '-SkipCleanup', '-WaitForToday', '-ExpectCount', '2', '-Since', '2026-11-01T00:00:00Z', '-WaitMinutes', '1', '-Snapshot', 'v4.0.1'], env(base));
      expect([res.code, res.err]).toEqual([0, '']);
      expect(res.out).toContain('-SkipCleanup');
      expect(readFileSync(join(r, '失败原因.txt'), 'utf8')).toContain('提示');
      expect(existsSync(join(r, '每日', TODAY, C))).toBe(false);
      expect(existsSync(join(r, '需要人工确认.txt'))).toBe(false);
      expect(readdirSync(join(r, '发布前', `${TODAY}_v4.0.1`)).sort()).toEqual([O, A, '清单.json'].sort());   // B 在 deleted_accounts 里不下载
    });
  }, 120_000);

  it('B7a 评审第 4、9 条：本机文件大小一样但内容变了也重下（比 sha256）；换目录先改名旧的，不留 .旧- 和 .下载中- 残留', async () => {
    const w = await world();
    await withServer(w, async (base) => {
      const r = setupRoot('sha', base);
      expect((await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles'], env(base))).code).toBe(0);
      const userDir = join(r, '每日', TODAY, A);
      const f = readdirSync(userDir).find((n) => /^[ab]_notes\.1\.json\.gz$/.test(n)) ?? '';
      expect(f).not.toBe('');
      const good = readFileSync(join(userDir, f));
      writeFileSync(join(userDir, f), Buffer.alloc(good.byteLength, 7));   // 同样大小、内容不同
      const again = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles'], env(base));
      expect(again.code).toBe(0);
      expect(again.out).toContain('新下 1 份、已有 2 份');
      expect(readFileSync(join(userDir, f))).toEqual(good);
      expect(readdirSync(join(r, '每日', TODAY)).filter((n) => n.startsWith('.'))).toEqual([]);
      // 上一次换目录停在半路（旧的改了名、新的没换进来）：下次先把旧的改回来再比
      renameSync(userDir, join(r, '每日', TODAY, `.旧-${A}`));
      const third = await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SkipFiles'], env(base));
      expect(third.code).toBe(0);
      expect(third.out).toContain('新下 0 份、已有 3 份');
      expect(readdirSync(join(r, '每日', TODAY)).filter((n) => n.startsWith('.'))).toEqual([]);
    });
  }, 120_000);

  it('restore-files.ps1：试运行只用只读令牌、不要写令牌、不传；-Execute 列远端用只读、PUT 才用写令牌，只传远端没有或不一样的，路径和本机一致（B7a 复审第 13 条）', async () => {
    const w = await world();
    await withServer(w, async (base) => {
      const r = setupRoot('rf', base);
      expect((await runPs(PULL, ['-Root', r, '-Today', TODAY, '-SyncFiles'], env(base))).code).toBe(0);
      // R2 里 A 的两个对象丢了、一个被改了
      w.r2.delete(`images/${A}/n1/i1.webp`);
      w.r2.delete(`files/${A}/n1/f1.pdf`);
      w.r2.set(`images/${A}/n1/i2.webp`, Buffer.from('broken'));
      w.keys.length = 0;
      const writeKey = { LEMO_BACKUP_TEST_R2_WRITE_ID: WAK, LEMO_BACKUP_TEST_R2_WRITE_SECRET: WSK };
      // 试运行：环境里没有写令牌也照样跑完
      const dry = await runPs(RFILES, ['-User', A, '-Root', r], env(base));
      expect([dry.code, dry.err]).toEqual([0, '']);
      expect(dry.out).toContain('要传 3 个');
      expect(dry.out).toContain('只用了只读令牌');
      expect(w.puts).toEqual([]);
      expect(new Set(w.keys)).toEqual(new Set(['GET ro']));
      // -Execute 没给写令牌：列完、打印要传几个，停在传之前
      const noKey = await runPs(RFILES, ['-User', A, '-Root', r, '-Execute'], env(base));
      expect(noKey.code).toBe(1);
      expect(noKey.out).toContain('要传 3 个');
      expect(noKey.err).toContain('没有写令牌');
      expect(w.puts).toEqual([]);
      // -Execute 给了写令牌
      w.keys.length = 0;
      const run = await runPs(RFILES, ['-User', A, '-Root', r, '-Execute'], { ...env(base), ...writeKey });
      expect([run.code, run.err]).toEqual([0, '']);
      expect(w.puts.sort()).toEqual([`files/${A}/n1/f1.pdf`, `images/${A}/n1/i1.webp`, `images/${A}/n1/i2.webp`]);
      expect(w.r2.get(`images/${A}/n1/i2.webp`)?.toString()).toBe('img-a-2');
      expect(new Set(w.keys)).toEqual(new Set(['GET ro', 'PUT rw']));
      expect(w.keys.filter((k) => k === 'PUT rw')).toHaveLength(3);
      // 远端都一样了：不要写令牌也退出码 0
      const again = await runPs(RFILES, ['-User', A, '-Root', r, '-Execute'], env(base));
      expect([again.code, again.out.includes('不用传')]).toEqual([0, true]);
      expect(w.badSig).toBe(0);
      noLeak(run.out);
      for (const s of [WAK, WSK]) expect(run.out + run.err).not.toContain(s);
    });
  }, 120_000);

  it('restore-files.ps1 静态：平时只读令牌从凭据管理器 lemomemo.backup.r2-pull 读（经 cred.ps1），写令牌在“试运行就退出”那一行之后才问', () => {
    const src = readFileSync(RFILES, 'utf8');
    expect(src).toContain(". (Join-Path $PSScriptRoot '..\\keys\\cred.ps1')");
    expect(src).toContain("Read-LemoCred 'lemomemo.backup.r2-pull'");
    const dryExit = src.indexOf("if (-not $Execute) {");
    const ask = src.indexOf("Read-Secret '粘贴临时写令牌");
    expect(dryExit).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(dryExit);
    expect(src.match(/Read-Secret '/g)).toHaveLength(2);
    expect(src).not.toMatch(/Read-Host -AsSecureString '/);
  });
});

describe('restore.mjs 命令行（TC-B7a-10）', () => {
  let d = '';
  beforeAll(() => { d = mkdtempSync(join(tmpdir(), 'lemo-backup-restore-cli-')); });
  afterAll(() => { if (d) rmSync(d, { recursive: true, force: true }); });

  const runNode = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((ok) => {
    const child = spawn(process.execPath, [RESTORE, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LEMO_RESTORE_DB_URL: '', ...env } });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    child.on('close', (code) => ok({ code, out, err }));
  });

  // 真库上的试运行、正式执行（含隐私记和 AI 记忆）在本机 lemo-e2e 跑，证据写在 B7a 交回报告里；这里只测不连库就能判的
  it('参数和连接串：--url 不再收；没有连接串（不是终端）、连接串不认识都退出 1，连不上库退出 2；连接串不打印', async () => {
    const backups = await serverBackups([A]);
    const from = join(d, A);
    mkdirSync(from, { recursive: true });
    for (const [p, b] of backups) if (p.startsWith(`${TODAY}/${A}/`)) writeFileSync(join(from, p.split('/')[2] ?? ''), b);
    const url = await runNode(['--user', A, '--from', from, '--url', 'http://127.0.0.1:1', '--dry-run'], {});
    expect([url.code, url.err.includes('--url 不用了')]).toEqual([1, true]);
    const none = await runNode(['--user', A, '--from', from, '--dry-run'], {});
    expect([none.code, none.err.includes('no_db_url')]).toEqual([1, true]);
    const bad = await runNode(['--user', A, '--from', from, '--dry-run'], { LEMO_RESTORE_DB_URL: 'https://not-a-db.example/pw-SECRET' });
    expect(bad.code).toBe(1);
    const local = 'postgresql://postgres:pw-SECRET@127.0.0.1:1/postgres';
    const noConfirm = await runNode(['--user', A, '--from', from], { LEMO_RESTORE_DB_URL: local });
    expect([noConfirm.code, noConfirm.err.includes('--confirm local')]).toEqual([1, true]);
    const wrongUser = await runNode(['--user', B, '--from', from, '--dry-run'], { LEMO_RESTORE_DB_URL: local });
    expect([wrongUser.code, wrongUser.err.includes('wrong_user')]).toEqual([1, true]);
    const down = await runNode(['--user', A, '--from', from, '--dry-run'], { LEMO_RESTORE_DB_URL: local });
    expect(down.code).toBe(2);
    for (const s of [bad.out, bad.err, noConfirm.err, down.out, down.err]) expect(s).not.toContain('SECRET');
  }, 60_000);
});
