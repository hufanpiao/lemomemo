// 随手记 S7 合并分类提示条、S8 转成待办 / 日程的真浏览器用例（B4 TC-B4-07、TC-B4-08）
// jsdom 测过流程和写库顺序（NotesPage-s7s8.test.tsx、NotesPage-merge-undo.test.tsx），这里用真浏览器、真构建守：
// S8（R-414，负责人 11-13 定：超过 2000 字不让转，带插图的转换后原条保留）：
//   ① 不带图的转成待办：卡片从列表里没了、输入行上面出“已转成待办，原来这条进了‘最近删除’”，待办页有这一条；
//   ② 超过 2000 字：菜单里两项变淡（aria-disabled）、下面写“超过 2000 字，转不了”，点了不动；
//   ③ 带插图的转成日程：先弹确认窗，点“转成 1 条日程”后原条留着、标题前出“已转过”、提示“这条随手记留着”。
// S7（R-413 线框 MERGE，R-415 合并给 8 秒撤销条）：
//   ④ 本机有“购物”“购物清单”两个分类（本机规则②：一个包含另一个）时出提示条“…两个分类很像，合成一个吗？ 合并 / 不用”，点“合并”收起、底部出“已合并 · 撤销”；
//   ⑤ 点“不用”收起，刷新后也不再出。
//   分类没法在界面上建（都是 AI 分类时提出来的），先让 App 开好本机库，再往 categories、notes 仓写服务器形状的行、刷新
// 截图：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（WebKit 截图会往页面插 <style>、被 CSP 记成违规，见 r416-notes-pend.spec.ts 文件头）；断言两种浏览器都跑
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

test.use({ trace: 'off', loggedIn: true, viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'Asia/Seoul' });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'];
/** 给主持人看的截图：CSS 动画快进到末尾；列表挪位置是 JS 动画（快进不了），先等 1 秒，免得截到挪一半。不设 LEMO_SHOT_DIR 时不截也不等 */
async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

/** 页面里用 canvas 画一张小 JPEG（选图用，内容随便） */
async function jpeg(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no_ctx');
    ctx.fillStyle = 'hsl(40 70% 55%)';
    ctx.fillRect(0, 0, 320, 240);
    const b = await new Promise<Blob>((res) => c.toBlob((x) => res(x as Blob), 'image/jpeg', 0.9));
    return [...new Uint8Array(await b.arrayBuffer())];
  });
  return Buffer.from(Uint8Array.from(bytes));
}

async function addNote(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('notes-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

const cardOf = (page: Page, text: string) => page.locator('[data-testid^="notes-card-"]', { hasText: text });

async function openMenu(page: Page, text: string): Promise<void> {
  await cardOf(page, text).locator('[data-testid^="notes-more-"]').click();
  await expect(page.locator('[data-testid^="notes-to-todo-"]')).toBeVisible();
}

test.describe('S8 随手记转成待办 / 日程', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/#/notes');
    await expect(page.getByTestId('notes-input')).toBeVisible({ timeout: 20_000 });
  });

  test('不带图的转成待办：原条进最近删除、待办页有这一条', async ({ page, browserName }) => {
    await addNote(page, '周五交季度报告');
    await expect(cardOf(page, '周五交季度报告')).toHaveCount(1);
    await openMenu(page, '周五交季度报告');
    await shot(page, browserName, 'S8-1-菜单');
    await page.locator('[data-testid^="notes-to-todo-"]').click();
    await expect(page.getByTestId('notes-conv-tip')).toHaveText('已转成待办，原来这条进了“最近删除”');
    await expect(cardOf(page, '周五交季度报告')).toHaveCount(0);
    await shot(page, browserName, 'S8-1-转好');
    await page.goto('/app/#/todos');
    await expect(page.locator('[data-testid^="todos-row-"]', { hasText: '周五交季度报告' })).toHaveCount(1, { timeout: 20_000 });
  });

  test('超过 2000 字：两项变淡、写原因、点了不动', async ({ page, browserName }) => {
    // 输入行是单行框，整段就是一行：标题截短、备注放全文，备注超过 2000 字
    await addNote(page, `长文一篇${'字'.repeat(2100)}`);
    await expect(cardOf(page, '长文一篇')).toHaveCount(1);
    await openMenu(page, '长文一篇');
    const toTodo = page.locator('[data-testid^="notes-to-todo-"]');
    const toEvent = page.locator('[data-testid^="notes-to-event-"]');
    await expect(toTodo).toHaveAttribute('aria-disabled', 'true');
    await expect(toEvent).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('[data-testid^="notes-conv-long-"]')).toHaveText('超过 2000 字，转不了');
    await shot(page, browserName, 'S8-超长');
    // aria-disabled 的按钮 Playwright 当作不能点，force 照样点下去，验页面不动
    await toTodo.click({ force: true });
    await expect(page.getByTestId('notes-conv-tip')).toHaveCount(0);
    await expect(cardOf(page, '长文一篇')).toHaveCount(1);
  });

  test('带插图的转成日程：先问、原条留着', async ({ page, browserName }) => {
    await page.getByTestId('notes-img-input').setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page) });
    await expect(page.getByTestId('notes-pend').locator('li')).toHaveCount(1);
    await addNote(page, '周六去看展');
    const card = cardOf(page, '周六去看展');
    await expect(card).toHaveCount(1);
    await expect(card.locator('img')).toHaveCount(1, { timeout: 20_000 });
    await openMenu(page, '周六去看展');
    await page.locator('[data-testid^="notes-to-event-"]').click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('日程不能带图片');
    await shot(page, browserName, 'S8-2-带图确认');
    await dlg.getByRole('button', { name: '转成 1 条日程' }).click();
    await expect(page.getByTestId('notes-conv-tip')).toHaveText('已转成日程，这条随手记留着');
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-testid^="notes-conv-"]')).toHaveCount(1);
  });
});

