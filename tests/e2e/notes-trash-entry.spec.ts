// 随手记页常驻的“最近删除”入口（负责人 11-15“随手记删除后在哪里可以找到？”）：标题下面、分类胶囊上面居中一个，点了进全站的 #/trash；
// 删掉的随手记在那里能看到（原来只能从图片空间满的提示条进）。和隐私记页那一个是同一份（notes 的 TrashLink）
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const note = (id: string, body: string, deletedAt: number | null) => ({
  id, user_id: FAKE_USER_ID, title: null, body, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
  tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: deletedAt, undone: false, created_at: Date.now() - 60000, updated_at: 1, rev: 1,
});

test('随手记页“最近删除”：在标题下面居中，点了进 #/trash，删掉的那条在里面', async ({ page }) => {
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30000 });
  await idbPut(page, [note('n-live', '留着的一条', null), note('n-gone', '删掉的一条', Date.now() - 60000)].map((r) => ['notes', cached(r)] as const));
  await page.reload();
  const link = page.getByTestId('notes-open-trash');
  await expect(link).toHaveText('最近删除');
  // 位置：标题下面、居中（按钮中线和页面中线差不到 2px）
  const [h, b, vw] = await Promise.all([
    page.locator('[data-testid="notes"] h1').boundingBox(),
    link.boundingBox(),
    page.evaluate(() => document.documentElement.clientWidth),
  ]);
  expect(b !== null && h !== null && b.y > h.y + h.height - 1).toBe(true);
  expect(Math.abs((b?.x ?? 0) + (b?.width ?? 0) / 2 - vw / 2)).toBeLessThan(2);
  await link.click();
  await expect(page).toHaveURL(/#\/trash$/);
  await expect(page.getByTestId('trash-row-n-gone')).toContainText('删掉的一条');
});
