// 账号导出分片：中途断网、自动重试用完后点“继续”接着取完（架构 0.47 续 ⑥ 前端 A 第 4 项；TC-B1-123 ①、TC-B1-136 ②）
// npm run e2e:real 跑（/sb 接 lemo-e2e 的真 account 函数）。
// • 造数：service role 往 notes 插 900 行、每行 body 2 万字（raw_text 留空：迁移 notes_raw_text_len 要求 ≤ 2000 字），
//   body 合计约 18 MB 原文；服务器每片约 16 MB 原文，导出至少 2 片，断网落在非第一片
// • 断网：page.route 拦 /sb/functions/v1/account；第一次请求“非第一片”（游标不是 null）时 context.setOffline(true) 并让这次请求断掉，
//   客户端按 TC-B1-126 间隔 2 秒、5 秒自动重试 2 次（断网中都失败）→ 停下显示“继续”；恢复联网后点“继续”
// • 核对：start 只调 1 次；所有 part 同一个 export_id；“继续”那次的游标就是断掉那次的；存下的文件 = 各片响应按顺序首尾相接；
//   用同一个任务、同一串游标不中断再取一遍，字节一模一样；整份 gunzip 后是一份 JSON，notes 行数对；
//   当天 account 次数 = 1、任务行分片数 = 实际取到的片数（private.counters 只读查，经 docker exec 进 supabase_db_lemo-e2e）；
//   logs 正好一条 export、一条 export_done，code 都是这个 export_id；“最近的导出”不标“未完成”
// • 页面里不保存令牌、不打印响应体；trace 只在失败时留（同本组配置）
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { type Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { adminInsert, createAccount, loginViaOtp, realBackend, restInPage } from './real-backend.ts';

test.use({ serviceWorkers: 'block', acceptDownloads: true });

const DB_CONTAINER = 'supabase_db_lemo-e2e';
const ROWS = 900;
const TEXT = 'lemo export resume e2e '.repeat(870).slice(0, 20_000);

/** 只读查 lemo-e2e 的 private.counters（容器名写死，跑前核对它在跑）；只回 key=count 两列 */
function counters(userId: string): Record<string, number> {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('userId 不像 uuid');
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.status !== 0 || !ps.stdout.split(/\r?\n/).includes(DB_CONTAINER)) throw new Error(`${DB_CONTAINER} 没在跑`);
  const sql = `select key, count from private.counters where split_part(key, ':', 2) = '${userId}' order by key;`;
  // 只读会话：PGOPTIONS 让这条连接默认只读事务，查询之外写不进任何东西
  const r = spawnSync('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-A', '-t', '-F', '='], {
    input: sql,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`查 counters 失败：${(r.stderr || '').slice(0, 300)}`);
  const out: Record<string, number> = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const i = line.lastIndexOf('=');
    if (i > 0) out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

/** 打开 /app/；首次登录先过告知页，再进设置页 */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/app/');
  const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
  const app = page.locator('main[data-feature]:not([data-feature="onboarding"])').first();
  await expect(consent.or(app)).toBeVisible();
  if (await consent.isVisible()) await consent.getByRole('button', { name: '先不同意，直接用' }).click();
  await expect(app).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.getByTestId('settings-export')).toBeEnabled();
}

/** 在页面里用同一个任务、同一个游标再取一片（不中断的对照）；回 base64 和下一个游标 */
async function partInPage(page: Page, exportId: string, cursor: string | null): Promise<{ status: number; b64: string; next: string | null }> {
  const anon = realBackend().anonKey;
  return page.evaluate(
    async ({ exportId, cursor, anon }) => {
      const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k)) ?? '';
      const token = (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token ?? '';
      const r = await fetch('/sb/functions/v1/account', {
        method: 'POST',
        headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-App-Version': '4.0.0' },
        body: JSON.stringify({ action: 'export', step: 'part', export_id: exportId, cursor }),
      });
      const bytes = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return { status: r.status, b64: btoa(s), next: r.headers.get('x-lemo-export-next') };
    },
    { exportId, cursor, anon },
  );
}

