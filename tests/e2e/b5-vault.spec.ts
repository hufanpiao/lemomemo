// B5 隐私记客户端（S5～S9、S21）：真页面、真构建，/sb 在浏览器这一层答（假的 vault、vault-image 函数 + 随手记表），会话是假 JWT（session-fixture.ts）
// • 设密码两次 → 解锁 → 新建（停笔自动存）→ 列表有它 → 立即锁上 → 内容没了、出密码键盘 → 输错提示“还能再试 N 次” → 正确解锁
// • B5 隐私记重写（11-15）：解锁后是随手记那一份界面（列表、编辑器、插图、看图页）+ 隐私记来源；读写只碰内存仓库、后台队列去发。
//   负责人报的三个问题各有一条：插图后点开出看图页；断网改了界面即时、网络回来补发；离开隐私记页 59 秒不锁、61 秒锁
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
import { fakeRest } from './fake-rest.ts';
import { notesViewRows } from './idb.ts';
import { jpeg, stableBox, swipeDiag, touchSwipe } from './page-helpers.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';
import { runLog as readRunLog } from './fake-media.ts';

test.setTimeout(90_000);

const PIN = '2580';
const OLD = '0e2e0000-0000-4000-8000-0000000000a1';
const SHOTS = process.env['B5_SHOTS'] ?? '';
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
  /** 设成 true：vault、vault-image 请求一律断开（断网） */
  offline: boolean;
  /** vault-image 收到的上传（隐私记 id/图片 id/part） */
  images: string[];
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
  const category = { id: CAT, user_id: UID, name: '健康', color: null, sort: 1, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, created_at: 1, updated_at: 1, rev: 1, synced_at: '2026-10-29T00:00:00.000Z' };
  // 随手记显示方式两类设备明确写 masonry（负责人 11-18 首装默认改列表）：“移到隐私记”那条找的是瀑布流卡片，要列表的用例（listRow）再去设置里改
  const view = notesViewRows('masonry', { user_id: UID, created_at: 1, updated_at: 1, synced_at: '2026-10-29T00:00:00.000Z' });
  await fakeRest(page, { user: UID, tables: { notes: [], settings: view, categories: [category] }, store: {} });

  const fv: FakeVault = { calls: [], notes: new Map(), files: [], expireNextSave: false, offline: false, images: [] };
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
  // vault-image：上传（参数在查询串、包体是 webp 字节）存下来；取图（JSON）回存下的字节
  const pics = new Map<string, Buffer>();
  await page.route(/\/sb\/functions\/v1\/vault-image/, (route) => {
    if (fv.offline) return route.abort('internetdisconnected');
    const req = route.request();
    const url = new URL(req.url());
    if (url.searchParams.get('action') === 'upload') {
      const key = `${url.searchParams.get('image_id')}:${url.searchParams.get('part')}`;
      fv.images.push(`${url.searchParams.get('note_id')}/${key}`);
      pics.set(key, req.postDataBuffer() ?? Buffer.alloc(0));
      return route.fulfill({ json: { ok: true } });
    }
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    const got = pics.get(`${String(body['image_id'])}:${String(body['part'])}`);
    return got ? route.fulfill({ status: 200, contentType: 'image/webp', body: got }) : route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.route(/\/sb\/functions\/v1\/vault(\?|$)/, (route) => {
    if (fv.offline) return route.abort('internetdisconnected');
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
        const had = (fv.notes.get(id)?.['images'] ?? []) as Record<string, unknown>[];
        const adds = ((body['add_images'] ?? []) as Record<string, unknown>[]).map((i) => ({ ...i, deleted_at: null }));
        fv.notes.set(id, { id, title: body['title'], body: body['body'], category_id: body['category_id'] ?? null, created_at: body['created_at'], updated_at: body['updated_at'], deleted_at: null, images: [...had, ...adds] });
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

/** 线框对照图：手机尺寸、浅色深色各一张（page-helpers 的 shot 只拍当前尺寸一张，这里另起名，不同名） */
async function phoneShots(page: Page, name: string, browserName: string): Promise<void> {
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
  // 轮询：整屏页滑入时 CI 上 webkit 慢，取点太早会点到下面那层（11-17 ci 偶发 false，重试通过）
  await expect.poll(() => page.evaluate(() => !!document.elementFromPoint(innerWidth / 2, innerHeight - 30)?.closest('[data-testid="vault-setup-page"]'))).toBe(true);
  await phoneShots(page, '02-设密码', browserName);
  await typePin(page, 'vault-setup-pad', PIN);
  await expect(page.getByTestId('vault-setup')).toHaveAttribute('data-step', '2');
  await typePin(page, 'vault-setup-pad', PIN);
  await expect(vaultEmpty(page)).toBeVisible({ timeout: 15_000 });
}

/** 解锁后隐私记空着：手机排法是首页（负责人 11-19“解锁后用乙”）一条都没有时的那一句；电脑排法不画首页，照旧是列表的空态 */
const vaultEmpty = (page: Page) => page.getByTestId('vault-notes').getByTestId(/^(vault-home-empty|notes-empty)$/);

/** 编辑页（随手记那一份）写一段、离开输入框：停笔自动存 */
async function write(page: Page, testId: 'note-edit-title' | 'note-edit-body', text: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(text);
  await el.blur();
}

const saved = (fv: FakeVault) => fv.calls.filter((c) => c.action === 'save');

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach('运行日志', { body: await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '').catch((e: unknown) => String(e)), contentType: 'text/plain' });
});

test('设密码 → 新建 → 上锁不留内容 → 输错提示剩余次数 → 解锁；页面挂着时底栏实色', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await expect(page.locator('html')).toHaveAttribute('data-rt', '1');

  await page.goto('/app/#/vault/new');
  await write(page, 'note-edit-title', '体检报告');
  await write(page, 'note-edit-body', '血压 120/80');
  await expect(page.getByTestId('vault-edit-save'), '停笔自动存，没有“保存”按钮').toHaveCount(0);
  await phoneShots(page, '07-编辑页', browserName);
  await expect.poll(() => saved(fv).at(-1)?.body).toMatchObject({ title: '体检报告', body: '血压 120/80' });
  await page.getByTestId('edit-back').click();
  const list = page.getByTestId('vault-notes');
  await expect(list).toContainText('体检报告');
  await phoneShots(page, '06-解锁后的列表', browserName);
  // 电脑版、手机版都只有一个 h1“隐私记”（独立评审 11-19 高 5：电脑版原来读屏 h1 和顶栏 h1 各一个）
  await expect(page.getByRole('heading', { level: 1, name: '隐私记' })).toHaveCount(1);

  await page.getByTestId('vault-lock-now').click();
  // 线框 s9 UNLOCKOV：用不了 Face ID 时卡片只有“输入密码”“取消”，点了再进密码页
  await expect(page.getByTestId('vault-unlock-card')).toBeVisible();
  await expect(page.getByTestId('vault-unlock-face')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('血压 120/80');
  await expect(page.locator('body')).not.toContainText('体检报告');
  await phoneShots(page, '03-解锁卡', browserName);
  // 锁着时底栏没被盖住、没被设成 inert，点得到（11-19 独立评审高 3：原来是透明的全屏模态遮罩，看得见点不动）
  const bar = page.getByTestId('tabbar');
  if (await bar.isVisible()) {
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return !!el?.closest('[data-testid="tabbar"]') && !el.closest('[inert]');
    }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    expect(hit).toBe(true);
  }
  await page.getByTestId('vault-unlock-pin').click();
  await expect(page.getByTestId('vault-unlock-pinview')).toBeVisible();

  await typePin(page, 'vault-unlock-pad', '1111');
  await expect(page.getByTestId('vault-unlock-err')).toContainText('4');
  await phoneShots(page, '04-输错', browserName);
  // 锁着的时候服务器上多了一条昨天的、带分类的：解锁后 list 一次拉进来
  const day = 86_400_000;
  fv.notes.set(OLD, { id: OLD, title: '妈妈生日惊喜', body: '订那家蛋糕', category_id: CAT, created_at: Date.now() - day, updated_at: Date.now() - day, deleted_at: null, images: [] });
  await typePin(page, 'vault-unlock-pad', PIN);
  await expect(list).toContainText('体检报告', { timeout: 15_000 });
  await expect(list).toContainText('妈妈生日惊喜');
  await phoneShots(page, '08-解锁后首页', browserName);
  // 11-14 整块评审第 1、14 条：密码键盘的点按在运行日志里只记 masked（没有 testid、坐标）；隐私记状态迁移记了，标题、正文没进日志
  const runLog = (): Promise<string> => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  await expect.poll(runLog).toMatch(/app vault state unlocked/);
  const log = await runLog();
  expect(log).toMatch(/(down|click) masked/);
  expect(log).not.toMatch(/pad-key|pad-k\d|masked[^\n]*x=\d/);
  for (const secret of ['体检报告', '血压']) expect(log).not.toContain(secret);   // 密码本身不比：日志里的耗时数字可能碰巧含这几位，键位由上一行管

  await page.getByTestId('vault-back').click();
  // 第一次进随手记：外壳 NotesRoot → NotesPage 和二十几个依赖分两层串着下，这时 SW 还在第一次装、整包预缓存一起在拉。
  // 11-14 快读组两次红（chromium、webkit 各一次），重复 24 遍复现 3 次：trace 里每个分包 0.6～0.8 秒，点返回 5 秒后还有 11 个没到，
  // 运行日志 sw register ok 8767ms 正好在这批请求发出时。同第 228 行等解锁列表，给到 15 秒
  await expect(page.getByTestId('notes')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).not.toHaveAttribute('data-rt', '1');
  await phoneShots(page, '01-入口行', browserName);
});

