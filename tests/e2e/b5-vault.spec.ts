// B5 隐私记客户端（S5～S9、S21）：真页面、真构建，/sb 在浏览器这一层答（假的 vault、vault-image 函数 + 随手记表），会话是假 JWT（session-fixture.ts）
// • 设密码两次 → 解锁 → 新建保存 → 列表有它 → 立即锁上 → 内容没了、出密码键盘 → 输错提示“还能再试 N 次” → 正确解锁
// • 隐私记页挂着时 <html data-rt="1">（底栏、“＋”实色，TC-B5-12），离开回随手记页去掉
// • 离开（blur）同步盖多任务遮罩（TC-B5-44），回来（focus，不到 1 分钟）去掉
// • 随手记“⋯”菜单、列表方式左滑两种方式“移到隐私记”：发 vault {action: import, note_id}，这一条在随手记页藏起来
// • Face ID：WebAuthn 不认 IP 当 RP ID（本组服务开在 127.0.0.1），e2e 跑不了；能不能用、取消回 null、两次没认出换密码键盘在 vitest 里测，真机另看
// 跑在快读组（playwright.fastread.config.ts，要带 supabase 地址的构建）；B5_SHOTS 设了目录时，chromium 顺手存浅色、深色两套截图（评审看，不进仓库）
import type { Page, Route } from '@playwright/test';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要 /sb 地址，只在快读组跑（npm run e2e:fastread）');
test.setTimeout(90_000);

const PIN = '2580';
const SHOTS = process.env['B5_SHOTS'] ?? '';
const V = '2026-10-29';

interface FakeVault {
  calls: { action: string; body: Record<string, unknown> }[];
  notes: Map<string, Record<string, unknown>>;
}

/** 假会话 + 浏览器这一层的假服务器 */
async function fakeServer(page: Page, baseURL: string | undefined): Promise<FakeVault> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const saved = new Map<string, Map<string, Record<string, unknown>>>([['notes', new Map()], ['settings', new Map()]]);
  await page.route(/\/sb\/rest\/v1\//, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const table = saved.get(u.pathname.split('/').pop() ?? '');
    if (req.method() === 'POST' && table) {
      const body: unknown = req.postDataJSON();
      for (const r of Array.isArray(body) ? body : [body]) {
        const row = r as Record<string, unknown>;
        if (typeof row['id'] === 'string') table.set(row['id'], { ...row, rev: 1, synced_at: new Date().toISOString() });
      }
      return route.fulfill({ status: 201, json: [{ rev: 1 }] });
    }
    if (req.method() !== 'GET') return route.fallback();
    if (table) return route.fulfill({ json: [...table.values()] });
    if (u.pathname.endsWith('/profiles')) return route.fulfill({ json: [{ user_id: '0e2e0000-0000-4000-8000-000000000001', consent_policy_ver: V }] });
    if (u.pathname.endsWith('/app_config') && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
    return route.fulfill({ json: [] });
  });

  const fv: FakeVault = { calls: [], notes: new Map() };
  let pin: string | null = null;
  let left = 5;
  const tok = () => ({ vault_token: `e2e-vault-token-${'x'.repeat(16)}`, expires_at: Date.now() + 600_000 });
  const ok = (route: Route, extra: Record<string, unknown> = {}) => route.fulfill({ json: { ok: true, ...tok(), ...extra } });
  const fail = (route: Route, status: number, body: Record<string, unknown>) => route.fulfill({ status, json: body });
  await page.route(/\/sb\/functions\/v1\/vault-image/, (route) => route.fulfill({ status: 404, json: { error: 'not_found' } }));
  await page.route(/\/sb\/functions\/v1\/vault(\?|$)/, (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const action = String(body['action']);
    fv.calls.push({ action, body });
    const now = Date.now();
    switch (action) {
      case 'status':
        return route.fulfill({ json: { ok: true, set: pin !== null, locked_until: null, last_reset_at: null, webauthn: 0 } });
      case 'setup':
        pin = String(body['pin']);
        return ok(route);
      case 'unlock':
        if (left <= 0) return fail(route, 423, { error: 'pin_locked', retry_after_s: 60 });
        if (body['pin'] !== pin) {
          left -= 1;
          if (left <= 0) return fail(route, 423, { error: 'pin_locked', retry_after_s: 60 });
          return fail(route, 403, { error: 'pin_wrong', left });
        }
        left = 5;
        return ok(route);
      case 'list':
        return ok(route, { notes: [...fv.notes.values()] });
      case 'save': {
        const id = String(body['id']);
        fv.notes.set(id, { id, title: body['title'], body: body['body'], category_id: null, created_at: body['created_at'], updated_at: body['updated_at'], deleted_at: null, images: [] });
        return ok(route);
      }
      case 'import': {
        const id = String(body['note_id']);
        fv.notes.set(id, { id, title: '', body: '从随手记移来', category_id: null, created_at: now, updated_at: now, deleted_at: null, images: [] });
        return ok(route);
      }
      default:
        return ok(route, { items: [] });
    }
  });
  return fv;
}

