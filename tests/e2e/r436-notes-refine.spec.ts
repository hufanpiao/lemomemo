// 随手记页精致化 e2e（R-436，照待办页 518f49a0 的做法）：
// • 随手记页不出“＋”上方的新手气泡（主持人 11-16 代定：这页“＋”是聚焦底部输入行，“按住说话 · 点一下打字”对不上）；
//   今天页照常出，切到随手记页收起，回今天页再出（同 b5-anniv.spec.ts 纪念日页那条的走法）
// • 打字条开着时也不出气泡（R-451 主持人 11-17：已经在打字，提示多余、压在打字条右下角）；收起后照原规则再出
// • 分类胶囊用 kit 的 Chip（负责人 11-16“胶囊太大了！参考现在的待办页”）：高 30、没有描边；条数是等宽字
// • 标题下一行等宽小字“日期 · 共 N 条”；列表方式的分组名右边等宽条数
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const CAT = '0e2e0000-0000-4000-8000-00000000c436';
const note = (id: string, body: string) => ({
  id, user_id: FAKE_USER_ID, title: null, body, is_private: false, category_id: CAT, category_source: 'ai', category_seen: true, ai_status: 'done',
  tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: null, undone: false, created_at: Date.now() - 60_000, updated_at: 1, rev: 1,
});

test('今天页有“＋”气泡；切到随手记页不出，回今天页再出', async ({ page }) => {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('plus-hint')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    location.hash = '#/notes';
  });
  await expect(page.getByTestId('notes-input')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('plus-hint')).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = '#/today';
  });
  await expect(page.getByTestId('plus-hint')).toBeVisible({ timeout: 30_000 });
});

test('今天页点“＋”打开打字条：气泡不见；“收起”以后再出（R-451）', async ({ page }) => {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('plus-hint')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-bar')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('plus-hint')).toHaveCount(0);
  await page.getByTestId('type-bar').getByRole('button', { name: '收起' }).click();
  await expect(page.getByTestId('type-bar')).toHaveCount(0);
  await expect(page.getByTestId('plus-hint')).toBeVisible({ timeout: 10_000 });
});

test('直接打开随手记页也不出“＋”气泡', async ({ page }) => {
  await page.goto('/app/#/notes');
  await expect(page.getByTestId('notes-input')).toBeVisible({ timeout: 30_000 });
  // 气泡由首屏后才下载的那一块挂（TypeBarPreload）：等那一块到了（按住“＋”那套 RecordHost 和气泡同一个 Suspense）再看
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('plus-hint')).toHaveCount(0);
});

test('分类胶囊高 30、无描边，条数等宽；标题下等宽小字；列表分组名带条数', async ({ page }) => {
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30_000 });
  await idbPut(page, [
    ['categories', cached({ id: CAT, name: '工作灵感', color: 'p4', sort: 1, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 })],
    ...[note('0e2e0000-0000-4000-8000-000000043601', '第一条'), note('0e2e0000-0000-4000-8000-000000043602', '第二条')].map((r) => ['notes', cached(r)] as const),
    ['settings', cached({ id: '0e2e0000-0000-4000-8000-000000043691', key: 'notes.view@desktop', value: 'list', deleted_at: null, undone: false, rev: 1 })],
    ['settings', cached({ id: '0e2e0000-0000-4000-8000-000000043692', key: 'notes.view@mobile', value: 'list', deleted_at: null, undone: false, rev: 1 })],
  ]);
  await page.reload();
  const chip = page.getByTestId(`notes-filter-${CAT}`);
  await expect(chip).toHaveText(/^工作灵感\s*2$/, { timeout: 30_000 });
  const look = await chip.evaluate((el) => {
    const cs = getComputedStyle(el);
    const n = el.querySelector('span');
    return { h: el.getBoundingClientRect().height, border: cs.borderTopWidth, mono: n ? getComputedStyle(n).fontFamily : '' };
  });
  expect(look.h).toBe(30);
  expect(look.border).toBe('0px');
  expect(look.mono).toMatch(/mono/i);
  await expect(page.getByTestId('notes-filter-all')).toHaveText(/^全部\s*2$/);
  await expect(page.getByTestId('notes-sub')).toHaveText(/月.*日.* · 共 2 条$/);
  const head = page.locator('[data-testid^="notes-g-"]').first().getByRole('heading');
  await expect(head).toHaveText(/^今天\s*2$/);
});

