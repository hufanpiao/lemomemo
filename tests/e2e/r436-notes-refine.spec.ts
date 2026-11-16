// 随手记页精致化 e2e（R-436，照待办页 518f49a0 的做法）：
// • 随手记页不出“＋”上方的新手气泡（主持人 11-16 代定：这页“＋”是聚焦底部输入行，“按住说话 · 点一下打字”对不上）；
//   今天页照常出，切到随手记页收起，回今天页再出（同 b5-anniv.spec.ts 纪念日页那条的走法）
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
