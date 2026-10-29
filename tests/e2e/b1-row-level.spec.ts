// B1 K16：B1 接手清单 T1（TC-B0-89 里两条行级断言不是授权格，要不要另立用例）
//
// QA 的判断：
//   ① devices“只能动本会话那一行”：真库 pgTAP 已由 D-12 的 12 条覆盖（supabase/tests/rls/01_client_rls.test.sql，
//      改、删别的会话的行和 session_id 为空的行各两条，本机一行能改能删作对照），不再另立 pgTAP 用例；
//      这里加一条覆盖守门（现在就跑）：那几条断言被删掉或改掉就失败。
//   ② report_tz_impl“只改自己的行”（N2）：函数随 B1 新迁移建（架构 0.31 第 23 条），B0 里没有，D-12 管不到，要另立：
//      守门条在迁移里出现 private.report_tz_impl 之后，要求 supabase/tests/rls/ 里有提到它的断言；迁移还没建时跳过并写明原因。
//   ③ 两条都补一遍真登录的端到端（经 /sb、浏览器里真的会话 JWT）：登录页 K4 已有、选择器已对上，仍用 test.fixme 标着（缺真后端）；
//      另需 e2e 的 /sb 接本地 Supabase ＋ Mailpit（现在 SUPABASE_UPSTREAM 指向假后端，假后端没有 RLS）。
// 守门条只读仓库文件，和浏览器无关，只在 chromium project 跑一次。
import { type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './csp-fixture.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const RLS_DIR = join(ROOT, 'supabase', 'tests', 'rls');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

function readAll(dir: string, ext: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
}

/** 去掉 SQL 的 -- 行注释，免得注释里提到就算“有断言” */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

test.describe('T1 覆盖守门（只读仓库文件）', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', '和浏览器无关，只在 chromium project 跑一次');

  test('① devices 只能动本会话那一行：D-12 的 pgTAP 断言都还在（改、删别的会话和空会话的行；本机一行作对照）', () => {
    const sql = stripComments(readFileSync(join(RLS_DIR, '01_client_rls.test.sql'), 'utf8'));
    // 0b = 同一用户另一会话的设备，0c = session_id 为空的设备，0d = 本机那一行（对照）
    const id = (n: string) => `de000000-0000-4000-8000-00000000000${n}`;
    const upd = (n: string) => new RegExp(`update public\\.devices set [^$]*where id = '${id(n)}'`);
    const del = (n: string) => new RegExp(`delete from public\\.devices where id = '${id(n)}'`);
    const checks: [string, RegExp][] = [
      ['改另一会话的设备', upd('b')],
      ['删另一会话的设备', del('b')],
      ['改 session_id 为空的设备', upd('c')],
      ['删 session_id 为空的设备', del('c')],
      ['对照：改本机设备', upd('d')],
      ['对照：删本机设备', del('d')],
    ];
    for (const [what, re] of checks) expect(sql, what).toMatch(re);
    // 每种反例都核对了“行不变”（读回 label 或行数）
    for (const n of ['b', 'c']) {
      expect(sql, `设备 ${n} 读回核对`).toMatch(new RegExp(`select (label|count\\(\\*\\)::int) from public\\.devices where id = '${id(n)}'`));
    }
  });

  test('② report_tz_impl 只改自己的行：迁移建了函数，就要有对应的 pgTAP 断言', () => {
    const defined = readAll(MIGRATIONS_DIR, '.sql').filter((m) =>
      /create\s+(or\s+replace\s+)?function\s+private\.report_tz_impl\b/i.test(stripComments(m.text)),
    );
    test.skip(defined.length === 0, 'B1 迁移还没建 private.report_tz_impl（架构 0.31 第 23 条），建了以后这一条自动生效');
    const asserting = readAll(RLS_DIR, '.sql').filter((f) => /report_tz(_impl)?\s*\(/.test(stripComments(f.text)));
    expect(
      asserting.map((f) => f.name),
      `迁移 ${defined.map((m) => m.name).join('、')} 建了 report_tz_impl，supabase/tests/rls/ 里要有“B 调它改不到 A 的行”的断言`,
    ).not.toEqual([]);
  });
});

// ───────── 真登录的端到端（选择器已按 K4 的登录页 src/features/auth/ui/AuthPage.tsx 对上；仍要真后端）─────────

const LOCAL = ['127.0.0.1', 'localhost', '[::1]'];

async function seedAccount(request: APIRequestContext): Promise<string> {
  const api = process.env['LEMO_E2E_SB_API'] ?? 'http://127.0.0.1:54321';
  const key = process.env['LEMO_E2E_SB_SERVICE_KEY'] ?? '';
  expect(LOCAL).toContain(new URL(api).hostname);
  expect(key, '准备步骤要设 LEMO_E2E_SB_SERVICE_KEY（本机 supabase status 的演示值）').not.toBe('');
  const email = `e2e-${randomUUID().slice(0, 8)}@lemomemo.test`;
  const r = await request.post(`${api}/auth/v1/admin/users`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    data: { email, email_confirm: true },
  });
  expect(r.status()).toBe(200);
  return email;
}

