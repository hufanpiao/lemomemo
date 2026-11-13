// 电脑版可拖动布局（B6，架构 5.9b，R-120、R-126 方案 B；定稿线框 s1、s7 电脑画面）的真浏览器用例，chromium、webkit 都跑（视口一律 1280×820 电脑宽度）：
//   ① 今天页两栏：鼠标按住把手把“本周”拖到左栏，出“布局已保存”，刷新后还在；点“撤销”回原位；再拖一次，“⋯ › 恢复默认布局”回默认
//   ② 栏宽（竖条 → 键）、收起再从“⋯”放回、锁定后把手和竖条都不画
//   ③ 键盘拖动：把手上空格拿起、← 挪到左栏、空格放下，每一步 aria-live 有播报；axe（WCAG 2.1 A/AA）无 serious、critical
//   ④ 1099px 宽排成一列、不能拖；回到 1280 恢复分栏
//   ⑤ 随手记页：分类一栏（点了筛选）+ 列表一栏；点卡片开抽屉，点抽屉顶上的把手换到左边，关了再开还在左边
// 点按前等 FADE_GUARD_MS（页面分包挂上后这段时间里落在 main 里的点按按设计吞掉，见 b5-anniv.spec.ts）
// 截图：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（1280×800、1440×900，浅色、深色），给评审对照线框用
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Locator, Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { expect, test } from './session-fixture.ts';

test.use({ trace: 'off', loggedIn: true, viewport: { width: 1280, height: 820 }, isMobile: false, hasTouch: false, timezoneId: 'Asia/Seoul' });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'];
const AXE_SRC = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function openToday(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('desk-panel-week')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(FADE_GUARD_MS);
}

/** 鼠标按住 from 的中心，分几步挪到 to 的中心偏下，再松手（dnd-kit 的 PointerSensor 要挪过 4px 才算拖） */
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('no_box');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 4 });
  // 拿起后 dnd-kit 下一帧才量好各块位置：等原位置出了虚框（data-dragging）再挪，挪到了停一下再松手（人手拖动本来就慢得多）
  await expect(page.locator('[data-dragging]')).toHaveCount(1);
  await page.waitForTimeout(100);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 10, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 6, { steps: 2 });
  await page.mouse.up();
  // dnd-kit 拖完 50 ms 内的 click 一律吞掉（防止松手那一下点到别的东西）；人手不会这么快，测试等一下再点
  await page.waitForTimeout(200);
}

/** 本机库 settings 仓里这一页布局那一行的值（JSON）；还没写进去时空串。刷新前先等它写进本机库（写进 IndexedDB 是异步的） */
async function stored(page: Page, p: string): Promise<string> {
  return page.evaluate(
    (prefix) =>
      new Promise<string>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onerror = () => reject(new Error(String(req.error)));
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('settings', 'readonly').objectStore('settings').getAll();
          all.onsuccess = () => {
            db.close();
            const rows = all.result as { view?: { key?: string; value?: unknown } }[];
            const row = rows.find((r) => r.view?.key?.startsWith(prefix));
            resolve(row ? JSON.stringify(row.view?.value) : '');
          };
          all.onerror = () => reject(new Error(String(all.error)));
        };
      }),
    `layout.${p}@inst:`,
  );
}

const inCol = (page: Page, col: number, id: string) => page.getByTestId(`desk-col-${col}`).getByTestId(`desk-panel-${id}`);

async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

