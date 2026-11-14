// B5 隐私记客户端（S5～S9、S21）：真页面、真构建，/sb 在浏览器这一层答（假的 vault、vault-image 函数 + 随手记表），会话是假 JWT（session-fixture.ts）
// • 设密码两次 → 解锁 → 新建保存 → 列表有它 → 立即锁上 → 内容没了、出密码键盘 → 输错提示“还能再试 N 次” → 正确解锁
// • 隐私记页挂着时 <html data-rt="1">（底栏、“＋”实色，TC-B5-12），离开回随手记页去掉
// • 离开（blur）同步盖多任务遮罩（TC-B5-44），回来（focus，不到 1 分钟）去掉
// • 随手记“⋯”菜单、列表方式左滑两种方式“移到隐私记”：发 vault {action: import, note_id}，这一条在随手记页藏起来
// • 文档附件（B4b-1，vault-file）：电脑上在隐私记里加（multipart 交给函数加密）、列表写页数、预览中文 PDF、PPT 的卡多一句“会先解密再交给微软”、
//   只下载后提示“下载后的文件不再加密”、上锁后附件区不见
// • Face ID：WebAuthn 不认 IP 当 RP ID（本组服务开在 127.0.0.1），e2e 跑不了；能不能用、取消回 null、两次没认出换密码键盘在 vitest 里测，真机另看
// 跑在快读组（playwright.fastread.config.ts，要带 supabase 地址的构建）；B5_SHOTS 设了目录时，chromium 顺手存浅色、深色两套截图（评审看，不进仓库）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import JSZip from 'jszip';
import { expect, seedFakeSession, test } from './session-fixture.ts';
import { runLog as readRunLog } from './fake-media.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要 /sb 地址，只在快读组跑（npm run e2e:fastread）');
test.setTimeout(90_000);

const PIN = '2580';
const OLD = '0e2e0000-0000-4000-8000-0000000000a1';
const SHOTS = process.env['B5_SHOTS'] ?? '';
const V = '2026-10-29';
const UID = '0e2e0000-0000-4000-8000-000000000001';
/** 列表行的分类（线框 s9 PRIVLIST 第二行灰字）：假 REST 的 categories 表放一条活着的分类，首次同步拉进本机库 */
const CAT = '0e2e0000-0000-4000-8000-0000000000c1';

interface FakeVault {
  calls: { action: string; body: Record<string, unknown> }[];
  notes: Map<string, Record<string, unknown>>;
  /** vault-file 收到的动作和上传的 meta（B4b-1） */
  files: { action: string; meta?: Record<string, unknown>; thumb?: boolean }[];
  /** 设成 true：下一次 save 回 401 vault_locked（令牌过期），回完自动落回 false（审查第 1 条） */
  expireNextSave: boolean;
}