/** 在密码键盘上按一串数字再按“确定” */
async function typePin(page: Page, pad: string, digits: string): Promise<void> {
  for (const d of digits) await page.getByTestId(`${pad}-key-${d === '0' ? 9 : Number(d) - 1}`).click(); // 位置序号：1～9 是 key-0～key-8，0 是 key-9
  await page.getByTestId(`${pad}-ok`).click();
}

async function shot(page: Page, name: string, browserName: string): Promise<void> {
  if (!SHOTS || browserName !== 'chromium') return;
  // 线框是手机版：拍的时候临时换成 iPhone 15 的尺寸，拍完还原（chromium 项目平时是桌面宽）
  const size = page.viewportSize();
  await page.setViewportSize({ width: 393, height: 852 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${scheme}/${name}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (size) await page.setViewportSize(size);
  await page.waitForTimeout(150);
}

/** 设好密码、已解锁、列表空 */
async function setupAndUnlock(page: Page, browserName: string): Promise<void> {
  await page.goto('/app/#/vault');
  await expect(page.getByTestId('vault-setup')).toBeVisible({ timeout: 30_000 });
  await shot(page, '02-设密码', browserName);
  await typePin(page, 'vault-setup-pad', PIN);
  await expect(page.getByTestId('vault-setup')).toHaveAttribute('data-step', '2');
  await typePin(page, 'vault-setup-pad', PIN);
  await expect(page.getByTestId('vault-empty')).toBeVisible({ timeout: 15_000 });
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach('运行日志', { body: await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '').catch((e: unknown) => String(e)), contentType: 'text/plain' });
});

test('设密码 → 新建 → 上锁不留内容 → 输错提示剩余次数 → 解锁；页面挂着时底栏实色', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await expect(page.locator('html')).toHaveAttribute('data-rt', '1');

  await page.goto('/app/#/vault/new');
  await page.getByTestId('vault-edit-title').fill('体检报告');
  await page.getByTestId('vault-edit-body').fill('血压 120/80');
  await shot(page, '07-编辑页', browserName);
  await page.getByTestId('vault-edit-save').click();
  await expect.poll(() => fv.calls.filter((c) => c.action === 'save').length).toBe(1);
  await page.getByTestId('vault-edit-back').click();
  await expect(page.getByTestId('vault-list')).toContainText('体检报告');
  await shot(page, '06-解锁后的列表', browserName);

  await page.getByTestId('vault-lock-now').click();
  await expect(page.getByTestId('vault-unlock-pinview')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('血压 120/80');
  await expect(page.locator('body')).not.toContainText('体检报告');
  await shot(page, '03-解锁卡', browserName);

  await typePin(page, 'vault-unlock-pad', '1111');
  await expect(page.getByTestId('vault-unlock-err')).toContainText('4');
  await shot(page, '04-输错', browserName);
  await typePin(page, 'vault-unlock-pad', PIN);
  await expect(page.getByTestId('vault-list')).toContainText('体检报告', { timeout: 15_000 });
  // 11-14 整块评审第 1、14 条：密码键盘的点按在运行日志里只记 masked（没有 testid、坐标）；隐私记状态迁移记了，标题、正文没进日志
  const runLog = (): Promise<string> => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  await expect.poll(runLog).toMatch(/app vault state unlocked/);
  const log = await runLog();
  expect(log).toMatch(/(down|click) masked/);
  expect(log).not.toMatch(/pad-key|pad-k\d|masked[^\n]*x=\d/);
  for (const secret of ['体检报告', '血压']) expect(log).not.toContain(secret);   // 密码本身不比：日志里的耗时数字可能碰巧含这几位，键位由上一行管

  await page.getByTestId('vault-back').click();
  await expect(page.getByTestId('notes')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-rt', '1');
  await shot(page, '01-入口行', browserName);
});

test('离开时同步盖多任务遮罩，不到 1 分钟回来自动去掉、仍解锁', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('html')).toHaveAttribute('data-vault-shield', '1');
  await expect(page.getByTestId('vault-shield')).toBeVisible();
  await shot(page, '08-多任务遮罩', browserName);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('html')).not.toHaveAttribute('data-vault-shield', '1');
  await expect(page.getByTestId('vault-empty')).toBeVisible();
});