/** 本机库写几个分类和几条随手记（形状同 b4-notes-s7s8.spec.ts 的 seedCategories），写完刷新 */
async function seedNotes(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onerror = () => reject(new Error(String(req.error)));
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['categories', 'notes'], 'readwrite');
          const cats = [
            { id: '0e2e0000-0000-4000-8000-0000000006a1', name: '工作灵感', color: '#e0a100' },
            { id: '0e2e0000-0000-4000-8000-0000000006a2', name: '韩国生活', color: '#3f8f6b' },
            { id: '0e2e0000-0000-4000-8000-0000000006a3', name: '读书', color: '#4a6fd1' },
          ];
          cats.forEach((c, i) => {
            const row = { ...c, sort: i + 1, created_by: 'ai', merged_into: null, deleted_at: null, undone: false, rev: 1 };
            tx.objectStore('categories').put({ id: c.id, server: row, view: row });
          });
          const texts: [string, number][] = [
            ['外国人登录证更新要带的：护照、照片 1 张、手续费 3 万韩元', 1],
            ['NEOX 片尾 logo 停留可以再短 0.5 秒，配合鼓点收尾', 0],
            ['牛奶、鸡蛋、猫砂', 1],
            ['想读：《어린 왕자》韩文版，朋友推荐的版本', 2],
            ['SignPlex 落地页标题：一次签完，不用打印', 0],
            ['延南洞那家面包店周一休息，下次周二去', 1],
          ];
          const now = Date.now();
          texts.forEach(([body, ci], i) => {
            const id = `0e2e0000-0000-4000-8000-0000000006b${i}`;
            const t = now - i * 3_600_000;
            const note = {
              id, title: null, body, is_private: false, category_id: cats[ci]?.id, category_source: 'ai', category_seen: true, tags: [],
              converted_to: null, source: 'page', raw_text: '', batch_id: null, created_at: t, updated_at: t,
            };
            tx.objectStore('notes').put({ id, server: null, view: note });
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error(String(tx.error)));
        };
      }),
  );
  await page.reload();
}