const ZH_PDF = readFileSync(join(import.meta.dirname, 'fixtures', 'b4b1-zh-2p.pdf'));
async function pptx(): Promise<Buffer> {
  const z = new JSZip();
  const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  // 本机判型要 [Content_Types].xml 里有 PPT 的主部件类型（shared/logic/files/file-sniff.ts）
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>');
  z.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
  ['复查安排', '用药记录'].forEach((t, i) => z.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld xmlns:p="x" ${a}><a:t>${t}</a:t></p:sld>`));
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
/** WebKit 的 Playwright 拿不到 multipart 包体：按用例里上传的先后顺序补 meta */
const UPLOAD_ORDER = [
  { kind: 'pdf', name: '体检报告.pdf', pages: 2 },
  { kind: 'pptx', name: '复查安排.pptx', pages: 2 },
];

/** 假会话 + 浏览器这一层的假服务器 */
async function fakeServer(page: Page, baseURL: string | undefined): Promise<FakeVault> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const saved = new Map<string, Map<string, Record<string, unknown>>>([['notes', new Map()], ['settings', new Map()], ['categories', new Map([[CAT, { id: CAT, user_id: UID, name: '健康', color: null, sort: 1, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1, rev: 1, synced_at: '2026-10-29T00:00:00.000Z' }]])]]);
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
    if (u.pathname.endsWith('/profiles')) return route.fulfill({ json: [{ user_id: UID, consent_policy_ver: V }] });
    if (u.pathname.endsWith('/app_config') && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
    return route.fulfill({ json: [] });
  });

  const fv: FakeVault = { calls: [], notes: new Map(), files: [], expireNextSave: false };
  const PPTX = await pptx();
  const stored = new Map<string, Record<string, unknown>>();
  await page.route(/\/sb\/functions\/v1\/vault-file/, (route) => {
    const req = route.request();
    if ((req.headers()['content-type'] ?? '').startsWith('multipart/form-data')) {
      const raw = req.postDataBuffer()?.toString('utf8') ?? '';
      const m = /name="meta"\r\n\r\n([^\r]*)\r\n/.exec(raw);
      const n = fv.files.filter((f) => f.action === 'upload').length;
      const meta = m?.[1] ? (JSON.parse(m[1]) as Record<string, unknown>) : { ...UPLOAD_ORDER[n], id: `0e2e0000-0000-7000-8000-00000000f0${n}0`, note_id: [...fv.notes.keys()][0] };
      fv.files.push({ action: 'upload', meta, thumb: raw.includes('name="thumb"') });
      const item = { id: meta['id'], note_id: meta['note_id'], kind: meta['kind'], name: meta['name'], bytes: 100, pages: meta['pages'] ?? null, has_thumb: false, created_at: Date.now() };
      stored.set(String(meta['id']), item);
      return route.fulfill({ json: { ok: true, file: item } });
    }
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    const action = String(body['action']);
    fv.files.push({ action });
    switch (action) {
      case 'list':
        return route.fulfill({ json: { ok: true, files: [...stored.values()].filter((f) => f['note_id'] === body['note_id']) } });
      case 'get': {
        const f = stored.get(String(body['id']));
        if (!f) return route.fulfill({ status: 404, json: { error: 'not_found' } });
        return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: f['kind'] === 'pptx' ? PPTX : ZH_PDF });
      }
      default:
        return route.fulfill({ json: { ok: true } });
    }
  });
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
        return route.fulfill({ json: { ok: true, set: pin !== null, locked_until: null, retry_after_s: null, last_reset_at: null, webauthn: 0 } });
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
        if (fv.expireNextSave) {
          fv.expireNextSave = false;
          return fail(route, 401, { error: 'vault_locked' });
        }
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

/** 在密码键盘上按 4 位数字（满 4 位自动交出，负责人 11-14“隐私记密只做4位数”，没有“确定”键） */
async function typePin(page: Page, pad: string, digits: string): Promise<void> {
  for (const d of digits) await page.getByTestId(`${pad}-key-${d === '0' ? 9 : Number(d) - 1}`).click(); // 位置序号：1～9 是 key-0～key-8，0 是 key-9
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
  // 线框 s9 FIRSTPW：整页（nav:false，底栏被盖住），顶栏“‹ 随手记 … 取消”
  await expect(page.getByTestId('vault-setup-back')).toBeVisible();
  await expect(page.getByTestId('vault-setup-cancel')).toBeVisible();
  expect(await page.evaluate(() => !!document.elementFromPoint(innerWidth / 2, innerHeight - 30)?.closest('[data-testid="vault-setup-page"]'))).toBe(true);
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
  // 再放一条昨天的、带分类的（线框 s9 PRIVLIST 的行：日期“昨天” | 图标 | 标题和灰字分类 | “⋯”）
  const day = 86_400_000;
  fv.notes.set(OLD, { id: OLD, title: '妈妈生日惊喜', body: '订那家蛋糕', category_id: CAT, created_at: Date.now() - day, updated_at: Date.now() - day, deleted_at: null, images: [] });
  await page.getByTestId('vault-edit-save').click();
  await expect.poll(() => fv.calls.filter((c) => c.action === 'save').length).toBe(1);
  await page.getByTestId('vault-edit-back').click();
  await expect(page.getByTestId('vault-list')).toContainText('体检报告');
  const old = page.getByTestId(`vault-row-${OLD}`);
  await expect(old).toContainText('昨天');
  await expect(old).toContainText('健康');
  await expect(page.getByTestId('vault-list')).not.toContainText('血压 120/80');   // 行里不出正文摘要
  await shot(page, '06-解锁后的列表', browserName);

  await page.getByTestId('vault-lock-now').click();
  // 线框 s9 UNLOCKOV：用不了 Face ID 时卡片只有“输入密码”“取消”，点了再进密码页
  await expect(page.getByTestId('vault-unlock-card')).toBeVisible();
  await expect(page.getByTestId('vault-unlock-face')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('血压 120/80');
  await expect(page.locator('body')).not.toContainText('体检报告');
  await shot(page, '03-解锁卡', browserName);
  await page.getByTestId('vault-unlock-pin').click();
  await expect(page.getByTestId('vault-unlock-pinview')).toBeVisible();

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
  // 11-14 d41a1987 的 CI webkit 左滑没打开（重试一次也没开），本机复现不了：失败时把左滑运行日志带进报错（按下、定方向、松手各一行）。
  // 运行日志 300 ms 防抖才落到 localStorage，读之前要等
  const swipeLog = async (): Promise<string> => (await readRunLog(page)).filter((l) => l.includes('swipe ')).slice(-12).join(' | ');
  try {
    await expect(page.getByTestId(`notes-swipe-${id}`)).toHaveAttribute('data-open', 'true');
  } catch (e) {
    await page.waitForTimeout(500);
    throw new Error(`${e instanceof Error ? e.message : String(e)} | 左滑运行日志：${await swipeLog()}`);
  }
  await expect.poll(swipeLog, { message: '左滑运行日志要记下松手结果' }).toMatch(/swipe up started=1 axis=h last=-\d+ w=192 open=1/);
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
  await page.getByTestId('vault-unlock-pin').click();
  for (let i = 0; i < 5; i++) await typePin(page, 'vault-unlock-pad', '0000');
  await expect(page.getByTestId('vault-unlock-pad-key-0')).toBeDisabled();
  // 服务器说 60 秒：倒计时不能比 60 秒多（原来按卡片挂上时的时间算，显示过“1 分 2 秒”）
  await expect(page.getByText(/输错次数太多，(1 分 0 秒|\d+ 秒) 后再试/)).toBeVisible();
  await shot(page, '05-锁定倒计时', browserName);
});

test('隐私记里的文档附件（B4b-1）：电脑上加（加密）、写页数、预览中文 PDF、PPT 的卡多一句“会先解密”、只下载提示不再加密、上锁后不见', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/vault/new');
  await page.getByTestId('vault-edit-title').fill('体检');
  await expect(page.getByTestId('note-files'), '没保存过的新隐私记不出附件区').toHaveCount(0);
  await page.getByTestId('vault-edit-save').click();
  await expect.poll(() => fv.calls.filter((c) => c.action === 'save').length).toBe(1);
  await expect(page.getByTestId('note-files-add')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('note-files-input').setInputFiles({ name: '体检报告.pdf', mimeType: 'application/pdf', buffer: ZH_PDF });
  await expect(page.getByTestId('note-files-undo')).toContainText('已加到隐私记（加密存放）', { timeout: 30_000 });
  const pdfRow = page.locator('[data-testid^="note-file-0"]').filter({ hasText: '体检报告.pdf' });
  await expect(pdfRow).toContainText('· 2 页');
  const up = fv.files.find((f) => f.action === 'upload');
  expect(up?.meta).toMatchObject({ kind: 'pdf', name: '体检报告.pdf', pages: 2 });
  // 包体只在 chromium 能看到：带了缩略图、抽出的文字
  if (browserName === 'chromium') {
    expect(up?.thumb).toBe(true);
    expect(String(up?.meta?.['text'] ?? '')).toMatch(/[\u4e00-\u9fff]/);
  }
  await shot(page, '08-隐私记附件', browserName);

  // 预览中文 PDF：字节从 vault-file get 来（服务器解密）
  const pid = ((await pdfRow.getAttribute('data-testid')) ?? '').replace('note-file-', '');
  await page.getByTestId(`note-file-more-${pid}`).click();
  await page.getByTestId(`note-file-preview-${pid}`).click();
  await expect(page.getByTestId('att-pv-page')).toHaveText('第 1 / 2 页', { timeout: 15_000 });
  await expect(page.frameLocator('[data-testid="att-pv-frame"]').locator('canvas').first()).toBeVisible();
  expect(fv.files.some((f) => f.action === 'get')).toBe(true);
  await page.keyboard.press('Escape');

  // PPT：二选一卡多一句“隐私记的文件会先解密再交给微软”；选“只下载”记在隐私记那一份，下载后提示不再加密
  await page.getByTestId('note-files-input').setInputFiles({ name: '复查安排.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await pptx() });
  const pptRow = page.locator('[data-testid^="note-file-0"]').filter({ hasText: '复查安排.pptx' });
  await expect(pptRow).toBeVisible({ timeout: 30_000 });
  const tid = ((await pptRow.getAttribute('data-testid')) ?? '').replace('note-file-', '');
  await page.getByTestId(`note-file-more-${tid}`).click();
  await page.getByTestId(`note-file-preview-${tid}`).click();
  await expect(page.getByTestId('att-ms-vault')).toHaveText('隐私记的文件会先解密再交给微软。');
  await expect(page.getByTestId('att-ms-ask')).toContainText('下载后的文件不再加密');
  await shot(page, '09-隐私记PPT二选一', browserName);
  const dl = page.waitForEvent('download');
  await page.getByTestId('att-ms-no').click();
  expect((await dl).suggestedFilename()).toBe('复查安排.pptx');
  await expect(page.getByTestId('note-files-msg')).toContainText('下载后的文件不再加密');
  expect(await page.evaluate(() => [localStorage.getItem('att.ms_preview_vault'), localStorage.getItem('att.ms_preview')])).toEqual(['no', null]);
  expect(fv.files.some((f) => f.action === 'ms_preview')).toBe(false);

  // 上锁：附件区跟着编辑页一起没了，DOM 里不留文件名
  await page.getByTestId('vault-edit-back').click();
  await page.getByTestId('vault-lock-now').click();
  await expect(page.getByTestId('vault-unlock-card')).toBeVisible();
  await expect(page.getByTestId('note-files')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('体检报告.pdf');
  const log = await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  expect(log).toMatch(/vatt upload ok/);
  expect(log).not.toContain('体检报告');
});

test('审查第 1 条：保存时令牌过期 → 解锁卡点取消 → 再解锁时那次保存不补发', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/vault/new');
  await page.getByTestId('vault-edit-title').fill('取消以后不该存的');
  fv.expireNextSave = true;
  await page.getByTestId('vault-edit-save').click();
  await expect(page.getByTestId('vault-unlock-card')).toBeVisible();
  expect(fv.calls.filter((c) => c.action === 'save')).toHaveLength(1);
  await page.getByTestId('vault-unlock-cancel').click();
  // 桌面宽度下随手记页先挂分栏（desk，按需加载），几个 worker 并发时会超过默认 5 秒
  await expect(page.getByTestId('notes')).toBeVisible({ timeout: 15_000 });
  await page.goto('/app/#/vault');
  await page.getByTestId('vault-unlock-pin').click();
  await typePin(page, 'vault-unlock-pad', PIN);
  await expect(page.getByTestId('vault-empty')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  expect(fv.calls.filter((c) => c.action === 'save')).toHaveLength(1);
  expect(fv.notes.size).toBe(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).toMatch(/vault wait cancel n=\d/);
});

test('审查第 3 条：设密码时开了 Face ID、绑定没成：密码照样设好，隐私记页出提示（role=alert）；审查第 6 条：解锁卡是有名字的对话框、键盘焦点圈', async ({ page, baseURL, browserName }) => {
  test.skip(browserName !== 'chromium', '虚拟验证器只有 chromium 的 CDP 有');
  // 虚拟平台验证器：让“能用 Face ID”成立；RP ID 是 IP（127.0.0.1）不被认，绑定一定失败——正好是要测的那条路
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await fakeServer(page, baseURL);
  await page.goto('/app/#/vault');
  await expect(page.getByTestId('vault-setup')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('vault-setup-face').check({ force: true });
  await typePin(page, 'vault-setup-pad', PIN);
  await expect(page.getByTestId('vault-setup')).toHaveAttribute('data-step', '2');
  await typePin(page, 'vault-setup-pad', PIN);
  await expect(page.getByTestId('vault-empty')).toBeVisible({ timeout: 15_000 });
  const toast = page.getByTestId('vault-bind-fail');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('role', 'alert');
  await shot(page, '11-绑定失败提示', browserName);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).toMatch(/vault bind fail /);

  await page.getByTestId('vault-lock-now').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAccessibleName(/.+/);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="vault-unlock-card"]'))).toBe(true);
  await page.keyboard.press('Tab');
  await shot(page, '12-解锁卡键盘焦点', browserName);
});
