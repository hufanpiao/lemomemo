// PURGE-cpu-budget 返工（B1 代码审查高 1）：account-purge 真 index.ts 打本机真库——多个账号同时到期、同时有一批要提醒的，
// 连着跑几次（每次就是一次 15 分钟的补跑），删号不积压、提醒一封不漏、不重复。
// 和 account-store.it.ts 同一套准备（harness.ts：Resend 拦 fetch 记收件人、R2 用 S3 替身、只打本机、开跑清残留、同一把会话级锁）；
// 单独一个 deno 进程跑（harness 的收尾会关库连接）：node supabase/tests/store-it/run.mjs 里排在 account-store.it.ts 后面。
// 真库才测得到的几样：listRemind 的 order('purge_after')、listDue 带出 notice_sent、postponeNotice 用 PostgREST 的 eq 比 timestamptz
// （原值是库里 select 出来的那串）、顺延以后 private.account_restore 照常回 ok。
// 场景：
//   • 3 个到期、提醒过的账号（各有 R2 对象和一份备份）→ 第 1 次运行就全删（提醒段停在自己的上限，不挤占删除）；
//   • 60 个 48 小时内到期、还没提醒的 → 第 1 次发到上限停（remind_left > 0），之后的运行发完，每人正好一封、按到期先后；
//   • 2 个已经到期、还没提醒的 → 补发一封“已顺延”，purge_after 顺延约 24 小时、notice_sent = true，不删；其中一个顺延后 restore 成功；
//   • 1 个已经到期、还没提醒、正在删（purge_started_at 刚写上）的 → listRemind 的 is('purge_started_at', null) 把它排除：不发信、不顺延
//     （B1 代码审查第三轮中 C），认领没过期，第二段也不碰它。
import {
  assert, assertEquals, BACKUP_DATE, EMAIL_LIKE, mails, s3Put, s3Has, sql, admin, ours, emails, writeLedger, purgeTraces, healLeftovers,
  mkUser, pending, runPurge, userExists, releaseLock, s3Server,
} from './harness.ts';

const opts = { sanitizeOps: false, sanitizeResources: false };
const H = 3600_000;

Deno.test({ name: 'purge-remind 开跑：清掉上次留下的', ...opts, async fn() {
  await healLeftovers();
  assertEquals((await sql`select 1 from auth.users where email like ${EMAIL_LIKE}`).length, 0);
} });