test('导出中途断网：自动重试用完后停下，联网点“继续”接着取完；start 只调一次、同一任务同一游标、文件和不中断一致、当天次数只加 1', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', '断网、拦请求、下载在 chromium 跑一遍就够');
  test.setTimeout(180_000);

  const acc = await createAccount();
  const t0 = 1790000000000;
  await adminInsert(
    'notes',
    Array.from({ length: ROWS }, (_v, i) => ({
      id: randomUUID(),
      user_id: acc.userId,
      body: TEXT,
      raw_text: '',
      created_at: t0 + i,
      updated_at: t0 + i,
    })),
    40,
  );
  await loginViaOtp(page, acc.email);
  await openSettings(page);

  const calls: Array<{ step: unknown; exportId: unknown; cursor: unknown; aborted: boolean }> = [];
  const parts: Array<{ cursor: string | null; bytes: Buffer; next: string | null }> = [];
  let cut = true;
  await page.route('**/sb/functions/v1/account', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { step?: unknown; export_id?: unknown; cursor?: unknown };
    const isLaterPart = body.step === 'part' && body.cursor !== null;
    if (isLaterPart && cut) {
      calls.push({ step: body.step, exportId: body.export_id, cursor: body.cursor, aborted: true });
      await context.setOffline(true);
      await route.abort('internetdisconnected');
      return;
    }
    calls.push({ step: body.step, exportId: body.export_id, cursor: body.cursor, aborted: false });
    const res = await route.fetch();
    const bytes = await res.body();
    if (body.step === 'part' && res.status() === 200) {
      parts.push({ cursor: (body.cursor as string | null) ?? null, bytes, next: res.headers()['x-lemo-export-next'] ?? null });
    }
    await route.fulfill({ response: res, body: bytes });
  });

  const download = page.waitForEvent('download', { timeout: 150_000 });
  await page.getByTestId('settings-export').click();

  // 断网 → 自动重试 2 次（2 秒、5 秒）→ 停下
  const resume = page.getByTestId('settings-export-resume');
  await expect(resume).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('settings-export-status')).toContainText('导出中断了');
  await expect(page.getByTestId('settings-export-progress')).toContainText('已取回');
  await expect(resume).toBeDisabled();
  cut = false;
  await context.setOffline(false);
  await expect(resume).toBeEnabled();
  await resume.click();

  const file = await readFile(await (await download).path());
  await expect(page.getByTestId('settings-export-status')).toContainText('已导出');

  // start 只调 1 次，全部 part 同一个任务；“继续”那次的游标就是断掉那次的
  const starts = calls.filter((c) => c.step === 'start');
  expect(starts).toHaveLength(1);
  const partCalls = calls.filter((c) => c.step === 'part');
  const exportId = partCalls[0]?.exportId;
  expect(typeof exportId).toBe('string');
  expect(partCalls.every((c) => c.exportId === exportId)).toBe(true);
  const cutAt = partCalls.findIndex((c) => c.aborted);
  expect(cutAt).toBeGreaterThan(0);
  const resumed = partCalls.slice(cutAt + 1).find((c) => !c.aborted);
  expect(resumed?.cursor).toBe(partCalls[cutAt]?.cursor);
  expect(partCalls[0]?.cursor).toBeNull();

  // 至少 2 片；游标首尾相接；存下的文件 = 各片按顺序拼起来
  expect(parts.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < parts.length; i++) expect(parts[i]?.cursor).toBe(parts[i - 1]?.next);
  expect(parts.at(-1)?.next).toBe('done');
  expect(file.equals(Buffer.concat(parts.map((p) => p.bytes)))).toBe(true);

  // 当天 account 次数只 +1；任务行分片数 = 服务器真收到的 part 次数（断掉的那几次没到服务器）
  const c = counters(acc.userId);
  const accountKeys = Object.entries(c).filter(([k]) => k.startsWith('account:'));
  expect(accountKeys.map(([, n]) => n)).toEqual([1]);
  const jobKeys = Object.entries(c).filter(([k]) => k.startsWith('export-job:'));
  expect(jobKeys).toHaveLength(1);
  expect(jobKeys[0]?.[1]).toBe(parts.length);

  // 整份解开是一份 JSON（多成员 gzip），notes 行数对
  const all = JSON.parse(gunzipSync(file).toString('utf8')) as { format?: unknown; version?: unknown; user_id?: unknown; tables?: Record<string, unknown[]> };
  expect(all.format).toBe('lemomemo-export');
  expect(all.version).toBe(1);
  expect(all.user_id).toBe(acc.userId);
  const notes = all.tables?.['notes'];
  expect(Array.isArray(notes) ? notes.length : -1).toBe(ROWS);

  // logs：正好一条 export、一条 export_done，code 都是这个任务
  const logs = await restInPage(page, 'GET', '/rest/v1/logs?select=act,code&src=eq.account&act=in.(export,export_done)&order=t.asc');
  expect(logs.status).toBe(200);
  expect(logs.body).toEqual([
    { act: 'export', code: exportId },
    { act: 'export_done', code: exportId },
  ]);
  // “最近的导出”不标“未完成”
  await expect(page.getByTestId('settings-recent-export-row')).toHaveCount(1);
  await expect(page.getByTestId('settings-recent-export-incomplete')).toHaveCount(0);

  // 不中断的对照：同一个任务、同一串游标再取一遍。服务器保证“数据没变时同一游标同样的字节”，但这次导出本身往 logs 写了
  // export_done（还有发信失败行），logs 也在导出范围里，所以按内容比：除 logs 以外每张表一模一样，logs 只多不少
  await page.unroute('**/sb/functions/v1/account');
  const again: Buffer[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < parts.length + 1; i++) {
    const r = await partInPage(page, exportId as string, cursor);
    expect(r.status).toBe(200);
    again.push(Buffer.from(r.b64, 'base64'));
    if (r.next === 'done') break;
    cursor = r.next;
  }
  const ref = JSON.parse(gunzipSync(Buffer.concat(again)).toString('utf8')) as typeof all;
  const { logs: refLogs = [], ...refRest } = ref.tables ?? {};
  const { logs: gotLogs = [], ...gotRest } = all.tables ?? {};
  expect(gotRest).toEqual(refRest);
  expect({ ...all, tables: null }).toEqual({ ...ref, tables: null });
  const ids = (rows: unknown[]): string[] => rows.map((r) => String((r as { id?: unknown }).id));
  expect(gotLogs.length).toBeGreaterThan(0);   // 至少有 start 写的那条 export
  expect(ids(gotLogs).every((x) => /^[0-9]+$/.test(x))).toBe(true);
  expect(ids(refLogs)).toEqual(expect.arrayContaining(ids(gotLogs)));
});