const KEEP = '0e2e0000-0000-4000-8000-0000000005a1';
const MERGE = '0e2e0000-0000-4000-8000-0000000005a2';

/** 往本机库 categories 仓写两行分类（形状同 applyServer 写进去的：server、view 同一份服务器行），notes 仓写一条归在第二个分类下的随手记 */
async function seedCategories(page: Page): Promise<void> {
  await page.evaluate(
    (cats) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onerror = () => reject(new Error(String(req.error)));
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['categories', 'notes'], 'readwrite');
          for (const c of cats) {
            const row = { id: c.id, name: c.name, color: null, sort: c.sort, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 };
            tx.objectStore('categories').put({ id: c.id, server: row, view: row });
          }
          // 一条归在“购物清单”下的随手记：分类胶囊只列有条目的分类，刷新后看见胶囊就说明本机库读好了
          const now = Date.now();
          const note = {
            id: '0e2e0000-0000-4000-8000-0000000005b1', title: null, body: '牛奶 鸡蛋', is_private: false, category_id: cats[1]?.id,
            category_source: 'ai', category_seen: true, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, created_at: now, updated_at: now,
          };
          tx.objectStore('notes').put({ id: note.id, server: null, view: note });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error(String(tx.error)));
        };
      }),
    [
      { id: KEEP, name: '购物', sort: 1 },
      { id: MERGE, name: '购物清单', sort: 2 },
    ],
  );
}

test.describe('S7 合并分类提示条', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/#/notes');
    await expect(page.getByTestId('notes-input')).toBeVisible({ timeout: 20_000 });
    await seedCategories(page);
    await page.reload();
    await expect(page.getByTestId('notes-merge')).toBeVisible({ timeout: 20_000 });
  });

  test('出提示条；点“合并”收起、底部出“已合并 · 撤销”', async ({ page, browserName }) => {
    const bar = page.getByTestId('notes-merge');
    await expect(bar).toContainText('“购物”和“购物清单”两个分类很像，合成一个吗？');
    await expect(page.getByTestId('notes-merge-go')).toHaveText('合并');
    await expect(page.getByTestId('notes-merge-no')).toHaveText('不用');
    await shot(page, browserName, 'S7-提示条');
    await page.getByTestId('notes-merge-go').click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId('notes-merge-toast')).toContainText('已合并');
    // 条目归到留下的分类：胶囊只剩“购物 1”
    await expect(page.getByTestId(`notes-filter-${KEEP}`)).toHaveText('购物 1');
    await expect(page.getByTestId(`notes-filter-${MERGE}`)).toHaveCount(0);
    await shot(page, browserName, 'S7-已合并');
  });

  test('点“不用”收起，刷新后也不再出', async ({ page }) => {
    await page.getByTestId('notes-merge-no').click();
    await expect(page.getByTestId('notes-merge')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('notes-input')).toBeVisible({ timeout: 20_000 });
    // 等分类胶囊出来（本机库读好了）再判提示条没出
    await expect(page.getByTestId('notes-filter')).toContainText('购物清单');
    await expect(page.getByTestId('notes-merge')).toHaveCount(0);
  });
});