Deno.test({ name: '多个账号同时到期、同时有 60 个要提醒、2 个到期没提醒：删号不积压、提醒一封不漏不重复、补发并顺延一次', ...opts, async fn() {
  const due: string[] = [];
  for (let i = 0; i < 3; i++) {
    const u = await mkUser(`pr-due${i}`);
    await pending(u, -3600);   // 到期 1 小时，提醒过（notice_sent = true）
    s3Put('images', `${u}/a.jpg`);
    const up = await admin.storage.from('backups').upload(`${BACKUP_DATE}/${u}/notes.json.gz`, new Uint8Array([0x1f, 0x8b]), { contentType: 'application/gzip' });
    assert(!up.error, `传备份失败：${up.error?.message}`);
    due.push(u);
  }
  const win: string[] = [];
  for (let i = 0; i < 60; i++) {
    const u = await mkUser(`pr-win${i}`);
    await pending(u, 24 * 3600 + i);   // 24 小时后到期，每人晚 1 秒
    win.push(u);
  }
  const late: string[] = [];
  for (let i = 0; i < 2; i++) {
    const u = await mkUser(`pr-late${i}`);
    await pending(u, -600 + i);        // 已经到期 10 分钟
    late.push(u);
  }
  const claimed = await mkUser('pr-claimed');
  await pending(claimed, -600);
  await sql`update private.pending_deletions set notice_sent = false where user_id = any(${[...win, ...late, claimed]}::uuid[])`;
  await sql`update private.pending_deletions set purge_started_at = now() where user_id = ${claimed}::uuid`;
  const claimedPa = (await sql<{ pa: Date }[]>`select purge_after as pa from private.pending_deletions where user_id = ${claimed}::uuid`)[0]?.pa.getTime();
  const pa0 = new Map((await sql<{ u: string; pa: Date }[]>`select user_id::text as u, purge_after as pa from private.pending_deletions where user_id = any(${[...win, ...late]}::uuid[])`)
    .map((r) => [r.u, r.pa.getTime()]));

  const before = mails.length;
  const bodies: Record<string, unknown>[] = [];
  const perRun: string[][] = [];
  for (let i = 0; i < 6; i++) {
    const m0 = mails.length;
    const b = await runPurge();
    bodies.push(b);
    perRun.push(mails.slice(m0));
    if (b.sent === 0 && b.remaining === 0 && b.remind_left === 0) break;
  }
  const t1 = Date.now();

  // 删号不积压：第 1 次运行就把 3 个到期的全删了（提醒段停在自己的上限，不挤占删除）
  assertEquals([bodies[0]?.purged, bodies[0]?.failed, bodies[0]?.held], [3, 0, 0], JSON.stringify(bodies[0]));
  assert(Number(bodies[0]?.remind_left) > 0, `第 1 次运行提醒段应该停在上限：${JSON.stringify(bodies[0])}`);
  for (const u of due) {
    assert(!(await userExists(u)), '到期的账号没删');
    assert(!s3Has('images', `${u}/a.jpg`), 'R2 没删');
  }
  // 提醒一封不漏、不重复：每个要提醒的、补发的人正好一封；删掉的人各一封“彻底删除”
  const got = mails.slice(before);
  const count = (u: string) => got.filter((m) => m === emails.get(u)).length;
  for (const u of [...win, ...late, ...due]) assertEquals(count(u), 1, `${emails.get(u)} 收到的封数`);
  assertEquals(got.length, win.length + late.length + due.length, '多发了信');
  assertEquals(count(claimed), 0, '正在删的账号收到了提醒');
  const cr = (await sql<{ ns: boolean; pa: Date }[]>`select notice_sent as ns, purge_after as pa from private.pending_deletions where user_id = ${claimed}::uuid`)[0];
  assert(cr && !cr.ns && cr.pa.getTime() === claimedPa, '正在删的账号被标了提醒或顺延');
  // 最急的先发：第 1 次运行的提醒按到期先后——先是 2 个已经到期的，再是 win 的前若干个
  const remind1 = (perRun[0] ?? []).filter((m) => ![...due].some((u) => emails.get(u) === m));
  assertEquals(remind1, [...late, ...win].slice(0, remind1.length).map((u) => emails.get(u)), '第 1 次运行没有按 purge_after 先后发');
  // 最后一次运行什么都不发（幂等）
  assertEquals(bodies.at(-1)?.sent, 0, JSON.stringify(bodies.at(-1)));

  // 窗口里的：notice_sent = true、purge_after 不变；补发的：notice_sent = true、purge_after 顺延约 24 小时、账号还在
  const rows = await sql<{ u: string; ns: boolean; pa: Date; ps: Date | null }[]>`select user_id::text as u, notice_sent as ns, purge_after as pa, purge_started_at as ps
    from private.pending_deletions where user_id = any(${[...win, ...late]}::uuid[])`;
  assertEquals(rows.length, win.length + late.length, '要提醒的账号被删了');
  for (const r of rows) {
    assert(r.ns && r.ps === null, `${r.u.slice(0, 8)} notice_sent / 认领不对`);
    if (win.includes(r.u)) assertEquals(r.pa.getTime(), pa0.get(r.u), '窗口里的 purge_after 被改了');
    else {
      assert(r.pa.getTime() > t1 + 23 * H && r.pa.getTime() <= t1 + 24 * H, `补发的顺延时刻不对：${r.pa.toISOString()}`);
      assert(await userExists(r.u), '补发的账号被删了');
    }
  }
  // 顺延以后还能 restore（新的 purge_after 在将来）
  const lateOne = late[0] ?? '';
  const { res } = (await sql<{ res: string }[]>`select private.account_restore(${lateOne}::uuid) as res`)[0] ?? { res: '' };
  assertEquals(res, 'ok', '顺延以后 restore');
} });

Deno.test({ name: 'purge-remind 收尾：删掉本次建的用户和留下的行', ...opts, async fn() {
  try {
    await sql`delete from private.pending_deletions where user_id = any(${ours}::uuid[])`;   // 别留着让下一次调用碰到
    await purgeTraces(ours);
    await writeLedger([]);
    assertEquals((await sql`select 1 from auth.users where email like ${EMAIL_LIKE}`).length, 0);
  } finally {
    await releaseLock();
    await sql.end({ timeout: 5 });
    await s3Server.shutdown();
  }
} });
