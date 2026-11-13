// B4b-1 随手记附件的界面（线框 sAtt、sPrev；架构 5.13 第 1～4、12 点）：/sb 在浏览器这一层答（一条带 3 个附件的随手记、PATCH 软删、file-check），签名和取字节也在这一层假装
//   ① 电脑（1280 宽）：“附件 3 · 共 …”、类型标记、正在检查的写“正在检查…”、带宏的只给下载并写明原因；“加附件”在；
//     “⋯ › 预览”打开全窗口浮层，PDF 在没有来源的沙箱里画出来、顶行“第 1 / 2 页”，“›”翻页，Esc 关；
//     “⋯ › 下载”走浏览器下载，文件名是清理过的原名；“⋯ › 删除”出“已删除 · 撤销”
//   ② 手机（390 宽）：没有“加附件”，写“文档请在电脑上加”；“⋯”里没有删除
//   ③ 离线：“加附件”变灰写“加附件需要联网”，没看过的附件写“离线时打不开”
//   ④ 加附件：选一个 PDF → 写行（POST note_files）→ PUT /files/v1/o/files/<用户>/<随手记>/<id>.pdf（包体就是原字节）→ file-check {action: check, id}；运行日志只有结果码、没有文件名
// 跑在快读组（playwright.fastread.config.ts）：签名要会话令牌，默认组的构建没配 supabase 地址，取不到令牌（日志 att view sign denied code=no_session）
// 截图：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（WebKit 截图会往页面插 <style>、被 CSP 记成违规）；断言两种浏览器都跑
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要会话令牌和 /sb 地址，只在快读组跑（npm run e2e:fastread）');
test.setTimeout(90_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'];
async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

const USER = '0e2e0000-0000-4000-8000-000000000001';
const NOTE = '0e2e0000-0000-4000-8000-0000000b4b01';
const F_PDF = '019a0000-0000-7000-8000-0000000b4b11';
const F_XLSM = '019a0000-0000-7000-8000-0000000b4b12';
const F_DOCX = '019a0000-0000-7000-8000-0000000b4b13';

const PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]>>endobj',
  '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n');
const PDF_BYTES = Buffer.from(PDF, 'latin1');

async function sha256(b: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(b).digest('hex');
}

const V = '2026-10-29';

/** 服务器上的行：一条随手记、3 个附件（PDF 能预览、xlsm 只能下载、docx 还在检查） */
async function serverRows(): Promise<Map<string, Map<string, Record<string, unknown>>>> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const common = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const note = { id: NOTE, ...common, title: '外国人登录证更新要带的', body: '护照、照片 1 张、手续费 3 万韩元。', is_private: false, category_id: null, category_source: 'none', category_seen: true, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null };
  const file = (id: string, kind: string, name: string, bytes: number, sha: string, check: string) => ({
    id, ...common, note_id: NOTE, kind, path: `${USER}/${NOTE}/${id}.${kind}`, has_thumb: false, is_vault: false, name, mime: 'x', bytes, sha256: sha, pages: null, text_excerpt: null, check_status: check, etag: null,
  });
  const files = [
    file(F_PDF, 'pdf', '出入境申请表.pdf', PDF_BYTES.length, await sha256(PDF_BYTES), 'ok'),
    file(F_XLSM, 'xlsm', '报价单_含公式.xlsm', 220 * 1024, 'a'.repeat(64), 'ok'),
    file(F_DOCX, 'docx', '在职证明.docx', 86 * 1024, 'b'.repeat(64), 'pending'),
  ];
  type Rows = Map<string, Record<string, unknown>>;
  return new Map<string, Rows>([['notes', new Map([[NOTE, note]])], ['note_files', new Map(files.map((f) => [f.id, f]))]]);
}

type Fake = { asked: string[]; puts: { path: string; body: Buffer | null }[]; checks: unknown[] };

