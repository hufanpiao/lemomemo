// tools/e2e/export-load-preview.mjs 的整条流程单测（TC-B1-141 ①～⑧；安全审查“预览实测脚本”D2、E4）：
// run() 的 fetch、输出、信号、退出都换成替身——替身后端在内存里模拟 Supabase 的管理接口、REST、db_size_bytes 和 account 函数，
// 行内容、验证码、令牌、service key 都设成标记串，跑完查全部输出里找不到。不连任何库、不起子进程、不写文件。
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errText, HAND_OVER, NOT_CLEANED, run, targetOk } from '../../tools/e2e/export-load-preview.mjs';
import { EXPORT_TABLES, NEXT } from '../../tools/e2e/export-load-lib.mjs';
import { PREVIEW_REF, TEST_EMAIL } from '../../tools/e2e/export-load-preview-guards.mjs';

const MB = 1048576;
const UID = '11111111-2222-4333-8444-555555555555';
const EID = '99999999-2222-4333-8444-555555555555';
const DB_AT = '2026-10-31T01:00:00.000000+00:00';
const MARK = { key: 'MARK-SERVICE-KEY-7f3a', jwt: 'MARK-USER-JWT-91c2', otp: 'MARK-OTP-4410', row: 'MARK-ROW-CONTENT-55e1', email: 'MARK-EMAIL@x.test' };
const PREVIEW = { base: `https://${PREVIEW_REF}.supabase.co`, key: MARK.key, label: 'preview' };

interface Opts {
  dbBytes?: number; createdAt?: string; emailExists?: boolean; fetchedEmail?: string; admins?: string[]; seedFailAt?: string;
  deleteFails?: boolean; badLinkJson?: boolean; user?: { id: string; email: string; created_at: string }; onSeed?: (t: string) => void;
  /** account 一共回几片（默认 1）；onPart 在第 n 片（从 1 数）请求到达时调 */
  parts?: number; onPart?: (n: number) => void;
}