// 负责人 11-19“其他可以自己编辑分类，可以创建分类”“随手记记录完的点进去可以自己指定分类”；隐私记的分类“隐私记自己一套”：
// 分类那一排最后“＋ 新分类”（建好就筛到这一类、空的写 0）；长按胶囊改名、删除（删了回“全部”，记录还在）；隐私记的分类这里看不到，编辑页下拉也没有
test('随手记分类：“＋ 新分类”、长按改名删除；隐私记的分类不出现', async ({ page }) => {
  const VCAT = '0e2e0000-0000-4000-8000-00000000c437';
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30_000 });
  await idbPut(page, [
    ['categories', cached({ id: CAT, name: '工作灵感', color: 'p4', sort: 1, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 })],
    ['categories', cached({ id: VCAT, name: '密码', color: null, sort: 1, created_by: 'user', merged_into: null, vault: true, deleted_at: null, undone: false, rev: 1 })],
    ...[note('0e2e0000-0000-4000-8000-000000043701', '第一条'), note('0e2e0000-0000-4000-8000-000000043702', '第二条')].map((r) => ['notes', cached(r)] as const),
  ]);
  await page.reload();
  const filter = page.getByTestId('notes-filter');
  await expect(page.getByTestId(`notes-filter-${CAT}`)).toHaveText(/^工作灵感\s*2$/, { timeout: 30_000 });
  await expect(filter).not.toContainText('密码');

  await page.getByTestId('notes-filter-new').click();
  await page.getByTestId('cat-new-name').fill('读书');
  await page.getByTestId('cat-new-ok').click();
  const reading = filter.locator('[data-testid^="notes-filter-"]', { hasText: '读书' });
  await expect(reading).toHaveText(/^读书\s*0$/);
  await expect(reading).toHaveAttribute('aria-pressed', 'true');

  const hold = async (testId: string) => {
    // 上一个弹窗关完（层退掉）再按：关的过程中按下去按到的是 html（运行日志 down html）
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const b = await page.getByTestId(testId).boundingBox();
    if (!b) throw new Error('没找到');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    const tail = (await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).split(String.fromCharCode(10)).slice(-10).join(String.fromCharCode(10));
    await expect(page.getByTestId('cat-edit-name'), tail).toBeVisible();
  };
  await hold(`notes-filter-${CAT}`);
  await page.getByTestId('cat-edit-name').fill('工作');
  await page.getByTestId('cat-edit-ok').click();
  await expect(page.getByTestId(`notes-filter-${CAT}`)).toHaveText(/^工作\s*2$/);
  // 长按不算点：筛的还是“读书”
  await expect(reading).toHaveAttribute('aria-pressed', 'true');

  const rid = (await reading.getAttribute('data-testid')) ?? '';
  await hold(rid);
  await page.getByTestId('cat-edit-delete').click();
  await page.getByTestId('cat-edit-delete-ok').click();
  await expect(page.getByTestId(rid)).toHaveCount(0);
  await expect(page.getByTestId('notes-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('notes-filter-all')).toHaveText(/^全部\s*2$/);

  // 编辑页下拉只有随手记的分类（隐私记的“密码”不在）；在下拉里改分类照样能改
  await page.getByText('第一条', { exact: true }).first().click();
  const sel = page.getByTestId('note-edit-category');
  await expect(sel).toBeVisible();
  const opts = await sel.locator('option').allTextContents();
  expect(opts).toContain('工作');
  expect(opts).not.toContain('密码');
});