test('隐私记页底部输入行记一句：发给隐私记（vault save），不进随手记本机库', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  const vault = page.getByTestId('vault-notes');
  await vault.getByTestId('notes-input').fill('只该在隐私记里的一句');
  await vault.getByTestId('notes-add').click();
  await expect(vault).toContainText('只该在隐私记里的一句');
  await expect.poll(() => saved(fv).at(-1)?.body).toMatchObject({ body: '只该在隐私记里的一句' });
  await page.goto('/app/#/notes');
  await expect(page.getByTestId('notes-input')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('只该在隐私记里的一句');
});

// R-461：隐私记页是同一个 NotesPage，拖动排序照样能用（拿起留占位、放下换序、发 save、日志不带标题）
test('隐私记页长按拖动：最下面一条拖到最上面，顺序照放下的、发 save', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  const vault = page.getByTestId('vault-notes');
  for (const t of ['隐私一', '隐私二', '隐私三']) {
    await vault.getByTestId('notes-input').fill(t);
    await vault.getByTestId('notes-add').click();
    await expect(vault).toContainText(t);
  }
  // 手机排法解锁后是首页（负责人 11-19“解锁后用乙”），拖动排序在“全部”列表里
  if (await page.getByTestId('vault-home-all').isVisible()) {
    await page.getByTestId('vault-home-all').click();
    // 进列表是一次换页过渡：放完（<html> 摘掉 data-vt）再按，过渡里按下去点中的是 html（运行日志 down html），拿不起来
    await expect(page.locator('html')).not.toHaveAttribute('data-vt', /.*/);
  }
  const rows = vault.locator('[data-sort-id]:not([data-state="leaving"])');
  await expect(rows).toHaveCount(3);
  const order = () => rows.evaluateAll((els) => els.map((e) => e.textContent?.match(/隐私[一二三]/)?.[0] ?? ''));
  await expect.poll(order).toEqual(['隐私三', '隐私二', '隐私一']);
  const box = async (i: number) => {
    const b = await stableBox(rows.nth(i));
    return { x: b.x + b.width * 0.45, y: b.y + b.height / 2, top: b.y, h: b.height };
  };
  const from = await box(2);
  const to = await box(0);
  const savesBefore = saved(fv).length;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await expect(vault.locator('[data-sort-held]')).toHaveCount(1);
  // 电脑宽度、手机上隐私记默认都可能是瀑布流（卡片分在几列）：拖到第一张自己的位置
  await page.mouse.move(to.x, to.top + to.h * 0.25, { steps: 14 });
  await page.waitForTimeout(450);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const sortLines = (await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).split('\n').filter((x) => / sort | down | vault /.test(x)).slice(-20).join('\n');
  await expect.poll(order, sortLines).toEqual(['隐私一', '隐私三', '隐私二']);
  await expect(page.getByTestId('sort-float')).toHaveCount(0);
  await expect.poll(() => saved(fv).length).toBeGreaterThan(savesBefore);
  const log = await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  expect(log).toMatch(/ sort \w+ drop i=2 to=0 n=3/);
  for (const secret of ['隐私一', '隐私二', '隐私三']) expect(log).not.toContain(secret);
});