/** 内存里的替身后端：只认脚本会调的那几个接口；calls 记“方法 路径”，fnAuth 记调 account 时带的头 */
function fakeBackend(o: Opts = {}) {
  const st = {
    calls: [] as string[], fnHeaders: [] as Record<string, string>[], email: '', rows: {} as Record<string, unknown[]>, countersGone: false, partCalls: 0,
    user: (o.user ?? null) as { id: string; email: string; created_at: string } | null,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const m = init.method ?? 'GET';
    const p = u.pathname;
    st.calls.push(`${m} ${p}`); if (!(init.signal instanceof AbortSignal)) st.calls.push('NO_SIGNAL');   // 每个请求都要带超时
    const body = typeof init.body === 'string' ? init.body : '';
    if (p === '/rest/v1/rpc/db_size_bytes') return json(200, [{ bytes: o.dbBytes ?? 100 * MB, at: DB_AT }]);
    if (p === '/auth/v1/admin/users' && m === 'POST') {
      if (o.emailExists) return json(422, { code: 'email_exists', msg: `${MARK.row} ${MARK.email}` });
      st.email = (JSON.parse(body) as { email: string }).email;
      st.user = { id: UID, email: st.email, created_at: o.createdAt ?? '2026-10-31T01:00:01Z' };
      return json(200, { ...st.user, marker: MARK.row });
    }
    if (p === `/auth/v1/admin/users/${UID}`) {
      if (m === 'DELETE') {
        if (o.deleteFails) return json(500, { msg: MARK.row });
        st.user = null;
        st.rows = {};
        return json(200, {});
      }
      return st.user ? json(200, { ...st.user, email: o.fetchedEmail ?? st.user.email }) : json(404, { code: 'user_not_found' });
    }
    if (p === '/rest/v1/admins') return json(200, (o.admins ?? []).map((id) => ({ user_id: id })));
    if (p === '/rest/v1/counters') {
      if (m === 'DELETE') { st.countersGone = true; return new Response(null, { status: 204 }); }
      if (st.countersGone || !st.user) return json(200, []);
      return json(200, ['account', 'export-size', 'export-part', 'export-job'].map((k) => ({ key: `${k}:${UID}:x`, count: 1 })));
    }
    if (p === '/rest/v1/logs' && m === 'GET') return json(200, [{ act: 'export' }, { act: 'export_done' }]);
    if (m === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${st.user ? (st.rows[p.slice(9)]?.length ?? 0) : 0}` } });
    if (p.startsWith('/rest/v1/') && m === 'POST') {
      const t = p.slice(9);
      o.onSeed?.(t);
      if (o.seedFailAt === t) return json(500, { message: MARK.row });
      (st.rows[t] ??= []).push(...(JSON.parse(body) as unknown[]));
      return new Response(null, { status: 201 });
    }
    if (p === '/auth/v1/admin/generate_link') return o.badLinkJson ? new Response(`{"email": "${MARK.email}", "x":`, { status: 200 }) : json(200, { hashed_token: MARK.otp, properties: { email_otp: MARK.otp } });
    if (p === '/auth/v1/verify') return json(200, { access_token: MARK.jwt, user: { email: st.email } });
    if (p === '/functions/v1/account') {
      st.fnHeaders.push(Object.fromEntries(new Headers(init.headers).entries()));
      const b = JSON.parse(body) as { step: string };
      if (b.step === 'start') return json(200, { ok: true, export_id: EID, exported_at: '2026-10-31T01:00:05.000Z' });
      const n = (st.partCalls += 1); o.onPart?.(n);
      if (n < (o.parts ?? 1)) return new Response(gzipSync('{'), { status: 200, headers: { [NEXT]: `c${n}`,'content-type': 'application/gzip' } });
      const tables: Record<string, unknown[]> = Object.fromEntries(EXPORT_TABLES.map((t) => [t, (st.rows[t] ?? []).map((r) => ({ ...(r as object), marker: MARK.row }))]));
      tables.logs = [...(tables.logs ?? []), { user_id: UID, act: 'export', code: MARK.row }];
      const doc = { format: 'lemomemo-export', version: 1, exported_at: '2026-10-31T01:00:05.000Z', user_id: UID, vault: 'omitted', tables };
      return new Response(gzipSync(JSON.stringify(doc)), { status: 200, headers: { [NEXT]: 'done', 'content-type': 'application/gzip' } });
    }
    return json(404, {});
  };
  return { st, fetch };
}

/** 跑一次 run()，输出收进 lines（信号处理不登记；信号单独一条用例测） */
async function go(args: string[], o: Opts = {}, extra: { env?: Record<string, string>; target?: unknown } = {}) {
  const be = fakeBackend(o);
  const lines: string[] = [], exits: number[] = [];
  const code = await run({
    args, env: extra.env ?? {}, fetch: be.fetch, write: (s: string) => lines.push(s), exit: (c: number) => exits.push(c),
    onSignal: () => {}, target: async () => extra.target ?? PREVIEW,
  });
  await new Promise((r) => setTimeout(r, 0));   // 让挂着的微任务跑完再看输出
  const out = lines.join('\n');
  const report = JSON.parse(lines.filter((l) => l.startsWith('{\n')).at(-1) ?? '{}') as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- 报告是脚本打的 JSON
  return { code, lines, out, report, exits, be };
}
const SMALL = ['--sync-rows', '3', '--log-rows', '5'];
const deletes = (be: ReturnType<typeof fakeBackend>) => be.st.calls.filter((c) => c.startsWith('DELETE'));

afterEach(() => { vi.restoreAllMocks(); });

describe('export-load-preview run()：TC-B1-141', () => {
  it.each([
    ['正式项目', 'https://uvlnwawwsdfihziaielj.supabase.co'],
    ['lemo-e2e 的地址（没加 --rehearse-local）', 'http://127.0.0.1:55321'],
    ['空 ref', 'https://.supabase.co'],
    ['预览 ref 后面接别的域名', `https://${PREVIEW_REF}.supabase.co.evil.com`],
    ['预览 ref 走 http', `http://${PREVIEW_REF}.supabase.co`],
  ])('① 非预览地址（%s）：一个请求都不发，失败退出', async (_n, base) => {
    const r = await go(SMALL, {}, { target: { base, key: MARK.key, label: 'preview' } });
    expect(r.code).toBe(2);
    expect(r.report.error).toBe('bad_ref');
    expect(r.be.st.calls).toEqual([]);
  });

  it('① 演练只认 127.0.0.1 / localhost 的 55320～55329；② 没设 E2E_PREVIEW_SERVICE_KEY 就不发请求', async () => {
    expect(targetOk({ base: 'http://127.0.0.1:55321' }, true)).toBe(true);
    expect(targetOk({ base: 'http://127.0.0.1:54321' }, true)).toBe(false);
    expect(targetOk({ base: 'http://10.0.0.5:55321' }, true)).toBe(false);
    const be = fakeBackend();
    const lines: string[] = [];
    const code = await run({ args: SMALL, env: {}, fetch: be.fetch, write: (s: string) => lines.push(s), exit: () => {}, onSignal: () => {} });
    expect(code).toBe(2);
    expect(lines.join('')).toContain('no_service_key');
    expect(be.st.calls).toEqual([]);
  });

  it('②③⑧ 正常跑完：输出只有数字和错误码，找不到任何标记串；工作目录和临时目录没有新文件；只按本次 id 删、删干净；库大小记三次', async () => {
    // 仓库根目录、tools/e2e 前后一样；临时目录别的并行测试也在写，只查没有多出跟本脚本相关的名字；脚本本身不引任何文件模块
    const root = join(import.meta.dirname, '..', '..');
    const ls = () => [readdirSync(root), readdirSync(join(root, 'tools', 'e2e'))].map((x) => x.sort().join('|'));
    const before = ls();
    const tmpBefore = new Set(readdirSync(tmpdir()));
    const r = await go(SMALL);
    expect(ls()).toEqual(before);
    expect(readdirSync(tmpdir()).filter((n) => !tmpBefore.has(n) && /e2e-export|export-load|\.json\.gz$/i.test(n))).toEqual([]);
    for (const f of ['export-load-preview.mjs', 'export-load-preview-guards.mjs', 'export-load-lib.mjs']) {
      expect(readFileSync(join(root, 'tools', 'e2e', f), 'utf8')).not.toMatch(/node:fs|node:os|writeFile|createWriteStream|appendFile/);
    }
    expect(r.code).toBe(0);
    expect(r.be.st.calls).not.toContain('NO_SIGNAL');   // REST、Auth、account 每个请求都带 AbortSignal 超时
    expect(r.lines[0]).toBe(JSON.stringify({ created: UID }));   // D2 第 1 点：建号后第一行就是 id
    for (const v of [...Object.values(MARK), r.be.st.email]) expect(r.out).not.toContain(v);
    expect(r.out).not.toMatch(/Bearer|apikey|hashed_token|access_token/);
    expect(r.be.st.email).toMatch(TEST_EMAIL);
    expect(r.report.checks.every((c: string) => c.startsWith('✓'))).toBe(true);
    // 调 account 只带用户 jwt，不带 service key（②）
    expect(r.be.st.fnHeaders.length).toBeGreaterThan(0);
    for (const h of r.be.st.fnHeaders) {
      expect(h.authorization).toBe(`Bearer ${MARK.jwt}`);
      expect(Object.values(h)).not.toContain(MARK.key);
    }
    // ⑤ 不建 R2 / Storage 对象；⑧ 只按 id 删，不按邮箱模式删
    expect(r.be.st.calls.some((c) => /storage|r2/i.test(c))).toBe(false);
    expect(deletes(r.be)).toEqual([`DELETE /auth/v1/admin/users/${UID}`, 'DELETE /rest/v1/counters']);
    expect(r.report.cleanup).toMatchObject({ id: UID, guard: 'ok', rowsLeft: {}, countersLeft: 0, userGone: true });
    expect([r.report.dbBeforeMB, r.report.dbAfterExportMB, r.report.cleanup.dbAfterMB].every((x) => typeof x === 'number')).toBe(true);
  });

  it('④ 库 251 MB：失败退出、不建号不造数；正好 250 MB：照跑', async () => {
    const big = await go(SMALL, { dbBytes: 251 * MB });
    expect(big.code).toBe(3);
    expect(big.report.error).toBe('db_too_large');
    expect(big.be.st.calls).toEqual(['POST /rest/v1/rpc/db_size_bytes']);
    const edge = await go(SMALL, { dbBytes: 250 * MB });
    expect(edge.code).toBe(0);
    expect(edge.be.st.calls).toContain('POST /auth/v1/admin/users');
  });

  it('⑤ 邮箱已存在：失败退出、不删任何东西、不打印回包里的内容', async () => {
    const r = await go(SMALL, { emailExists: true });
    expect(r.code).toBe(4);
    expect(r.report.error).toBe('create_user 422 email_exists');
    expect(deletes(r.be)).toEqual([]);
    expect(r.out).not.toContain(MARK.row);
    expect(r.out).not.toContain('created');
  });

  it.each([
    ['邮箱不等于本次建的', { fetchedEmail: 'e2e-export-1790000000001@lemomemo.test' }, {}, 'email_mismatch'],
    ['不以 @lemomemo.test 结尾', { fetchedEmail: 'someone@gmail.com' }, {}, 'not_test_email'],
    ['在 private.admins 里', { admins: [UID] }, {}, 'is_admin'],
    ['created_at 早于本次开始（数据库时间）', { createdAt: '2026-10-31T00:59:59Z' }, {}, 'created_before_run'],
    ['在 PREVIEW_OWNER_EMAILS 里', {}, { PREVIEW_OWNER_EMAILS: 'E2E-EXPORT-1790000000000@LEMOMEMO.TEST' }, 'owner_email'],
  ])('⑥ 删前核对不符（%s）：不删、失败退出、带 id 和交主持人的提示', async (_n, o, env, reason) => {
    vi.spyOn(Date, 'now').mockReturnValue(1790000000000);
    const r = await go(SMALL, o, { env });
    expect(r.code).toBe(1);
    expect(r.report.cleanup.guard).toContain(reason);
    expect(r.report.cleanup).toMatchObject({ id: UID, handOver: HAND_OVER });
    expect(deletes(r.be)).toEqual([]);
  });

  it.each([10, -10])('⑥ 本机时钟拨 %s 分钟（数据库时间不变）：核对结果不变，照常删干净', async (min) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(DB_AT) + min * 60000);
    const r = await go(SMALL);
    expect(r.code).toBe(0);
    expect(r.report.cleanup.userGone).toBe(true);
  });

  it('⑥ 没设 PREVIEW_OWNER_EMAILS 记“跳过”、其余照核；设了就照核、不记跳过', async () => {
    expect((await go(SMALL)).report.cleanup.notes).toEqual(['PREVIEW_OWNER_EMAILS 没设，跳过']);
    expect((await go(SMALL, {}, { env: { PREVIEW_OWNER_EMAILS: 'owner@example.com' } })).report.cleanup.notes).toEqual([]);
  });

  it('⑦ 造数中途报错：finally 里照样删掉本次建的 id，失败退出，报错只有步骤和状态码', async () => {
    const r = await go(SMALL, { seedFailAt: 'events' });
    expect(r.code).toBe(1);
    expect(r.report.error).toBe('seed events 500');
    expect(deletes(r.be)[0]).toBe(`DELETE /auth/v1/admin/users/${UID}`);
    expect(r.report.cleanup).toMatchObject({ id: UID, userGone: true });
    expect(r.out).not.toContain(MARK.row);
  });

  it('⑦ 删除报错：失败退出，输出带 user id 和交主持人的提示', async () => {
    const r = await go(SMALL, { deleteFails: true });
    expect(r.code).toBe(1);
    expect(r.report.cleanup).toMatchObject({ id: UID, error: 'delete_user 500', handOver: HAND_OVER });
  });
});