// 负责人 11-19 晚截图：点“＋ 新分类”键盘起来，起名弹窗被压在键盘下面、键盘上出“自动填充联系人”。
// 弹窗底边跟着 --kb（platform/viewport.ts 写的键盘高度）抬到键盘上面；起名框 autocomplete=off、占位字不带“名字”
test('起名弹窗：键盘弹着时整块在键盘上面；起名框不让 iOS 当成填联系人的框', async ({ page }) => {
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30_000 });
  await page.getByTestId('notes-filter-new').click();
  const name = page.getByTestId('cat-new-name');
  await expect(name).toBeVisible();
  await expect(name).toHaveAttribute('autocomplete', 'off');
  expect(await name.getAttribute('placeholder')).not.toContain('名字');
  const KB = 336;
  await page.evaluate((k) => {
    const r = document.documentElement;
    r.setAttribute('data-kbo', '1');
    r.style.setProperty('--kb', `${k}px`);
  }, KB);
  const dialog = page.getByRole('dialog');
  await expect
    .poll(async () => {
      const b = await dialog.boundingBox();
      const h = await page.evaluate(() => window.innerHeight);
      return b ? Math.round(b.y + b.height) <= h - KB : false;
    })
    .toBe(true);
  // 输入框、“建好”按钮都在键盘上面
  const ok = await page.getByTestId('cat-new-ok').boundingBox();
  const h = await page.evaluate(() => window.innerHeight);
  expect((ok?.y ?? h) + (ok?.height ?? 0)).toBeLessThanOrEqual(h - KB);
});

// 负责人 11-20 截图（隐私记点“＋ 新分类”）：“这个背景色也弄成透明模糊，跟隐私记记录的输入框一样的背景模糊”“随手记也是一样”，选“后面整页模糊、卡片不变”：
// 弹窗后面那层是输入时同一层液态模糊（kit Mist 的材质，16px），压在页面上面、弹窗卡片下面；隐私记页强制实色（data-rt="1"）时照样模糊
test('新分类弹窗：后面整页是 16px 液态模糊，隐私记强制实色时也一样', async ({ page }) => {
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30_000 });
  await page.getByTestId('notes-filter-new').click();
  await expect(page.getByTestId('cat-new-name')).toBeVisible();
  const back = () =>
    page.evaluate(() => {
      // webkit 的不带前缀写法读出来是 none，要连带前缀的一起看
      const fx = (e: Element) => `${getComputedStyle(e).backdropFilter} ${getComputedStyle(e).getPropertyValue('-webkit-backdrop-filter')}`;
      const el = [...document.querySelectorAll<HTMLElement>('body *')].find((e) => /blur\(16px\)/.test(fx(e)));
      if (!el) return null;
      const cs = getComputedStyle(el);
      const card = document.querySelector('[role="dialog"]');
      const r = el.getBoundingClientRect();
      return { pos: cs.position, full: r.width >= innerWidth && r.height >= innerHeight, z: Number(cs.zIndex), cardZ: Number(getComputedStyle(card!.parentElement!).zIndex), before: el.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING, opacity: Number(cs.opacity) };
    });
  await expect.poll(async () => (await back())?.opacity ?? 0).toBe(1);
  const b = await back();
  expect(b?.pos).toBe('fixed');
  expect(b?.full).toBe(true);
  // 和弹窗同一层、在 DOM 里排在卡片前面：卡片画在它上面
  expect(b?.z).toBe(b?.cardZ);
  expect(b?.before).toBeTruthy();
  await page.evaluate(() => document.documentElement.setAttribute('data-rt', '1'));
  expect(await back(), '隐私记强制实色时后面那层也得是模糊').not.toBeNull();
});