test('离开时同步盖多任务遮罩，不到 1 分钟回来自动去掉、仍解锁', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('html')).toHaveAttribute('data-vault-shield', '1');
  await expect(page.getByTestId('vault-shield')).toBeVisible();
  await phoneShots(page, '08-多任务遮罩', browserName);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('html')).not.toHaveAttribute('data-vault-shield', '1');
  await expect(vaultEmpty(page)).toBeVisible();
});

test('随手记“⋯”菜单移到隐私记：发 import，这一条从随手记页藏起来', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/notes');
  // 只在随手记页里找：切页过渡那 300 毫秒隐私记页还没卸下，它也是随手记那一份界面、也有 notes-input（11-15 隐私记重写后）
  const notes = page.getByTestId('notes');
  await notes.getByTestId('notes-input').fill('要移走的一条');
  await notes.getByTestId('notes-add').click();
  const card = page.locator('[data-testid^="notes-card-"]').filter({ hasText: '要移走的一条' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const id = (await card.getAttribute('data-testid'))?.replace('notes-card-', '') ?? '';
  await expect(page.getByTestId('vault-lockrow')).toBeVisible();
  await page.getByTestId(`notes-more-${id}`).click();
  await page.getByTestId(`notes-to-vault-${id}`).click();
  await expect.poll(() => fv.calls.find((c) => c.action === 'import')?.body['note_id']).toBe(id);
  await expect(card).toHaveCount(0);
});

/** 隐私记已设好、随手记换成列表方式、记下一条：返回这一行的 id，和停稳后左滑的起点（行右边往里 40px） */
async function listRow(page: Page, browserName: string, title: string): Promise<{ id: string; from: { x: number; y: number } }> {
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/settings/notes-view');
  // 单选框藏在文字下面（文字那层接点按）：点文字
  await page.getByText('列表', { exact: true }).click();
  await expect(page.getByTestId('settings-notes-view-list')).toBeChecked();
  await page.goto('/app/#/notes');
  await page.getByTestId('notes-input').fill(title);
  await page.getByTestId('notes-add').click();
  const row = page.locator('[data-testid^="notes-row-"]').filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const id = (await row.getAttribute('data-testid'))?.replace('notes-row-', '') ?? '';
  // 输入行还聚焦着时整页盖着模糊层（R-401）：先让它失焦
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // 进场期间不接点按是有意的（src/motion/list-impl.tsx 的 ENTERING_STYLE，第二轮 L3 定的）。今天第一条记下时进场的是新的分组 section
  // （notes-g-<日期>），不是这一行：等列表里没有任何一层还在进场，再等这一行停稳（入口行晚到会把它挤一下）
  await expect(page.locator('[data-testid="notes-list"] [data-state="entering"]')).toHaveCount(0, { timeout: 10_000 });
  const box = await stableBox(page.getByTestId(`notes-swipe-${id}`));
  return { id, from: { x: box.x + box.width - 40, y: box.y + box.height / 2 } };
}

/** 左滑打开了（data-swipe=open），松手那一行运行日志记的是打开；没打开时把诊断带进报错（只在失败时读） */
async function expectSwipeOpen(page: Page, id: string, from: { x: number; y: number }, type: 'mouse' | 'touch'): Promise<void> {
  try {
    await expect(page.getByTestId(`notes-swipe-${id}`)).toHaveAttribute('data-swipe', 'open');
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} | ${await swipeDiag(page, from, `notes-swipe-${id}`, 'notes-list')}`);
  }
  // 运行日志 300 ms 防抖才落到 localStorage：轮询等它
  const swipeLog = async (): Promise<string> => (await readRunLog(page)).filter((l) => l.includes('swipe ')).slice(-12).join(' | ');
  await expect.poll(swipeLog, { message: '左滑运行日志要记下按下和松手' }).toMatch(new RegExp(`swipe down type=${type} open=0.*swipe up started=1 axis=h last=-\\d+ w=192 open=1`));
  await expect(page.getByTestId(`notes-sw-vault-${id}`)).toBeVisible();
}

test('列表方式左滑：出“转成待办 / 移到隐私记 / 删除”，点“移到隐私记”发 import', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  const { id, from } = await listRow(page, browserName, '左滑的一条');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x - i * 22, from.y);
  await page.mouse.up();
  await expectSwipeOpen(page, id, from, 'mouse');
  await phoneShots(page, '10-左滑按钮', browserName);
  await page.getByTestId(`notes-sw-vault-${id}`).click();
  await expect.poll(() => fv.calls.find((c) => c.action === 'import')?.body['note_id']).toBe(id);
  await expect(page.getByTestId(`notes-row-${id}`)).toHaveCount(0);
});

test('列表方式左滑（触摸）：pointerType=touch 的按下、移动、松手同样打开', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL);
  const { id, from } = await listRow(page, browserName, '手指左滑的一条');
  await touchSwipe(page, from, 220);
  await expectSwipeOpen(page, id, from, 'touch');
});

test('设置 › 隐私记：已设密码时有自动上锁、改密码、忘记密码', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/settings/vault');
  await expect(page.getByTestId('vault-settings')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('vault-set-change')).toBeVisible();
  await expect(page.getByTestId('vault-set-forgot')).toBeVisible();
  await expect(page.getByTestId('vault-set-autolock')).toBeVisible();
  await phoneShots(page, '09-设置隐私记', browserName);
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
  await phoneShots(page, '05-锁定倒计时', browserName);
});

test('隐私记里的文档附件（B4b-1）：电脑上加（加密）、写页数、预览中文 PDF、PPT 的卡多一句“会先解密”、只下载提示不再加密、上锁后不见', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/vault/new');
  await expect(page.getByTestId('note-edit-title')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('note-files'), '没保存过的新隐私记不出附件区').toHaveCount(0);
  await write(page, 'note-edit-title', '体检');
  await expect.poll(() => saved(fv).length).toBe(1);
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
  await phoneShots(page, '08-隐私记附件', browserName);

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
  await phoneShots(page, '09-隐私记PPT二选一', browserName);
  const dl = page.waitForEvent('download');
  await page.getByTestId('att-ms-no').click();
  expect((await dl).suggestedFilename()).toBe('复查安排.pptx');
  await expect(page.getByTestId('note-files-msg')).toContainText('下载后的文件不再加密');
  expect(await page.evaluate(() => [localStorage.getItem('att.ms_preview_vault'), localStorage.getItem('att.ms_preview')])).toEqual(['no', null]);
  expect(fv.files.some((f) => f.action === 'ms_preview')).toBe(false);

  // 上锁：附件区跟着编辑页一起没了，DOM 里不留文件名
  await page.getByTestId('edit-back').click();
  await page.getByTestId('vault-lock-now').click();
  await expect(page.getByTestId('vault-unlock-card')).toBeVisible();
  await expect(page.getByTestId('note-files')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('体检报告.pdf');
  const log = await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  expect(log).toMatch(/vatt upload ok/);
  expect(log).not.toContain('体检报告');
});

test('审查第 1 条：保存时令牌过期 → 解锁卡点取消 → 再解锁时那次保存不补发，列表出“有 1 处改动没来得及保存”', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/vault/new');
  fv.expireNextSave = true;
  await write(page, 'note-edit-title', '取消以后不该存的');
  await expect(page.getByTestId('vault-unlock-card')).toBeVisible();
  expect(saved(fv)).toHaveLength(1);
  await page.getByTestId('vault-unlock-cancel').click();
  // 桌面宽度下随手记页先挂分栏（desk，按需加载），几个 worker 并发时会超过默认 5 秒
  await expect(page.getByTestId('notes')).toBeVisible({ timeout: 15_000 });
  await page.goto('/app/#/vault');
  await page.getByTestId('vault-unlock-pin').click();
  await typePin(page, 'vault-unlock-pad', PIN);
  await expect(vaultEmpty(page)).toBeVisible({ timeout: 15_000 });
  // 先等运行日志记下“取消了解锁”、队列丢了 1 条（取消等同主动上锁，不会再补发，M1），再数保存次数
  const runLog = (): Promise<string> => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  await expect.poll(runLog).toMatch(/vault wait cancel/);
  await expect.poll(runLog).toMatch(/vault queue drop n=1 why=cancel/);
  expect(saved(fv)).toHaveLength(1);
  expect(fv.notes.size).toBe(0);
  await expect(page.getByTestId('notes-sync-dropped')).toContainText('1');
  expect(await runLog()).not.toContain('取消以后不该存的');
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
  await expect(vaultEmpty(page)).toBeVisible({ timeout: 15_000 });
  const toast = page.getByTestId('vault-bind-fail');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('role', 'alert');
  await phoneShots(page, '11-绑定失败提示', browserName);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).toMatch(/vault bind fail /);

  await page.getByTestId('vault-lock-now').click();
  // 隐私记页锁着是一整页（不是遮罩，11-19 独立评审高 1～3）：有“隐私记已上锁”标题，底栏不被盖住
  await expect(page.getByTestId('vault-locked')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '隐私记已上锁' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="vault-unlock-card"]'))).toBe(true);
  await page.keyboard.press('Tab');
  await phoneShots(page, '12-解锁卡键盘焦点', browserName);
});

/** 解锁后新建一条（停笔自动存）、等服务器收到；回这一条的 id */
async function oneNote(page: Page, fv: FakeVault, browserName: string, body: string): Promise<string> {
  await setupAndUnlock(page, browserName);
  await page.goto('/app/#/vault/new');
  await expect(page.getByTestId('note-edit-body')).toBeVisible({ timeout: 15_000 });
  await write(page, 'note-edit-body', body);
  await expect.poll(() => saved(fv).length).toBe(1);
  return String(saved(fv)[0]?.body['id']);
}

test('负责人“插图打不开”：隐私记里插一张图，立刻显示本机那一份；传好了点它出看图页', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  const id = await oneNote(page, fv, browserName, '带图的一条');
  await page.getByTestId('note-edit-img-input').setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page) });
  const item = page.locator('[data-testid^="note-image-"][data-state]');
  await expect(item).toHaveCount(1, { timeout: 15_000 });
  await expect(item.locator('img')).toBeVisible();
  await expect(item).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  const imgId = ((await item.getAttribute('data-testid')) ?? '').replace('note-image-', '');
  // 先 save 预登记，再传原图、缩略图（同一条、同一张图）
  expect(saved(fv).at(-1)?.body['add_images']).toEqual([expect.objectContaining({ id: imgId, has_thumb: true })]);
  expect(fv.images).toEqual([`${id}/${imgId}:full`, `${id}/${imgId}:thumb`]);
  await page.getByTestId(`note-image-open-${imgId}`).click();
  await expect(page.getByTestId(`img-view-pic-${imgId}`)).toBeVisible({ timeout: 15_000 });
  await phoneShots(page, '13-隐私记看图', browserName);
  const log = await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  expect(log).toMatch(/vault img encode ok/);
  expect(log).not.toContain(imgId);
  expect(log).not.toContain('带图的一条');
});

test('负责人“读写慢”：断网时改了界面立刻就是新的，网络回来后台补发', async ({ page, baseURL, browserName }) => {
  const fv = await fakeServer(page, baseURL);
  await oneNote(page, fv, browserName, '断网前写的');
  fv.offline = true;
  await write(page, 'note-edit-body', '断网时改的');
  await page.getByTestId('edit-back').click();
  // 不等服务器：列表马上是改过的那一份
  await expect(page.getByTestId('vault-notes')).toContainText('断网时改的', { timeout: 3_000 });
  expect(saved(fv)).toHaveLength(1);
  fv.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => saved(fv).at(-1)?.body['body'], { timeout: 30_000 }).toBe('断网时改的');
  await expect(page.locator('[data-testid^="notes-sync-failed-"]')).toHaveCount(0);
  const log = await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  expect(log).toMatch(/vault queue fail offline/);
  expect(log).not.toContain('断网时改的');
});

/** 整页 HTML（含属性、aria、隐藏节点）里有没有这几段明文：上锁后下一帧就读，不等重试（L8） */
async function plainLeft(page: Page, texts: readonly string[]): Promise<string[]> {
  const html = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return document.documentElement.outerHTML;
  });
  return texts.filter((t) => html.includes(t));
}

test('L8：上锁后下一帧 DOM 里就没有标题、正文（列表上点“上锁”、编辑器开着时自动上锁两种）', async ({ page, baseURL, browserName }) => {
  await page.clock.install();
  const fv = await fakeServer(page, baseURL);
  await oneNote(page, fv, browserName, '血压 120/80 明文正文');
  await write(page, 'note-edit-title', '体检报告明文标题');
  await expect.poll(() => saved(fv).at(-1)?.body['title']).toBe('体检报告明文标题');
  const secrets = ['体检报告明文标题', '血压 120/80 明文正文'];

  // ① 编辑器开着：离开（blur）满 61 秒，回来（focus）那一刻上锁
  expect(await plainLeft(page, secrets), '上锁前编辑器里有明文（对照）').toEqual(secrets);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.fastForward(61_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await plainLeft(page, secrets), '编辑器开着时自动上锁，下一帧不留明文').toEqual([]);

  // ② 列表上点“上锁”
  await page.goto('/app/#/vault');
  await page.getByTestId('vault-unlock-pin').click();
  await typePin(page, 'vault-unlock-pad', PIN);
  const list = page.getByTestId('vault-notes');
  await expect(list).toContainText('体检报告明文标题', { timeout: 15_000 });
  await page.getByTestId('vault-lock-now').click();
  expect(await plainLeft(page, secrets), '点“上锁”下一帧不留明文').toEqual([]);
});

test('负责人“离开隐私记页 1 分钟不自动上锁”：换到随手记不到 1 分钟还解锁着，61 秒自己锁上', async ({ page, baseURL, browserName }) => {
  await page.clock.install();
  await fakeServer(page, baseURL);
  await setupAndUnlock(page, browserName);
  const lockrow = page.getByTestId('vault-lockrow');

  // 不到 1 分钟（离开起算 58 秒，后面点回去还要一点时间）：入口行还是“已解锁”；回到隐私记页列表照样在（计时作废）。
  // 装了假时钟时间照样在走：等入口行出现用掉的那一段从快进里扣掉（webkit 上约 1 秒，不扣就过了 60 秒，运行日志 vault autolock why=page）
  const clockNow = (): Promise<number> => page.evaluate(() => Date.now());
  const left = await clockNow();
  await page.getByTestId('vault-back').click();
  await expect(lockrow).toContainText('已解锁', { timeout: 15_000 });
  await page.clock.fastForward(Math.max(0, 58_000 - ((await clockNow()) - left)));
  await expect(lockrow).toContainText('已解锁');
  await lockrow.click();
  await expect(vaultEmpty(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('vault-unlock-card')).toHaveCount(0);

  // 再离开 61 秒：App 在前台也到点自己锁上，入口行写“已上锁”；回隐私记页要解锁
  await page.getByTestId('vault-back').click();
  await expect(lockrow).toContainText('已解锁', { timeout: 15_000 });
  await page.clock.fastForward(61_000);
  await expect(lockrow).toContainText('已上锁');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).toMatch(/vault autolock why=page/);
  await lockrow.click();
  await expect(page.getByTestId('vault-unlock-card')).toBeVisible({ timeout: 15_000 });
});