/** 假会话 + /sb（随手记、附件两张表：GET 回行、POST 新建回 201、PATCH 改了回新 rev）+ file-check 回 ok + 假签名、假取字节、假上传 */
async function fakeServer(page: Page, baseURL: string | undefined): Promise<Fake> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const saved = await serverRows();
  await page.route(/\/sb\/rest\/v1\//, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const table = saved.get(u.pathname.split('/').pop() ?? '');
    if (req.method() === 'POST' && table) {
      const body: unknown = req.postDataJSON();
      for (const r of Array.isArray(body) ? body : [body]) {
        const row = r as Record<string, unknown>;
        if (typeof row['id'] === 'string') table.set(row['id'], { check_status: 'pending', ...row, rev: 1, synced_at: new Date().toISOString() });
      }
      return route.fulfill({ status: 201, json: [{ rev: 1 }] });
    }
    if (req.method() === 'PATCH' && table) {
      const id = (u.searchParams.get('id') ?? '').replace(/^eq\./, '');
      const old = table.get(id);
      if (!old) return route.fulfill({ json: [] });
      const rev = Number(old['rev']) + 1;
      table.set(id, { ...old, ...(req.postDataJSON() as Record<string, unknown>), rev });
      return route.fulfill({ json: [{ rev }] });
    }
    if (req.method() !== 'GET') return route.fallback();
    if (table) return route.fulfill({ json: [...table.values()] });
    if (u.pathname.endsWith('/profiles')) return route.fulfill({ json: [{ user_id: USER, consent_policy_ver: V }] });
    if (u.pathname.endsWith('/app_config') && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
    return route.fulfill({ json: [] });
  });
  const fake: Fake = { asked: [], puts: [], checks: [] };
  await page.route(/\/sb\/functions\/v1\/file-check/, (route) => {
    fake.checks.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: 'ok' } });
  });
  await page.route(/\/files\/v1\/sign$/, async (route) => {
    const body = route.request().postDataJSON() as { items: { bucket: string; path: string; purpose: string }[] };
    const origin = new URL(route.request().url()).origin;
    const items = body.items.map((x, i) => {
      fake.asked.push(x.purpose);
      return { i, ok: true, url: `${origin}/files/v1/o/${x.bucket}/${x.path}`, sig: `p=${x.purpose}&e=9999999999&s=e2e` };
    });
    await route.fulfill({ json: { items } });
  });
  await page.route(/\/files\/v1\/o\/files\//, (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      fake.puts.push({ path: new URL(req.url()).pathname, body: req.postDataBuffer() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"etag":"e2e"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: PDF_BYTES });
  });
  return fake;
}

async function openNote(page: Page): Promise<void> {
  await page.goto(`/app/#/note/${NOTE}`);
  await expect(page.getByTestId('note-files')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`note-file-${F_PDF}`)).toBeVisible();
  await expect(page.getByTestId('note-edit-title'), '编辑器能编辑（这条行已读好、不是只读）').toBeEnabled();
  await page.waitForTimeout(FADE_GUARD_MS);
}

const runLog = (page: Page) => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');

// 失败时把运行日志附进报告（先看日志再定根因）
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const path = info.outputPath('run-log.txt');
  writeFileSync(path, await runLog(page).catch((e: unknown) => String(e)));
  await info.attach('运行日志', { path, contentType: 'text/plain' });
});

