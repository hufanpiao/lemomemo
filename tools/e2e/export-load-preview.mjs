// TC-B1-73 / R1 的预览环境跑法（架构 0.47 续 ⑤）：在预览项目里临时建一个 .test 账号，经 REST 分批造数，按两步分片协议跑一次 account export，
// 记每片大小和耗时，核对计数和 logs，最后在 finally 里删号、删计数、核对删干净。只做量测，不建 R2 对象、不写任何文件。
// 发信：account、account-purge 对 @lemomemo.test 收件人不真发（_shared/account-mail.ts 的 skipTestRecipients，安全审查 D1），
//   函数日志记 mail_skipped_test，导出通知照“没发出去”的规则另写一条 export_mail_failed（所以下面 logs 允许多 1～2 条）。
// 交给负责人的跑法说明：docs/06-测试/B1-预览导出实测-负责人跑法.md（TC-B1-142）。
//
// 用法（仓库根目录；本脚本要先交安全审查员审过，负责人点头才对预览跑）：
//   PowerShell：$env:E2E_PREVIEW_SERVICE_KEY = '…'（仓库级 secret，R-206；只设在这一个窗口）  $env:PREVIEW_OWNER_EMAILS = '…'（可空）
//   node tools/e2e/export-load-preview.mjs [--sync-rows N≤5000] [--log-rows N≤45000] [--rehearse-local]
//     --rehearse-local  把同一套代码路径打到本机 lemo-e2e（地址和本地演示密钥取 real-backend.mjs 的 statusEnv，端口必须 553xx），
//                       用来演练，不碰预览；这时不读 E2E_PREVIEW_SERVICE_KEY。
//   node tools/e2e/export-load-preview.mjs --cleanup <uid> [--since <ISO 时刻>] [--rehearse-local]
//     补删模式（安全审查 D2 第 4 点）：上一次跑到一半被打断、留下了账号时，按输出里的 {"created": "<uid>"} 补删。
//     只做护栏 ⑥ 的核对和删除，核对一条不少；“建号时间晚于运行开始”换成晚于 --since（不给就取数据库时间往前 24 小时，给了也不能早于 24 小时前）。
//
// 护栏（任何一条不过都报错退出；清理那几条不过就不删、只报告）：
//   ① 只认预览项目 ref（写死 PREVIEW_REF，和 preview-login.ts 一致，tests/build/export-load-preview.test.ts 比对）；地址的主机名不是预览的就不发任何请求、直接退出；
//   ② service key 只从环境变量读，不打印、不进报错、不写文件；调 account 函数只带 Authorization: Bearer <用户 jwt>，不带 service key；
//   ③ 跑前用 private.db_size_bytes() 查库大小，超过 250 MB 就退出、什么都不建；它回的 at 当“运行开始时刻”；导出跑完、删完各再记一次；
//   ④ 账号邮箱 e2e-export-<时间>@lemomemo.test；建号报 email_exists（或任何失败）就退出、不删任何东西；
//      建号成功立刻打印一行 {"created": "<uid>"}（测试账号的 uuid 不敏感），中途被打断也找得到这个账号（安全审查 D2 第 1 点）；
//   ⑤ 造数上限：每张同步表 ≤ 5,000 行、logs ≤ 45,000 行（预览库小）；
//   ⑥ 清理在 finally 里（造数、导出中途失败也清），删之前逐条核对：按 id 取回的邮箱和本次建的完全相等、以 @lemomemo.test 结尾、不在 private.admins、
//      不在 PREVIEW_OWNER_EMAILS（没设就记“跳过”）、created_at ≥ 运行开始时刻（两边都是数据库时间）；全过才 deleteUser，再删 counters 里 %:<id>:% 的键，
//      然后核对 11 张表本人行数都是 0、账号不存在、再记一次库大小。核对不过或删除失败时 report.cleanup 带 id 和“交主持人”的提示（D2 第 3 点）；
//      收到 SIGINT（Ctrl+C）、SIGTERM、SIGHUP（Windows 关窗口）也走同一段核对和清理再退出，清理只跑一次（D2 第 2 点）：
//      第一次 Ctrl+C 后，已发出的那一个请求（造数的那一批、导出的那一片）会跑完，最多晚一批 / 一片停下，停下以后才清理；
//      第二次 Ctrl+C 是卡住时的逃生口：打一行 {"interrupted_twice": id, "cleanup": "not_done", …} 直接退出，没有清理，要按这个 id 跑 --cleanup；
//      每个请求都有超时（REST、Auth 60 秒，导出每片 180 秒，大于函数 150 秒墙钟），网络卡住不会一直挂着；
//   ⑦ 只打印条数、字节数、毫秒数和错误码：不打印行内容、响应体、令牌、邮箱以外的身份信息；不认识的异常只记 e.name（安全审查 E4）。
// 主体在 run()，fetch、输出、信号、退出都可注入（单测用替身跑整条流程，TC-B1-141）；直接执行本文件时用真的。
/* global fetch, AbortSignal -- Node 24 的全局 */
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import { EXPORT_TABLES, runExport, summary } from './export-load-lib.mjs';
import { cleanupGuard, cleanupSince, MAX_DB_BYTES, ownerList, parseArgs, PREVIEW_REF, seedRows } from './export-load-preview-guards.mjs';

