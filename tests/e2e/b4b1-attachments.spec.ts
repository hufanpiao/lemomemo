// B4b-1 随手记附件的界面（线框 sAtt、sPrev；架构 5.13 第 1～4、12 点）：/sb 在浏览器这一层答（一条带 5 个附件的随手记、PATCH 软删、file-check），签名和取字节也在这一层假装
//   ① 电脑（1280 宽）：“附件 5 · 共 …”、大小后面 PDF / PPT 写“· N 页”、Excel 写“· N 张表”，有缩略图的显示缩略图；正在检查的写“正在检查…”；带宏的只给下载并写明原因；
//     “⋯ › 预览”打开全窗口浮层，中文 PDF（夹具 b4b1-zh-2p.pdf）在没有来源的沙箱里画出字、顶行“第 1 / 2 页”，左侧页缩略图，“›”翻页，Esc 关；
//     “⋯ › 下载”走浏览器下载，文件名是清理过的原名；“⋯ › 删除”出“已删除 · 撤销”
//   ② PPT：第一次先问（“这台设备只问一次，可以在 设置 › 数据 里改”），点“预览”嵌微软；微软 20 秒没加载出来退回“缩略图和每页文字”，带“再试一次 / 下载”
//   ③ 手机（390 宽）：没有“加附件”，写“文档请在电脑上加”；“⋯”里 预览 / 下载 / 用其他 App 打开、没有删除；预览底部“下载 / 用其他 App 打开”
//   ④ 离线：“加附件”变灰写“加附件需要联网”，没看过的附件写“离线时打不开”
//   ⑤ 加附件：选一个 PDF → 隐藏沙箱抽页数、文字、首页缩略图 → 写行（has_thumb、pages、text_excerpt）→ PUT 原文件、PUT <id>.t.webp → file-check；运行日志只有结果码、没有文件名
//   ⑥ 随手记页：瀑布流卡片、列表行尾“附件 5”；转成待办、移到隐私记的确认框写上附件个数（D5）
//   ⑦ 附件区拖进来的图片插不进去时出提示（D6）
//   ⑧ 设置 › 数据：PPT 预览两行（随手记、隐私记），先问 / 预览 / 只下载，只记在本机
// 跑在快读组（playwright.fastread.config.ts）：签名要会话令牌，默认组的构建没配 supabase 地址，取不到令牌（日志 att view sign denied code=no_session）
// 截图：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（WebKit 截图会往页面插 <style>、被 CSP 记成违规）；断言两种浏览器都跑
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { utils, write } from 'xlsx';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要会话令牌和 /sb 地址，只在快读组跑（npm run e2e:fastread）');
test.setTimeout(120_000);
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
const F_XLSX = '019a0000-0000-7000-8000-0000000b4b14';
const F_PPTX = '019a0000-0000-7000-8000-0000000b4b15';

/** 中文 PDF（2 页、内嵌黑体子集，PyMuPDF 生成）：要亲眼看到 pdf.js 画出了字 */
const PDF_BYTES = readFileSync(join(import.meta.dirname, 'fixtures', 'b4b1-zh-2p.pdf'));