test.describe('B4b-1 附件：电脑', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('列表、只能下载的说明、预览浮层翻页和 Esc、下载、删除撤销', async ({ page, baseURL, browserName }) => {
    const { asked } = await fakeServer(page, baseURL);
    await openNote(page);
    const box = page.getByTestId('note-files');
    await expect(box).toContainText('附件 3');
    await expect(page.getByTestId(`note-file-${F_DOCX}`)).toContainText('正在检查');
    await expect(page.getByTestId(`note-file-${F_XLSM}`)).toContainText('这个文件可能含宏，只能下载后用 Office 打开');
    await expect(page.getByTestId('note-files-add')).toBeEnabled();
    await shot(page, browserName, 'desk-list');

    // 预览：全窗口浮层、沙箱里画出 PDF、翻页、Esc 关
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    await page.getByTestId(`note-file-preview-${F_PDF}`).click();
    await expect(page.getByTestId('att-preview')).toBeVisible();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 1 / 2 页', { timeout: 15_000 });
    await expect(page.frameLocator('[data-testid="att-pv-frame"]').locator('canvas').first()).toBeVisible();
    expect(await page.getByTestId('att-pv-frame').getAttribute('sandbox')).toBe('allow-scripts');
    await shot(page, browserName, 'desk-preview-pdf');
    await page.getByTestId('att-pv-next').click();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 2 / 2 页', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('att-preview')).toHaveCount(0);
    expect(asked).toContain('view');

    // 下载：浏览器下载，文件名是原名
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    const dl = page.waitForEvent('download');
    await page.getByTestId(`note-file-download-${F_PDF}`).click();
    expect((await dl).suggestedFilename()).toBe('出入境申请表.pdf');

    // 删除 → 撤销
    await page.getByTestId(`note-file-more-${F_XLSM}`).click();
    await page.getByTestId(`note-file-delete-${F_XLSM}`).click();
    await expect(page.getByTestId('note-files-undo')).toContainText('已删除');
    await expect(page.getByTestId(`note-file-${F_XLSM}`)).toHaveCount(0);
    await page.getByTestId('note-files-undo').getByRole('button').click();
    await expect(page.getByTestId(`note-file-${F_XLSM}`)).toBeVisible();
  });

  test('加附件：写行 → 上传原字节 → file-check；运行日志没有文件名', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openNote(page);
    await page.getByTestId('note-files-input').setInputFiles({ name: '报价说明.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES });
    await expect.poll(() => fake.puts.length, { timeout: 30_000, message: '传了一次原文件' }).toBe(1);
    const put = fake.puts[0];
    expect(put?.path).toMatch(new RegExp(`^/files/v1/o/files/${USER}/${NOTE}/[0-9a-f-]{36}\\.pdf$`));
    // WebKit 的 Playwright 拿不到 Blob 包体（postDataBuffer 为空），包体只在 chromium 核
    if (browserName === 'chromium') expect(put?.body?.equals(PDF_BYTES), '包体就是原字节').toBe(true);
    await expect.poll(() => fake.checks.length, { timeout: 15_000 }).toBe(1);
    expect(fake.checks[0]).toMatchObject({ action: 'check' });
    await expect(page.getByTestId('note-files')).toContainText('附件 4');
    await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/att prep ok kind=pdf/);
    expect(await runLog(page)).not.toContain('报价说明');
  });

  test('离线：加附件变灰，没看过的附件写“离线时打不开”', async ({ page, context, baseURL, browserName }) => {
    await fakeServer(page, baseURL);
    await openNote(page);
    await context.setOffline(true);
    try {
      await expect(page.getByTestId('note-files-add')).toBeDisabled();
      await expect(page.getByTestId('note-files-offline')).toHaveText('加附件需要联网');
      await expect(page.getByTestId(`note-file-${F_PDF}`)).toContainText('离线时打不开');
      await shot(page, browserName, 'desk-offline');
    } finally {
      await context.setOffline(false);
    }
  });

  test('深色', async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium' || !SHOT_DIR, '只截图');
    await page.emulateMedia({ colorScheme: 'dark' });
    await fakeServer(page, baseURL);
    await openNote(page);
    await shot(page, browserName, 'desk-list-dark');
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    await page.getByTestId(`note-file-preview-${F_PDF}`).click();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 1 / 2 页', { timeout: 15_000 });
    await shot(page, browserName, 'desk-preview-pdf-dark');
  });
});

test.describe('B4b-1 附件：手机', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('没有“加附件”、写“文档请在电脑上加”；“⋯”里没有删除；预览整屏、底部下载', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL);
    await openNote(page);
    await expect(page.getByTestId('note-files-add')).toHaveCount(0);
    await expect(page.getByTestId('note-files-phone')).toHaveText('文档请在电脑上加。手机上可以看、预览、下载。');
    await shot(page, browserName, 'phone-list');
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    await expect(page.getByTestId(`note-file-preview-${F_PDF}`)).toBeVisible();
    await expect(page.getByTestId(`note-file-delete-${F_PDF}`)).toHaveCount(0);
    await page.getByTestId(`note-file-preview-${F_PDF}`).click();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 1 / 2 页', { timeout: 15_000 });
    await expect(page.getByTestId('att-pv-download')).toBeVisible();
    await shot(page, browserName, 'phone-preview-pdf');
    if (browserName === 'chromium' && SHOT_DIR) {
      await page.getByTestId('att-pv-close').click();
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, browserName, 'phone-list-dark');
    }
  });
});