test.describe('B6 电脑版布局：今天页', () => {
  test.beforeEach(async ({ page }) => openToday(page));

  test('① 拖一块跨栏、刷新还在、撤销、恢复默认', async ({ page }) => {
    await expect(inCol(page, 1, 'week')).toBeVisible();
    await drag(page, page.getByTestId('desk-handle-week'), page.getByTestId('desk-panel-river'));
    await expect(inCol(page, 0, 'week')).toBeVisible();
    await expect(page.getByTestId('desk-saved')).toContainText('布局已保存');
    await expect.poll(() => stored(page, 'today'), { timeout: 10_000 }).toContain('"panels":["now","week","river"]');
    await page.reload();
    await expect(inCol(page, 0, 'week')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);

    // 刷新后提示条没了：再拖一次（拖回右栏）再撤销，回到左栏
    await drag(page, page.getByTestId('desk-handle-week'), page.getByTestId('desk-panel-notes-today'));
    await expect(inCol(page, 1, 'week')).toBeVisible();
    await page.getByTestId('desk-saved-undo').click();
    await expect(inCol(page, 0, 'week')).toBeVisible();

    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-reset').click();
    await expect(inCol(page, 1, 'week')).toBeVisible();
    await expect.poll(() => stored(page, 'today'), { timeout: 10_000 }).toContain('"panels":["now","river"]');
    await page.reload();
    await expect(inCol(page, 1, 'week')).toBeVisible({ timeout: 20_000 });
  });

  test('② 调栏宽、收起再放回、锁定', async ({ page }) => {
    // “⋯”在侧栏底部（GlassBar 的 tabbar-slot；“＋”就绪前后侧栏会重挂一次，也得跟过去）
    await expect(page.getByTestId('tabbar-slot').getByTestId('desk-more')).toBeVisible();
    const col0 = page.getByTestId('desk-col-0');
    await expect(page.getByTestId('desk-col-1')).toBeVisible();
    const w0 = (await col0.boundingBox())?.width ?? 0;
    await page.getByTestId('desk-sep-0').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await col0.boundingBox())?.width ?? 0).toBeGreaterThan(w0 + 40);
    await expect(page.getByTestId('desk-saved')).toBeVisible();

    await page.getByTestId('desk-fold-soon').click();
    await expect(page.getByTestId('desk-panel-soon')).toHaveCount(0);
    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-restore-soon').click();
    await expect(inCol(page, 1, 'soon')).toBeVisible();

    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-lock').click();
    await expect(page.getByTestId('desk')).toHaveAttribute('data-locked', '');
    await expect(page.locator('[data-testid^="desk-handle-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="desk-sep-"]')).toHaveCount(0);
    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-lock').click();
    await expect(page.getByTestId('desk-handle-week')).toBeVisible();
  });

  test('③ 键盘拖动有播报；axe 无严重问题', async ({ page }) => {
    const live = page.getByTestId('desk-live');
    await page.getByTestId('desk-handle-soon').focus();
    await page.keyboard.press('Space');
    await expect(live).toContainText('拿起了“快到了”，第 2 栏');
    await page.keyboard.press('ArrowLeft');
    await expect(live).toContainText('“快到了”，第 1 栏');
    await page.keyboard.press('Space');
    await expect(live).toContainText('放下了“快到了”，第 1 栏');
    await expect(inCol(page, 0, 'soon')).toBeVisible();
    await expect(page.getByTestId('desk-handle-soon')).toBeFocused();

    // Esc 取消：拿起、挪、Esc，回到原位
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await expect(live).toContainText('已取消');
    await expect(inCol(page, 0, 'soon')).toBeVisible();

    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.evaluate(AXE_SRC);
    const bad = await page.evaluate(async () => {
      type Res = { violations: { id: string; impact: string | null; nodes: { target: unknown[] }[] }[] };
      const w = window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<Res> } };
      const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} ${JSON.stringify(v.nodes.slice(0, 3).map((n) => n.target))}`);
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  test('④ 1099px 排成一列、不能拖；回到 1280 恢复分栏', async ({ page }) => {
    await page.setViewportSize({ width: 1099, height: 820 });
    await expect(page.getByTestId('desk')).toHaveAttribute('data-desk', 'one');
    await expect(page.getByTestId('desk-col-1')).toHaveCount(0);
    await expect(page.locator('[data-testid^="desk-handle-"]')).toHaveCount(0);
    await expect(page.getByTestId('desk-col-0').getByTestId('desk-panel-week')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(page.getByTestId('desk')).toHaveAttribute('data-desk', 'cols');
    await expect(inCol(page, 1, 'week')).toBeVisible();
  });
});

test.describe('B6 电脑版布局：随手记页', () => {
  test('⑤ 分类一栏 + 列表一栏；抽屉换边、记住', async ({ page }) => {
    await page.goto('/app/#/notes');
    await expect(page.getByTestId('desk-panel-list')).toBeVisible({ timeout: 20_000 });
    await seedNotes(page);
    await expect(page.getByTestId('desk-panel-cats').getByTestId('notes-filter-all')).toContainText('6', { timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);

    await page.getByTestId('notes-filter-0e2e0000-0000-4000-8000-0000000006a3').click();
    await expect(page.locator('[data-testid^="notes-card-"]')).toHaveCount(1);
    await expect(page.getByTestId('desk-panel-list')).toContainText('读书 1');
    await page.getByTestId('notes-filter-all').click();
    await expect(page.locator('[data-testid^="notes-card-"]')).toHaveCount(6);

    const card = page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' }).locator('button').first();
    await card.click();
    const drawer = page.getByTestId('note-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).not.toHaveAttribute('data-side', 'left');
    await page.getByTestId('desk-drawer-side').click();
    await expect(drawer).toHaveAttribute('data-side', 'left');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => stored(page, 'notes'), { timeout: 10_000 }).toContain('"drawer":"left"');
    await page.reload();
    await expect(page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);
    await page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' }).locator('button').first().click();
    await expect(page.getByTestId('note-drawer')).toHaveAttribute('data-side', 'left');
  });
});

test.describe('B6 评审截图', () => {
  test.skip(!SHOT_DIR, '设了 LEMO_SHOT_DIR 才截');

  for (const [w, h] of [
    [1280, 800],
    [1440, 900],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`截图 ${w}×${h} ${scheme}`, async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '只在 Chromium 上截');
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/app/#/notes');
        await expect(page.getByTestId('desk-panel-list')).toBeVisible({ timeout: 20_000 });
        await seedNotes(page);
        await expect(page.locator('[data-testid^="notes-card-"]')).toHaveCount(6, { timeout: 20_000 });
        const tag = `${w}x${h}-${scheme}`;
        await shot(page, browserName, `随手记-${tag}`);
        await page.waitForTimeout(FADE_GUARD_MS);
        await page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' }).locator('button').first().click();
        await expect(page.getByTestId('note-drawer')).toBeVisible();
        await shot(page, browserName, `随手记抽屉-${tag}`);
        await page.keyboard.press('Escape');
        await openToday(page);
        await shot(page, browserName, `今天-${tag}`);
        await page.getByTestId('desk-more').click();
        await shot(page, browserName, `今天布局菜单-${tag}`);
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1024, height: h });
        await shot(page, browserName, `今天一列1024-${tag}`);
        await page.setViewportSize({ width: w, height: h });
        for (const p of ['calendar', 'todos', 'vault']) {
          await page.goto(`/app/#/${p}`);
          await page.waitForTimeout(1500);
          await shot(page, browserName, `${p}-${tag}`);
        }
      });
    }
  }
});