/** 3 页 PPT；thumb = PowerPoint 自带的首页缩略图 docProps/thumbnail.jpeg（微软打不开时退回“首页缩略图 + 每页文字”） */
async function pptxBytes(thumb: Buffer): Promise<Buffer> {
  const z = new JSZip();
  z.file('docProps/thumbnail.jpeg', thumb);
  const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  // 本机判型要 [Content_Types].xml 里有 PPT 的主部件类型（shared/logic/files/file-sniff.ts）
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>');
  z.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
  ['韩国生活分享', '外国人登录证怎么办', '租房：전세 和 월세'].forEach((t, i) => z.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld xmlns:p="x" ${a}><a:t>${t}</a:t></p:sld>`));
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function xlsxBytes(): Buffer {
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet([['日期', '项目', '金额'], ['10/02', '签证手续费', 30000]]), '汇总');
  utils.book_append_sheet(wb, utils.aoa_to_sheet([['明细']]), '明细');
  return write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function sha256(b: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(b).digest('hex');
}

const V = '2026-10-29';

/** 列表缩略图：在空白页的 canvas 上画一张“首页”（真实的缩略图由加附件那条用例经隐藏沙箱生成并核对） */
async function thumbPng(page: Page, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Buffer> {
  const b64 = await page.evaluate((type) => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 160;
    const g = c.getContext('2d');
    if (!g) return '';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 120, 160);
    g.fillStyle = '#111';
    g.font = 'bold 14px sans-serif';
    g.fillText('申请表', 12, 26);
    g.fillStyle = '#bbb';
    for (let i = 0; i < 8; i++) g.fillRect(12, 42 + i * 13, 96 - (i % 3) * 18, 5);
    return c.toDataURL(type).split(',')[1] ?? '';
  }, type);
  return Buffer.from(b64, 'base64');
}

type Bytes = Map<string, Buffer>;

/** 服务器上的行：一条随手记、5 个附件（PDF 2 页带缩略图、xlsm 只能下载、docx 还在检查、xlsx 2 张表、pptx 3 页） */
async function serverRows(bytes: Bytes, pptThumb: Buffer): Promise<Map<string, Map<string, Record<string, unknown>>>> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const common = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const note = { id: NOTE, ...common, title: '外国人登录证更新要带的', body: '护照、照片 1 张、手续费 3 万韩元。', is_private: false, category_id: null, category_source: 'none', category_seen: true, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null };
  const file = async (id: string, kind: string, name: string, b: Buffer | number, check: string, pages: number | null, thumb = false) => {
    const path = `${USER}/${NOTE}/${id}.${kind}`;
    if (typeof b !== 'number') bytes.set(`/files/v1/o/files/${path}`, b);
    return {
      id, ...common, note_id: NOTE, kind, path, has_thumb: thumb, is_vault: false, name, mime: 'x', bytes: typeof b === 'number' ? b : b.length,
      sha256: typeof b === 'number' ? 'a'.repeat(64) : await sha256(b), pages, text_excerpt: null, check_status: check, etag: null,
    };
  };
  const files = [
    await file(F_PDF, 'pdf', '出入境申请表.pdf', PDF_BYTES, 'ok', 2, true),
    await file(F_XLSM, 'xlsm', '报价单_含公式.xlsm', 220 * 1024, 'ok', null),
    await file(F_DOCX, 'docx', '在职证明.docx', 86 * 1024, 'pending', null),
    await file(F_XLSX, 'xlsx', '费用明细.xlsx', xlsxBytes(), 'ok', 2),
    await file(F_PPTX, 'pptx', '韩国生活分享.pptx', await pptxBytes(pptThumb), 'ok', 3),
  ];
  type Rows = Map<string, Record<string, unknown>>;
  return new Map<string, Rows>([['notes', new Map([[NOTE, note]])], ['note_files', new Map(files.map((f) => [f.id, f]))], ['settings', new Map()]]);
}

type Fake = { asked: string[]; puts: { path: string; body: Buffer | null }[]; checks: unknown[]; rows: Map<string, Record<string, unknown>> };

/** 假会话 + /sb（随手记、附件、设置三张表：GET 回行、POST 新建回 201、PATCH 改了回新 rev）+ file-check 回 ok（顺手把行改成 ok）+ 假签名、假取字节、假上传 */
async function fakeServer(page: Page, baseURL: string | undefined): Promise<Fake> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const bytes: Bytes = new Map();
  const saved = await serverRows(bytes, await thumbPng(page, 'image/jpeg'));
  bytes.set(`/files/v1/o/files/${USER}/${NOTE}/${F_PDF}.t.webp`, await thumbPng(page));
  const fileRows = saved.get('note_files') ?? new Map();
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
  const fake: Fake = { asked: [], puts: [], checks: [], rows: fileRows };
  await page.route(/\/sb\/functions\/v1\/file-check/, (route) => {
    const body = route.request().postDataJSON() as { id: string };
    fake.checks.push(body);
    const r = fileRows.get(body.id);
    if (r) fileRows.set(body.id, { ...r, check_status: 'ok', rev: Number(r['rev']) + 1 });
    return route.fulfill({ json: { status: 'ok' } });
  });
  await page.route(/\/files\/v1\/sign$/, async (route) => {
    const body = route.request().postDataJSON() as { items: { bucket: string; path: string; purpose: string }[] };
    const origin = new URL(route.request().url()).origin;
    const items = body.items.map((x, i) => {
      fake.asked.push(x.purpose);
      // ms（交给微软）的签名留在查询串、不带 sig 字段（platform/files.ts、files-url.ts 的 checkMsUrl）
      if (x.purpose === 'ms') return { i, ok: true, url: `${origin}/files/v1/o/${x.bucket}/${x.path}?e=9999999999&s=e2e` };
      return { i, ok: true, url: `${origin}/files/v1/o/${x.bucket}/${x.path}`, sig: `p=${x.purpose}&e=9999999999&s=e2e` };
    });
    await route.fulfill({ json: { items } });
  });
  await page.route(/\/files\/v1\/o\/files\//, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'PUT') {
      const body = req.postDataBuffer();
      fake.puts.push({ path, body });
      if (body?.length) bytes.set(path, body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"etag":"e2e"}' });
    }
    const b = bytes.get(path);
    return b ? route.fulfill({ status: 200, contentType: 'application/octet-stream', body: b }) : route.fulfill({ status: 404, json: { error: 'not_found' } });
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
const pvFrame = (page: Page) => page.frameLocator('[data-testid="att-pv-frame"]');

// 失败时把运行日志附进报告（先看日志再定根因）
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const path = info.outputPath('run-log.txt');
  writeFileSync(path, await runLog(page).catch((e: unknown) => String(e)));
  await info.attach('运行日志', { path, contentType: 'text/plain' });
});

test.describe('B4b-1 附件：电脑', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('列表（页数、表数、缩略图）、只能下载的说明、中文 PDF 预览翻页和 Esc、下载、删除撤销', async ({ page, baseURL, browserName }) => {
    const { asked } = await fakeServer(page, baseURL);
    await openNote(page);
    const box = page.getByTestId('note-files');
    await expect(box).toContainText('附件 5');
    await expect(page.getByTestId(`note-file-${F_PDF}`)).toContainText('· 2 页');
    await expect(page.getByTestId(`note-file-${F_XLSX}`)).toContainText('· 2 张表');
    await expect(page.getByTestId(`note-file-${F_PPTX}`)).toContainText('· 3 页');
    await expect(page.getByTestId(`note-file-${F_DOCX}`)).toContainText('正在检查');
    await expect(page.getByTestId(`note-file-${F_XLSM}`)).toContainText('这个文件可能含宏，只能下载后用 Office 打开');
    // 有缩略图的那一项：类型标记换成缩略图，图真的解出来了（宽度不为 0）
    const thumb = page.getByTestId(`note-file-${F_PDF}`).getByTestId('note-file-thumb');
    await expect(thumb).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.getByTestId(`note-file-${F_XLSX}`).getByTestId('note-file-thumb')).toHaveCount(0);
    await expect(page.getByTestId('note-files-add')).toBeEnabled();
    await shot(page, browserName, 'desk-list');

    // 预览：全窗口浮层、沙箱里画出中文 PDF、左侧页缩略图、翻页、Esc 关
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    await page.getByTestId(`note-file-preview-${F_PDF}`).click();
    await expect(page.getByTestId('att-preview')).toBeVisible();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 1 / 2 页', { timeout: 15_000 });
    await expect(pvFrame(page).locator('canvas').first()).toBeVisible();
    await expect(pvFrame(page).locator('.pv-rail canvas, .pv-rail img').first()).toBeVisible({ timeout: 10_000 });
    expect(await page.getByTestId('att-pv-frame').getAttribute('sandbox')).toBe('allow-scripts');
    await shot(page, browserName, 'desk-preview-pdf');
    await page.getByTestId('att-pv-next').click();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 2 / 2 页', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('att-preview')).toHaveCount(0);
    expect(asked).toContain('view');
    // “⋯”菜单的无障碍名带文件名：焦点落在菜单上时运行日志也只能记 testid（WebKit 会把焦点放到菜单上）
    expect(await runLog(page)).not.toContain('出入境申请表');

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

  test('PPT：第一次先问；交给微软 20 秒没出来，退回缩略图和每页文字，带“再试一次 / 下载”', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL);
    // 微软那边一直不回（模拟打不开）：iframe 不触发 load，20 秒后退回本机
    await page.route(/view\.officeapps\.live\.com/, () => undefined);
    await openNote(page);
    await page.getByTestId(`note-file-more-${F_PPTX}`).click();
    await page.getByTestId(`note-file-preview-${F_PPTX}`).click();
    const ask = page.getByTestId('att-ms-ask');
    await expect(ask).toContainText('预览 PPT 时，文件会交给微软');
    await expect(ask).toContainText('这台设备只问一次，可以在 设置 › 数据 里改');
    await expect(page.getByTestId('att-ms-vault')).toHaveCount(0);
    await shot(page, browserName, 'desk-ppt-ask');
    await page.getByTestId('att-ms-yes').click();
    expect(await page.evaluate(() => localStorage.getItem('att.ms_preview'))).toBe('yes');
    await expect(page.getByTestId('att-ms-frame')).toHaveAttribute('src', /^https:\/\/view\.officeapps\.live\.com\/op\/embed\.aspx\?src=/);
    await expect(page.getByTestId('att-pv-fallback')).toContainText('微软这次没打开，先看缩略图和每页文字', { timeout: 30_000 });
    await expect(page.getByTestId('att-pv-again')).toBeVisible();
    await expect(page.getByTestId('att-pv-fallback-download')).toBeVisible();
    await expect(pvFrame(page).getByText('外国人登录证怎么办')).toBeVisible({ timeout: 10_000 });
    await expect(pvFrame(page).locator('img.pv-thumb'), '退路要有首页缩略图').toBeVisible();
    expect(await pvFrame(page).locator('img.pv-thumb').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await shot(page, browserName, 'desk-ppt-fallback');
    await expect.poll(() => runLog(page)).toMatch(/att ms timeout/);
  });

  test('加附件：隐藏沙箱抽页数、文字、缩略图 → 写行 → 上传原字节和缩略图 → file-check；运行日志没有文件名', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openNote(page);
    await page.getByTestId('note-files-input').setInputFiles({ name: '报价说明.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES });
    await expect.poll(() => fake.puts.length, { timeout: 30_000, message: '传了原文件和缩略图' }).toBe(2);
    const [orig, th] = fake.puts;
    expect(orig?.path).toMatch(new RegExp(`^/files/v1/o/files/${USER}/${NOTE}/[0-9a-f-]{36}\\.pdf$`));
    expect(th?.path).toBe(orig?.path.replace(/\.pdf$/, '.t.webp'));
    // WebKit 的 Playwright 拿不到 Blob 包体（postDataBuffer 为空），包体只在 chromium 核
    if (browserName === 'chromium') {
      expect(orig?.body?.equals(PDF_BYTES), '包体就是原字节').toBe(true);
      expect(th?.body?.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(th?.body?.subarray(8, 12).toString('latin1')).toBe('WEBP');
    }
    const row = [...fake.rows.values()].find((r) => r['name'] === '报价说明.pdf');
    expect(row).toMatchObject({ has_thumb: true, pages: 2 });
    expect(String(row?.['text_excerpt'] ?? '')).toMatch(/[一-鿿]/);
    await expect.poll(() => fake.checks.length, { timeout: 15_000 }).toBe(1);
    expect(fake.checks[0]).toMatchObject({ action: 'check' });
    await expect(page.getByTestId('note-files')).toContainText('附件 6');
    await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/att extract ok pages=2 thumb=1/);
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

  test('附件区拖进来的图片插不进去：出提示（D6）', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL);
    await openNote(page);
    // 一张解不开的“图片”：插图编码失败，原来静默丢掉，现在和点“图片”选的一样出提示
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'broken.png', { type: 'image/png' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId('note-edit-img-msg')).toBeVisible({ timeout: 15_000 });
  });

  test('随手记页：瀑布流、列表的“附件 5”；转成待办、移到隐私记的确认框写附件个数', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL);
    await page.goto('/app/#/notes');
    const card = page.getByTestId(`notes-card-${NOTE}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('notes-files-mark')).toHaveText('附件 5');
    await shot(page, browserName, 'notes-masonry');
    await page.getByTestId(`notes-more-${NOTE}`).click();
    await page.getByTestId(`notes-to-todo-${NOTE}`).click();
    await expect(page.getByTestId('notes-conv-ask-ok')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('待办不能带附件');
    await expect(page.getByRole('dialog')).toContainText('5 个附件还在原处');
    await shot(page, browserName, 'notes-convert-ask');
    await page.getByTestId('notes-conv-ask-cancel').click();
    await page.getByTestId(`notes-more-${NOTE}`).click();
    await page.getByTestId(`notes-to-vault-${NOTE}`).click();
    await expect(page.getByRole('dialog')).toContainText('这条随手记和它的 5 个附件会一起加密放进隐私记');
    await shot(page, browserName, 'notes-move-ask');
    await page.getByTestId('notes-move-ask-cancel').click();

    await page.goto('/app/#/settings/notes-view');
    await page.getByText('列表', { exact: true }).click();
    await expect(page.getByTestId('settings-notes-view-list')).toBeChecked();
    await page.goto('/app/#/notes');
    const row = page.getByTestId(`notes-row-${NOTE}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('notes-files-mark')).toHaveText('附件 5');
    await shot(page, browserName, 'notes-list');
  });

  test('设置 › 数据：PPT 预览两行，选了记在本机，改回“先问”就清掉', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL);
    await page.goto('/app/#/settings/data');
    const card = page.getByTestId('settings-ms');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('随手记里的 PPT');
    await expect(card).toContainText('隐私记里的 PPT');
    await expect(card).toContainText('隐私记的文件会先解密再交给微软');
    await page.getByTestId('settings-ms-vault-no').click();
    expect(await page.evaluate(() => localStorage.getItem('att.ms_preview_vault'))).toBe('no');
    await page.getByTestId('settings-ms-note-yes').click();
    expect(await page.evaluate(() => localStorage.getItem('att.ms_preview'))).toBe('yes');
    await shot(page, browserName, 'settings-data-ms');
    await page.getByTestId('settings-ms-note-ask').click();
    expect(await page.evaluate(() => localStorage.getItem('att.ms_preview'))).toBeNull();
  });

  test('深色', async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium' || !SHOT_DIR, '只截图');
    await page.emulateMedia({ colorScheme: 'dark' });
    await fakeServer(page, baseURL);
    await openNote(page);
    await expect(page.getByTestId(`note-file-${F_PDF}`).getByTestId('note-file-thumb')).toBeVisible({ timeout: 15_000 });
    await shot(page, browserName, 'desk-list-dark');
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    await page.getByTestId(`note-file-preview-${F_PDF}`).click();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 1 / 2 页', { timeout: 15_000 });
    await shot(page, browserName, 'desk-preview-pdf-dark');
    await page.keyboard.press('Escape');
    await page.getByTestId(`note-file-more-${F_PPTX}`).click();
    await page.getByTestId(`note-file-preview-${F_PPTX}`).click();
    await expect(page.getByTestId('att-ms-ask')).toBeVisible();
    await shot(page, browserName, 'desk-ppt-ask-dark');
    await page.goto('/app/#/settings/data');
    await expect(page.getByTestId('settings-ms')).toBeVisible({ timeout: 30_000 });
    await shot(page, browserName, 'settings-data-ms-dark');
  });
});

test.describe('B4b-1 附件：手机', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('没有“加附件”；“⋯”是 预览 / 下载 / 用其他 App 打开、没有删除；预览整屏、底部“下载 / 用其他 App 打开”', async ({ page, baseURL, browserName }) => {
    // 系统分享面板在 e2e 里换成桩（真机的分享面板只能真机看）：记下交出去的文件名、类型
    await page.addInitScript(() => {
      const shared: { name: string; type: string }[] = [];
      Object.assign(window, { __shared: shared });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: { files?: File[] }) => Array.isArray(d.files) });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { files: File[] }) => void shared.push(...d.files.map((f) => ({ name: f.name, type: f.type }))) });
    });
    await fakeServer(page, baseURL);
    await openNote(page);
    await expect(page.getByTestId('note-files-add')).toHaveCount(0);
    await expect(page.getByTestId('note-files-phone')).toHaveText('文档请在电脑上加。手机上可以看、预览、下载。');
    await expect(page.getByTestId('note-file-thumb'), '手机上不显示缩略图').toHaveCount(0);
    await expect(page.getByTestId(`note-file-${F_PDF}`)).toContainText('· 2 页');
    await shot(page, browserName, 'phone-list');
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    await expect(page.getByTestId(`note-file-preview-${F_PDF}`)).toBeVisible();
    await expect(page.getByTestId(`note-file-share-${F_PDF}`)).toHaveText('用其他 App 打开');
    await expect(page.getByTestId(`note-file-delete-${F_PDF}`)).toHaveCount(0);
    await shot(page, browserName, 'phone-menu');
    await page.getByTestId(`note-file-share-${F_PDF}`).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).toEqual([{ name: '出入境申请表.pdf', type: 'application/pdf' }]);
    await page.getByTestId(`note-file-more-${F_PDF}`).click();
    await page.getByTestId(`note-file-preview-${F_PDF}`).click();
    await expect(page.getByTestId('att-pv-page')).toHaveText('第 1 / 2 页', { timeout: 15_000 });
    await expect(page.getByTestId('att-pv-download')).toBeVisible();
    await expect(page.getByTestId('att-pv-share')).toHaveText('用其他 App 打开');
    await shot(page, browserName, 'phone-preview-pdf');
    if (browserName === 'chromium' && SHOT_DIR) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, browserName, 'phone-preview-pdf-dark');
      await page.getByTestId('att-pv-close').click();
      await shot(page, browserName, 'phone-list-dark');
    }
  });
});