describe('export-load-preview run()：安全审查 D2、E4', () => {
  /** 带信号登记的跑法：handlers 是当前挂着的监听，seen 记下所有登记过的处理函数（摘掉后也留着，用来验证“摘掉后不再响应”） */
  async function goSignals(o: Opts, fire: (h: Map<string, () => void>) => void = () => {}, where: 'seed' | 'part' = 'seed') {
    const handlers = new Map<string, () => void>(), seen = new Map<string, () => void>();
    let fired = false;
    const once = () => { if (!fired) { fired = true; fire(handlers); } };
    const be = fakeBackend(where === 'seed' ? { ...o, onSeed: once } : { ...o, onPart: once });
    const lines: string[] = [], exits: number[] = [];
    const code = await run({
      args: SMALL, env: {}, fetch: be.fetch, write: (s: string) => lines.push(s), exit: (c: number) => exits.push(c),
      onSignal: (s: string, fn: () => void) => { handlers.set(s, fn); seen.set(s, fn); return () => { if (handlers.get(s) === fn) handlers.delete(s); }; },
      target: async () => PREVIEW,
    });
    await new Promise((res) => setTimeout(res, 0));
    const reports = () => lines.filter((l) => l.startsWith('{\n'));
    return { code, lines, exits, be, handlers, seen, reports };
  }

  it('D2 第 2 点：造数中收到 SIGINT，走同一段核对和清理（只删一次）、只打印一次报告、返回 130，不调 exit', async () => {
    // Windows 关窗口是 SIGHUP、kill 是 SIGTERM，同一个处理
    const r = await goSignals({}, (h) => h.get('SIGINT')?.());
    expect([...r.seen.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
    expect(r.code).toBe(130);
    expect(r.exits).toEqual([]);   // 不走 process.exit，入口设 exitCode
    expect(r.be.st.calls.filter((c) => c === `DELETE /auth/v1/admin/users/${UID}`)).toHaveLength(1);
    expect(r.reports()).toHaveLength(1);
    const rep = JSON.parse(r.reports()[0] ?? '{}') as { error?: string; cleanup?: { userGone?: boolean } };
    expect(rep.error).toBe('interrupted SIGINT');
    expect(rep.cleanup?.userGone).toBe(true);
    expect(r.be.st.calls.filter((c) => c.startsWith('POST /rest/v1/') && !c.includes('/rpc/')).length).toBeLessThanOrEqual(1);   // 收到信号后不再接着造数
    expect(r.be.st.calls).not.toContain('POST /auth/v1/admin/generate_link');   // 也不再往下拿会话、调导出
    expect(r.handlers.size).toBe(0);   // 返回前监听已摘掉
  });

  it('D2 第 2 点：再来一次信号是逃生口：先打一行 interrupted_twice（带 id、写明没有清理），再 exit 130', async () => {
    const r = await goSignals({}, (h) => { h.get('SIGINT')?.(); h.get('SIGTERM')?.(); });
    expect(r.exits).toEqual([130]);
    const twice = JSON.stringify({ interrupted_twice: UID, cleanup: 'not_done', handOver: NOT_CLEANED });
    const ci = r.lines.indexOf(JSON.stringify({ created: UID }));
    expect([ci > -1, ci < r.lines.indexOf(twice)]).toEqual([true, true]);   // 替身 exit 不真退出，后面照常清理一次
    expect(r.be.st.calls.filter((c) => c === `DELETE /auth/v1/admin/users/${UID}`)).toHaveLength(1);
  });

  it('代码审查：导出中途收到信号，先停导出（不再取下一片）再清理，清理之后没有任何 account 请求', async () => {
    const r = await goSignals({ parts: 3 }, (h) => h.get('SIGINT')?.(), 'part');
    expect(r.code).toBe(130);
    expect(r.exits).toEqual([]);
    expect(r.be.st.partCalls).toBe(1);   // 第 1 片已在路上照常收完，第 2 片不再请求
    expect(r.be.st.calls.indexOf(`DELETE /auth/v1/admin/users/${UID}`)).toBeGreaterThan(r.be.st.calls.lastIndexOf('POST /functions/v1/account'));
    expect(r.be.st.calls.filter((c) => c === 'DELETE /rest/v1/counters')).toHaveLength(1);
    expect(JSON.parse(r.reports()[0] ?? '{}')).toMatchObject({ error: 'interrupted SIGINT', cleanup: { userGone: true } });
  });

  it.each([
    ['正常跑完', {}, 0],
    ['中途出错', { seedFailAt: 'events' }, 1],
  ])('D2 第 2 点：%s后监听全部摘掉，之后再来信号不重打报告、不改退出码、不调 exit', async (_n, o, want) => {
    const r = await goSignals(o as Opts);
    expect(r.code).toBe(want);
    expect(r.seen.size).toBe(3);
    expect(r.handlers.size).toBe(0);
    const n = r.lines.length;
    for (const fn of r.seen.values()) fn();   // 就算旧处理函数被调到也不能有动静
    await new Promise((res) => setTimeout(res, 0));
    expect(r.lines.length).toBe(n);
    expect(r.exits).toEqual([]);
    expect(r.reports()).toHaveLength(1);
  });

  it('D2 第 4 点：--cleanup <uid> 只做核对和删除；默认 since 取数据库时间往前 24 小时', async () => {
    const user = { id: UID, email: 'e2e-export-1790000000000@lemomemo.test', created_at: '2026-10-30T09:00:00Z' };
    const r = await go(['--cleanup', UID], { user });
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({ mode: 'cleanup', id: UID, since: '2026-10-30T01:00:00.000Z' });
    expect(r.report.cleanup).toMatchObject({ guard: 'ok', userGone: true, countersLeft: 0 });
    expect(r.be.st.calls).not.toContain('POST /auth/v1/admin/users');
    // 报告写明“邮箱一致”没有对照值，只核对了形状；正常模式没有这句
    expect(r.report.cleanup.notes.some((n: string) => /邮箱一致这一条没有对照值，只核对了邮箱形状/.test(n))).toBe(true);
    expect((await go(SMALL)).report.cleanup.notes.join('')).not.toContain('没有对照值');
  });

  it('D2 第 4 点：--since 早于 24 小时前拒、不删；账号建在 since 之前、不是测试邮箱都不删', async () => {
    const user = { id: UID, email: 'e2e-export-1790000000000@lemomemo.test', created_at: '2026-10-30T09:00:00Z' };
    const old = await go(['--cleanup', UID, '--since', '2026-10-29T00:00:00Z'], { user });
    expect(old.code).toBe(2);
    expect(old.report.error).toBe('since_out_of_range');
    expect(deletes(old.be)).toEqual([]);
    const before = await go(['--cleanup', UID, '--since', '2026-10-30T10:00:00Z'], { user });
    expect(before.code).toBe(1);
    expect(before.report.cleanup.guard).toContain('created_before_run');
    expect(deletes(before.be)).toEqual([]);
    const real = await go(['--cleanup', UID], { user: { ...user, email: 'someone@gmail.com' } });
    expect(real.code).toBe(1);
    expect(real.report.cleanup.guard).toContain('not_test_email');
    expect(deletes(real.be)).toEqual([]);
  });

  it('E4：成功回包解析出错只记 e.name，不带回包原文', async () => {
    const r = await go(SMALL, { badLinkJson: true });
    expect(r.code).toBe(1);
    expect(r.report.error).toBe('SyntaxError');
    expect(r.out).not.toContain(MARK.email);
    expect(r.report.cleanup.userGone).toBe(true);
    expect(errText(new SyntaxError(`Unexpected token in JSON: {"email":"${MARK.email}"}`))).toBe('SyntaxError');
    expect(errText(new TypeError('x'))).toBe('TypeError');
    expect(errText('裸字符串')).toBe('Error');
    expect(errText({ name: 'has space and 中文' })).toBe('Error');
  });
});