const BATCH = 1000;
export const HAND_OVER = '核对不过或删除失败，没删干净：把 id 交主持人，按 docs/06-测试/B1-预览导出实测-负责人跑法.md 用 --cleanup 补删';
/** 第二次中断：直接退出，什么都没清理 */
export const NOT_CLEANED = '第二次中断，直接退出，没有清理：账号和造的数据都还在。用这个 id 按 docs/06-测试/B1-预览导出实测-负责人跑法.md 跑 --cleanup 补删，超过 24 小时交主持人';
/** 每个请求的超时：REST、Auth 60 秒；导出每片 180 秒（大于函数 150 秒墙钟，代码审查） */
export const REQ_TIMEOUT_MS = 60_000;
export const PART_TIMEOUT_MS = 180_000;

/** 失败只带路径和状态码（不带响应体、不带密钥） */
class StepError extends Error {
  constructor(step, status, code = null) {
    super(`${step} HTTP ${status}${code ? ` ${code}` : ''}`);
    this.step = step;
    this.status = status;
    this.code = code;
  }
}

/** 报错只记步骤、状态码、白名单错误码；不认识的异常只记 e.name（E4：SyntaxError 一类的文案会带响应原文） */
export function errText(e) {
  if (e instanceof StepError) return `${e.step} ${e.status} ${e.code ?? ''}`.trim();
  return typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error';
}

async function realTarget(local, env) {
  if (!local) {
    const key = env.E2E_PREVIEW_SERVICE_KEY;
    if (!key) return { error: 'no_service_key' };
    return { base: `https://${PREVIEW_REF}.supabase.co`, key, label: 'preview' };
  }
  const { statusEnv } = await import('./real-backend.mjs');
  const s = statusEnv();
  return { base: s.API_URL.replace(/\/$/, ''), key: s.SERVICE_ROLE_KEY, label: 'lemo-e2e' };
}

/** 护栏 ①：预览只认 PREVIEW_REF 的主机名；演练只认 127.0.0.1 / localhost 的 55320～55329 */
export function targetOk(T, local) {
  let u;
  try { u = new URL(T.base); } catch { return false; }
  if (!local) return u.protocol === 'https:' && u.hostname === `${PREVIEW_REF}.supabase.co` && !u.port;
  const port = Number(u.port);
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && port >= 55320 && port <= 55329;
}

/**
 * 跑一次。deps：args（命令行参数）、env、fetch、write（输出一行文字）、onSignal(sig, fn) → 解除函数、exit(code)（只在第二次信号时用）、
 * target（可选，(local, env) => {base, key, label} 或 {error}；默认按 --rehearse-local 取预览或 lemo-e2e）。返回退出码。
 */