test('分类里导入没分类的记录：勾选多条点“导入 N 条”，归进这一类、“导入”行跟着变', async ({ page }) => {
  const L1 = '0e2e0000-0000-4000-8000-000000043801';
  const L2 = '0e2e0000-0000-4000-8000-000000043802';
  const L3 = '0e2e0000-0000-4000-8000-000000043803';
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30_000 });
  await idbPut(page, [
    ['categories', cached({ id: CAT, name: '工作灵感', color: 'p4', sort: 1, created_by: 'user', merged_into: null, deleted_at: null, undone: false, rev: 1 })],
    ['notes', cached(note('0e2e0000-0000-4000-8000-000000043800', '已有一条'))],
    ...[note(L1, '散的一'), note(L2, '散的二'), note(L3, '散的三')].map((r) => ['notes', cached({ ...r, category_id: null, category_source: null })] as const),
  ]);
  await page.reload();
  // 筛“全部”时没有导入行
  await expect(page.getByTestId(`notes-filter-${CAT}`)).toHaveText(/^工作灵感\s*1$/, { timeout: 30_000 });
  await expect(page.getByTestId('notes-import-open')).toHaveCount(0);

  await page.getByTestId(`notes-filter-${CAT}`).click();
  const open = page.getByTestId('notes-import-open');
  await expect(open).toContainText('导入没分类的 3 条');
  await open.click();
  await expect(page.getByTestId('notes-import-list').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('notes-import-ok')).toBeDisabled();
  await page.getByTestId(`notes-import-${L1}`).check();
  await page.getByTestId(`notes-import-${L3}`).check();
  await expect(page.getByTestId('notes-import-ok')).toHaveText('导入 2 条');
  await page.getByTestId('notes-import-ok').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId(`notes-filter-${CAT}`)).toHaveText(/^工作灵感\s*3$/);
  await expect(open).toContainText('导入没分类的 1 条');
  await expect(page.getByText('散的一', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('散的二', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).toContain('notes category into n=2 ok=2 fail=0');
});

test('拖进分类：没分类的那一条长按拖到分类胶囊上松手，归进这一类；已有分类的拖上去不认', async ({ page }) => {
  const L1 = '0e2e0000-0000-4000-8000-000000043901';
  const HAS = '0e2e0000-0000-4000-8000-000000043900';
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30_000 });
  await idbPut(page, [
    ['categories', cached({ id: CAT, name: '工作灵感', color: 'p4', sort: 1, created_by: 'user', merged_into: null, deleted_at: null, undone: false, rev: 1 })],
    ['notes', cached(note(HAS, '有分类的'))],
    ['notes', cached({ ...note(L1, '散的那条'), category_id: null, category_source: null })],
  ]);
  await page.reload();
  const chip = page.getByTestId(`notes-filter-${CAT}`);
  await expect(chip).toHaveText(/^工作灵感\s*1$/, { timeout: 30_000 });
  const drag = async (rowText: string) => {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const r = await page.getByText(rowText, { exact: true }).first().boundingBox();
    const c = await chip.boundingBox();
    if (!r || !c) throw new Error('没找到');
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    const to = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
    for (let k = 1; k <= 12; k++) await page.mouse.move(r.x + r.width / 2 + ((to.x - r.x - r.width / 2) * k) / 12, r.y + r.height / 2 + ((to.y - r.y - r.height / 2) * k) / 12);
    await page.waitForTimeout(100);
    return chip.getAttribute('data-drop-over');
  };
  // 已有分类的：手指落在胶囊上也不高亮、松手不改
  expect(await drag('有分类的')).toBeNull();
  await page.mouse.up();
  await expect(chip).toHaveText(/^工作灵感\s*1$/);
  // 没分类的：落在胶囊上高亮，松手归进这一类
  expect(await drag('散的那条')).toBe('');
  await page.mouse.up();
  await expect(chip).toHaveText(/^工作灵感\s*2$/);
  await expect(chip).not.toHaveAttribute('data-drop-over');
  // 运行日志按批写进 localStorage：等它写到
  const log = () => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
  await expect.poll(log).toContain('drop into');
  await expect.poll(log).toContain('notes category into n=1 ok=1 fail=0');
});