test('随手记“⋯”菜单移到隐私记：发 import，这一条从随手记页藏起来', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/notes');
  await page.getByTestId('notes-input').fill('要移走的一条');
  await page.getByTestId('notes-add').click();
  const card = page.locator('[data-testid^="notes-card-"]').filter({ hasText: '要移走的一条' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const id = (await card.getAttribute('data-testid'))?.replace('notes-card-', '') ?? '';
  await expect(page.getByTestId('vault-lockrow')).toBeVisible();
  await page.getByTestId(`notes-more-${id}`).click();
  await page.getByTestId(`notes-to-vault-${id}`).click();
  await expect.poll(() => fv.calls.find((c) => c.action === 'import')?.body['note_id']).toBe(id);
  await expect(card).toHaveCount(0);
});

test('列表方式左滑：出“转成待办 / 移到隐私记 / 删除”，点“移到隐私记”发 import', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/settings/notes-view');
  // 单选框藏在文字下面（文字那层接点按）：点文字
  await page.getByText('列表', { exact: true }).click();
  await expect(page.getByTestId('settings-notes-view-list')).toBeChecked();
  await page.goto('/app/#/notes');
  await page.getByTestId('notes-input').fill('左滑的一条');
  await page.getByTestId('notes-add').click();
  const row = page.locator('[data-testid^="notes-row-"]').filter({ hasText: '左滑的一条' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const id = (await row.getAttribute('data-testid'))?.replace('notes-row-', '') ?? '';
  // 输入行还聚焦着时整页盖着模糊层（R-401）：先让它失焦
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // 新行淡入、入口行晚到会让位置变一下：等它停稳再量
  await page.waitForTimeout(600);
  const box = await page.getByTestId(`notes-swipe-${id}`).boundingBox();
  if (!box) throw new Error('没有行');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 40, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width - 40 - i * 22, y);
  await page.mouse.up();
  await expect(page.getByTestId(`notes-swipe-${id}`)).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId(`notes-sw-vault-${id}`)).toBeVisible();
  await shot(page, '10-左滑按钮', browserName);
  await page.getByTestId(`notes-sw-vault-${id}`).click();
  await expect.poll(() => fv.calls.find((c) => c.action === 'import')?.body['note_id']).toBe(id);
  await expect(row).toHaveCount(0);
});

test('设置 › 隐私记：已设密码时有自动上锁、改密码、忘记密码', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/settings/vault');
  await expect(page.getByTestId('vault-settings')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('vault-set-change')).toBeVisible();
  await expect(page.getByTestId('vault-set-forgot')).toBeVisible();
  await expect(page.getByTestId('vault-set-autolock')).toBeVisible();
  await shot(page, '09-设置隐私记', browserName);
});

test('连续输错 5 次：锁定倒计时，键盘不能按', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.getByTestId('vault-lock-now').click();
  for (let i = 0; i < 5; i++) await typePin(page, 'vault-unlock-pad', '0000');
  await expect(page.getByTestId('vault-unlock-pad-key-0')).toBeDisabled();
  // 服务器说 60 秒：倒计时不能比 60 秒多（原来按卡片挂上时的时间算，显示过“1 分 2 秒”）
  await expect(page.getByText(/输错次数太多，(1 分 0 秒|\d+ 秒) 后再试/)).toBeVisible();
  await shot(page, '05-锁定倒计时', browserName);
});