export async function run(deps) {
  const { args, env, write } = deps;
  const f = deps.fetch;
  const print = (o) => write(JSON.stringify(o, null, 1));
  const a = parseArgs(args);
  if (a.error) { print({ error: a.error }); return 2; }
  const T = await (deps.target ?? realTarget)(a.local, env);
  if (T.error) { print({ error: T.error }); return 2; }
  if (!targetOk(T, a.local)) { print({ error: 'bad_ref' }); return 2; }   // ①：一个请求都不发
  const svc = { apikey: T.key, authorization: `Bearer ${T.key}` };
  const req = async (step, path, init = {}, extra = {}) => {
    const r = await f(T.base + path, { ...init, signal: AbortSignal.timeout(REQ_TIMEOUT_MS), headers: { ...svc, 'content-type': 'application/json', ...extra } });
    const text = await r.text();
    if (!r.ok) {
      let code = null;
      try { const j = JSON.parse(text); code = [j.error_code, j.code, j.error].find((x) => typeof x === 'string' && /^[a-z_0-9]{1,40}$/i.test(x)) ?? null; } catch { /* 不是 JSON */ }
      throw new StepError(step, r.status, code);
    }
    return { body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  const priv = { 'accept-profile': 'private', 'content-profile': 'private' };
  const dbSize = async () => (await req('db_size', '/rest/v1/rpc/db_size_bytes', { method: 'POST', body: '{}' }, priv)).body?.[0];
  const mb = (s) => +(Number(s?.bytes) / 1048576).toFixed(1);

  /** ⑥ 清理：先核对，全过才删；created 为 null 时（补删模式）按取回的邮箱比，其余核对一条不少 */
  async function cleanup(uid, created, runAt) {
    const out = { id: uid };
    const c = { id: uid };
    try {
      const u = (await req('get_user', `/auth/v1/admin/users/${uid}`)).body;
      c.fetched = u ? { email: u.email ?? null, created_at: u.created_at ?? null } : null;
    } catch { c.fetched = null; }
    try {
      c.admins = (await req('admins', '/rest/v1/admins?select=user_id', {}, priv)).body.map((x) => x.user_id);
    } catch { c.admins = null; }
    const g = cleanupGuard({ ...c, created: created ?? c.fetched?.email ?? null, runAt, owners: ownerList(env.PREVIEW_OWNER_EMAILS) });
    // 补删模式没有本次建号时记下的邮箱，“邮箱一致”只能拿取回的邮箱比它自己，等于只核对了形状
    const notes = created === null ? [...(g.notes ?? []), 'cleanup_mode: 邮箱一致这一条没有对照值，只核对了邮箱形状（e2e-export-<13 位数字>@lemomemo.test）'] : g.notes;
    Object.assign(out, { guard: g.ok ? 'ok' : g.reasons, notes });
    if (!g.ok) return { ok: false, out: { ...out, handOver: HAND_OVER } };
    try {
      await req('delete_user', `/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
      await req('delete_counters', `/rest/v1/counters?key=like.*:${uid}:*`, { method: 'DELETE' }, { ...priv, prefer: 'return=minimal' });
      const left = {};
      for (const t of EXPORT_TABLES) {
        const r = await req(`count ${t}`, `/rest/v1/${t}?select=user_id&user_id=eq.${uid}`, { method: 'HEAD' }, { prefer: 'count=exact' });
        const n = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1] ?? NaN);
        if (n !== 0) left[t] = Number.isFinite(n) ? n : '?';
      }
      const cl = (await req('counters_left', `/rest/v1/counters?select=key&key=like.*:${uid}:*`, {}, priv)).body.length;
      let gone = false;
      try { await req('get_user_after', `/auth/v1/admin/users/${uid}`); } catch (e) { gone = e instanceof StepError && e.status === 404; }
      Object.assign(out, { rowsLeft: left, countersLeft: cl, userGone: gone, dbAfterMB: mb(await dbSize()) });
      const ok = !Object.keys(left).length && !cl && gone;
      return { ok, out: ok ? out : { ...out, handOver: HAND_OVER } };
    } catch (e) {
      return { ok: false, out: { ...out, error: e instanceof StepError ? `${e.step} ${e.status}` : 'cleanup_failed', handOver: HAND_OVER } };
    }
  }

  // ③ 库大小（数据库时间也从这里来）
  let size0;
  try { size0 = await dbSize(); } catch (e) { print({ target: T.label, error: errText(e) }); return 3; }

  // 补删模式：只核对和删除（D2 第 4 点）
  if (a.cleanup) {
    const report = { target: T.label, mode: 'cleanup', id: a.cleanup };
    const s = cleanupSince(a.since, size0?.at);
    if (s.error) { report.error = s.error; print(report); return 2; }
    report.since = s.at;
    const r = await cleanup(a.cleanup, null, s.at);
    report.cleanup = r.out;
    print(report);
    return r.ok ? 0 : 1;
  }

  const report = { target: T.label, sync: a.sync, logs: a.logs };
  report.dbBeforeMB = mb(size0);
  if (!(Number(size0?.bytes) <= MAX_DB_BYTES)) { report.error = 'db_too_large'; print(report); return 3; }
  const runAt = size0.at;

  // ④ 建号（失败就退出，不删任何东西）
  const email = `e2e-export-${Date.now()}@lemomemo.test`;
  let uid;
  try {
    uid = (await req('create_user', '/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) })).body?.id;
  } catch (e) {
    report.error = e instanceof StepError ? `create_user ${e.status} ${e.code ?? ''}`.trim() : 'create_user_failed';
    print(report);
    return 4;
  }
  if (!/^[0-9a-f-]{36}$/.test(uid ?? '')) { report.error = 'bad_user_id'; print(report); return 4; }
  write(JSON.stringify({ created: uid }));   // D2 第 1 点：中途被打断也知道补删哪个

  let failed = false;
  // 清理只跑一次（finally 里调；多处调也只跑一次）
  let cleaning = null;
  const cleanupOnce = () => (cleaning ??= cleanup(uid, email, runAt).then((r) => {
    report.cleanup = r.out;
    if (!r.ok) failed = true;
  }));
  // D2 第 2 点：Ctrl+C、kill、Windows 关窗口（SIGHUP）也走同一段核对和清理。
  // 第一次信号只做标记：主流程在下一个检查点停下（造数的下一批前、拿会话前、调导出前、导出的下一片前），再由 finally 清理、统一打印、
  //   返回 130（入口设 exitCode，不调 process.exit）。先停导出再清理：清理删完计数后不会再有一片请求把 export-part 键写回来（代码审查）。
  // 第二次信号是卡住时的逃生口：先打一行 {"interrupted_twice": id, "cleanup": "not_done", …}（没有清理，补删要用这个 id），再 exit(130)。
  // run() 返回前把监听全部摘掉，正常结束后再按 Ctrl+C 不会重打报告、改退出码。
  let interrupted = false;
  let done = false;
  const offs = [];
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const off = deps.onSignal(sig, () => {
      if (done) return;   // 已经收尾：就算监听没摘干净也不再有动静
      if (interrupted) { write(JSON.stringify({ interrupted_twice: uid, cleanup: 'not_done', handOver: NOT_CLEANED })); deps.exit(130); return; }
      interrupted = true;
      report.error = `interrupted ${sig}`;
      failed = true;
    });
    if (typeof off === 'function') offs.push(off);
  }
  try {
    return await body();
  } finally {
    done = true;
    for (const off of offs) off();
  }

  async function body() {
  try {
    // ⑤ 造数
    const t0 = Date.now();
    const rows = seedRows(uid, a.sync, a.logs);
    for (const [table, list] of Object.entries(rows)) {
      for (let i = 0; i < list.length && !interrupted; i += BATCH) {
        await req(`seed ${table}`, `/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(list.slice(i, i + BATCH)) }, { prefer: 'return=minimal' });
      }
    }
    if (interrupted) throw new StepError('interrupted', 0);
    report.seedS = +((Date.now() - t0) / 1000).toFixed(1);
    const seeded = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length]));

    // OTP 会话（account 拒密码会话）；令牌只在内存里
    if (interrupted) throw new StepError('interrupted', 0);
    const link = (await req('generate_link', '/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) })).body;
    const hashed = link?.hashed_token ?? link?.properties?.hashed_token;
    const jwt = (await req('verify', '/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: hashed }) })).body?.access_token;
    if (typeof jwt !== 'string') throw new StepError('verify', 200, 'no_session');

    // ② 调函数只带用户 jwt
    if (interrupted) throw new StepError('interrupted', 0);
    const r = await runExport(`${T.base}/functions/v1/account`, { authorization: `Bearer ${jwt}` }, {
      fetch: (u, i) => f(u, { ...i, signal: AbortSignal.timeout(PART_TIMEOUT_MS) }),   // start 和每片各自计时
      beforePart: () => { if (interrupted) throw new StepError('interrupted', 0); },   // 每片之前查：先停导出，再由 finally 清理
    });
    const { perPart, ...sum } = summary(r);
    Object.assign(report, sum, { perPart });
    report.dbAfterExportMB = mb(await dbSize());   // ③ 跑完记一次

    // 核对
    const counters = Object.fromEntries((await req('counters', `/rest/v1/counters?select=key,count&key=like.*:${uid}:*`, {}, priv)).body
      .map((x) => [x.key.split(':')[0], x.count]));
    const logs = (await req('logs', `/rest/v1/logs?select=act&user_id=eq.${uid}&src=eq.account`)).body
      .reduce((o, x) => ({ ...o, [x.act]: (o[x.act] ?? 0) + 1 }), {});
    const parts = r.parts.length;
    const checks = [];
    const ok = (c, what) => checks.push(`${c ? '✓' : '✗'} ${what}`);
    ok(!r.error && r.start.status === 200, `导出跑完（${r.error ?? 'ok'}）`);
    ok(report.startKeys === 'export_id,exported_at,ok', `start 只回三项（${report.startKeys}）`);
    ok(counters.account === 1 && counters['export-size'] === 1 && counters['export-part'] === parts && counters['export-job'] === parts,
      `计数：account ${counters.account}、export-size ${counters['export-size']}、export-part ${counters['export-part']}、任务 ${counters['export-job']}（片数 ${parts}）`);
    ok(logs.export === 1 && logs.export_done === 1, `logs：export ${logs.export ?? 0}、export_done ${logs.export_done ?? 0}`);
    ok(r.head?.exportedAtMatches === true, 'exported_at 一致');
    ok(report.contentEncoding?.length === 1 && report.contentEncoding[0] === null, '响应不带 Content-Encoding');
    // logs 多出本次的 export 一条；.test 收件人跳过发信后另记 export_mail_failed，和取 logs 那片谁先谁后不定，所以允许多 1～2 条
    ok(EXPORT_TABLES.every((t) => (t === 'logs' ? r.rows?.logs - seeded.logs >= 1 && r.rows?.logs - seeded.logs <= 2 : (r.rows?.[t] ?? -1) === seeded[t])),
      `每张表行数和造的一致（logs 多 ${r.rows?.logs - seeded.logs} 条 account 日志）`);
    ok(r.userIdMatches?.(uid) === true, '每行 user_id 都是本人');
    report.checks = checks;
    failed = checks.some((c) => c.startsWith('✗'));
  } catch (e) {
    failed = true;
    report.error ??= errText(e);
  } finally {
    await cleanupOnce();
  }
  print(report);
  return interrupted ? 130 : failed ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await run({
    args: process.argv.slice(2), env: process.env, fetch: (u, i) => fetch(u, i),
    write: (s) => process.stdout.write(s + '\n'), onSignal: (sig, fn) => { process.on(sig, fn); return () => process.off(sig, fn); }, exit: (c) => process.exit(c),
  });
  // 不在这里 process.exit：Windows 上 fetch 刚收尾就 exit，libuv 偶发断言（src\win\async.c UV_HANDLE_CLOSING）、退出码变成 -1073740791；
  // 设好退出码让事件循环自己结束（keep-alive 连接最多再等几秒）
  process.exitCode = code;
}