async function otpFromMailpit(request: APIRequestContext, email: string): Promise<string> {
  const base = process.env['LEMO_E2E_MAILPIT_URL'] ?? 'http://127.0.0.1:54324';
  expect(LOCAL).toContain(new URL(base).hostname);
  let id = '';
  await expect
    .poll(async () => {
      const r = await request.get(`${base}/api/v1/search`, { params: { query: `to:"${email}"` } });
      id = ((await r.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID ?? '';
      return id;
    }, { timeout: 15_000 })
    .not.toBe('');
  const msg = (await (await request.get(`${base}/api/v1/message/${id}`)).json()) as { Text?: string };
  return /\b(\d{6})\b/.exec(msg.Text ?? '')?.[1] ?? '';
}

/** 新开一个浏览器上下文（引擎默认的桌面环境，不会被“添加到主屏幕”拦）并走网页登录；同一邮箱再登一次就是第二个会话 */
async function loginNewSession(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Turnstile 换成假脚本（给 Cloudflare 官方的假令牌）：本地 Supabase 的 CAPTCHA 要么关着、要么配官方测试 secret
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: "window.turnstile = { render(el, o) { setTimeout(() => o.callback && o.callback('XXXX.DUMMY.TOKEN.XXXX'), 0); return 'w'; }, reset() {}, remove() {} };",
    }),
  );
  await page.goto('/app/auth/');
  // 邮箱框的 label 是“邮箱”，验证码框是“邮箱里的 6 位验证码”，所以邮箱要精确匹配；填满 6 位自动提交，没有“登录”按钮
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill(email);
  await page.getByRole('button', { name: '发验证码' }).click();
  await page.getByRole('textbox', { name: '邮箱里的 6 位验证码' }).fill(await otpFromMailpit(page.request, email));
  await expect(page).toHaveURL(/\/app\/(#\/.*)?$/);
  await expect(page.locator('main[data-feature]')).toBeVisible();
  return page;
}

interface Rest {
  status: number;
  body: unknown;
}

/** 在页面里用本页会话的 access token 经 /sb 打 REST（和 App 走同一条路） */
async function rest(page: Page, method: string, path: string, data?: unknown): Promise<Rest> {
  return page.evaluate(
    async ({ method, path, data, anon }) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('sb-') && k.endsWith('-auth-token')) ?? '';
      const token = (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token ?? '';
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-App-Version': '4.0.0',
        Prefer: 'return=representation',
      };
      if (anon) headers['apikey'] = anon;
      const r = await fetch(`/sb${path}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const text = await r.text();
      return { status: r.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    { method, path, data, anon: process.env['LEMO_E2E_SB_ANON_KEY'] ?? '' },
  );
}

test.describe('T1 真登录端到端（经 /sb，真会话 JWT）', () => {
  test.fixme('① devices：B 改删不到 A 的设备；A 的第二个会话改删不到第一个会话的设备；本机一行能改【需真后端：e2e 的 /sb 现在接假后端，没有 RLS、不发验证码；要 /sb 接本地 Supabase ＋ Mailpit 才能跑】', async ({ browser, request }) => {
    const emailA = await seedAccount(request);
    const emailB = await seedAccount(request);
    const a1 = await loginNewSession(browser, emailA);
    const a2 = await loginNewSession(browser, emailA);
    const b = await loginNewSession(browser, emailB);

    const dev = randomUUID();
    const made = await rest(a1, 'POST', '/rest/v1/devices', { id: dev, platform: 'web', label: 'A 会话1' });
    expect(made.status).toBe(201);

    for (const [who, page] of [['B', b], ['A 会话2', a2]] as const) {
      const p = await rest(page, 'PATCH', `/rest/v1/devices?id=eq.${dev}`, { label: `${who}改的` });
      expect([p.status, p.body], `${who} 改`).toEqual([200, []]);
      const d = await rest(page, 'DELETE', `/rest/v1/devices?id=eq.${dev}`);
      expect([d.status, d.body], `${who} 删`).toEqual([200, []]);
    }
    const still = await rest(a1, 'GET', `/rest/v1/devices?id=eq.${dev}&select=label`);
    expect(still.body).toEqual([{ label: 'A 会话1' }]);

    // 对照：本机那一行能改
    const own = await rest(a1, 'PATCH', `/rest/v1/devices?id=eq.${dev}`, { label: '本机改的' });
    expect((own.body as unknown[]).length).toBe(1);
  });

  test.fixme('② report_tz：B 带 A 的 device_id 调，A 的时区不变【等 B1 的 report_tz 迁移；另需真后端：/sb 接本地 Supabase ＋ Mailpit】', async ({ browser, request }) => {
    const a = await loginNewSession(browser, await seedAccount(request));
    const b = await loginNewSession(browser, await seedAccount(request));
    const dev = randomUUID();
    expect((await rest(a, 'POST', '/rest/v1/devices', { id: dev, platform: 'web', label: 'A' })).status).toBe(201);
    const before = await rest(a, 'GET', '/rest/v1/profiles?select=current_tz,current_tz_device,current_tz_at');

    // 参数名按架构 4.6 的 report_tz(tz, device_id, platform)；B1 迁移定稿后对一遍
    await rest(b, 'POST', '/rest/v1/rpc/report_tz', { tz: 'Pacific/Kiritimati', device_id: dev, platform: 'web' });

    const after = await rest(a, 'GET', '/rest/v1/profiles?select=current_tz,current_tz_device,current_tz_at');
    expect(after.body).toEqual(before.body);
  });
});
