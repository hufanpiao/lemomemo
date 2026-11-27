// “＋”打字条的签（方案丙，负责人 11-21 定；ui/PlusFields.tsx）：真浏览器里把分类、日期、提醒三个签各点一遍，记下后读本机库核写进去的列
// • 待办页：打字 → 签自动填（浅黄）→ 分类“＋”新建、日期点“明天”和“其他时刻”（占位格子，不弹系统框）、提醒默认亮了再点掉 → 记下 → todos 行
// • 日历页：没说日子时日期签写选中的那天；说了时刻的日程点“全天”“共 3 天”、点亮提醒 → 记下 → events 行是跨 3 天的全天日程、remind_days 0
// jsdom 测不了的：签点了不收键盘（form 拦 mousedown）、三个签一排放得下、展开区不把打字条顶出屏幕——这里只核焦点和位置，iOS 键盘只能真机看
import type { Page } from '@playwright/test';
import { idbRead } from './idb.ts';
import { logOnFail } from './fail-log.ts';
import { expect, test } from './session-fixture.ts';

logOnFail(test);

type Row = { view: Record<string, unknown> };
/** 本机库里标题是 title 的那一行（outbox 先写本机，记下当场就在） */
async function rowOf(page: Page, store: 'todos' | 'events', title: string): Promise<Record<string, unknown> | undefined> {
  const all = (await idbRead<Row[]>(page, store, 'getAll')) ?? [];
  return all.map((r) => r.view).find((v) => v['title'] === title);
}

test.describe('“＋”打字条的三个签（方案丙）', () => {
  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: 'Asia/Seoul' });

  test('待办页：识别填签，点分类新建、日期和其他时刻、提醒点掉，记下写进 todos', async ({ page }) => {
    await page.goto('/app/#/todos');
    await page.getByTestId('tabbar-add').click();
    const input = page.getByTestId('type-input');
    await expect(input).toBeFocused();
    // 没说时刻：本机规则认成待办（R6），日期签填“后天”画浅黄，提醒不亮
    await input.fill('后天交周报');
    const date = page.getByTestId('field-date');
    await expect(date).toContainText('后天');
    await expect(date).toHaveClass(/auto/);
    await expect(page.getByTestId('field-remind')).toHaveAttribute('aria-pressed', 'false');

    // 分类：“＋”新建
    await page.getByTestId('field-project').click();
    await expect(input, '点签不收键盘').toBeFocused();
    await page.getByTestId('field-addproj').click();
    await page.getByTestId('field-newproj').fill('学习');
    await page.getByTestId('field-newproj').press('Enter');
    await expect(page.getByTestId('field-project')).toHaveText('学习');
    await expect(page.getByTestId('type-bar'), '回车只交分类，不提交').toBeVisible();

    // 日期：明天 + 其他时刻（占位格子，没有系统框）
    await date.click();
    await expect(page.getByTestId('tray-date')).toBeVisible();
    await expect(page.locator('[data-testid="type-bar"] input[type="date"], [data-testid="type-bar"] input[type="time"]')).toHaveCount(0);
    await page.getByTestId('tray-date').getByRole('button', { name: '明天', exact: true }).click();
    await page.getByTestId('field-othertime').click();
    await page.getByTestId('pick-time').getByRole('button', { name: '20:30', exact: true }).click();
    await expect(date).toContainText('明天 20:30');
    await expect(date).not.toHaveClass(/auto/);
    await expect(page.getByTestId('field-remind'), '选了时刻，提醒默认亮').toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('tray-date')).toContainText('待办没有“一段时间”');
    // 展开区不把打字条顶出屏幕
    const box = await page.getByTestId('type-bar').boundingBox();
    expect(box && box.y >= 0, '打字条顶边还在屏幕里').toBe(true);

    // 提醒：点掉
    await page.getByTestId('field-remind').click();
    await expect(page.getByTestId('field-remind')).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: '记下' }).click();
    await expect(page.getByTestId('type-notice')).toContainText('交周报');
    await expect.poll(() => rowOf(page, 'todos', '交周报')).toMatchObject({ project: '学习', due_time: '20:30', remind_before_min: null, remind_days: null });
  });

  test('日历页：日期签默认是选中的那天；日程改全天跨 3 天、点亮提醒，记下写进 events', async ({ page }) => {
    await page.goto('/app/#/calendar');
    await page.getByTestId('tabbar-add').click();
    const input = page.getByTestId('type-input');
    const date = page.getByTestId('field-date');
    // 没说日子：签上写选中的那天，不上色（记下照旧记到那天，R-353）
    await input.fill('去釜山出差');
    await expect(date).not.toHaveText('日期');
    await expect(date).not.toHaveClass(/auto|on/);
    // 说了时刻是日程（本机规则：没时刻的是待办，R6）：才有时长、全天跨天
    await input.fill('后天下午3点去釜山出差');
    await date.click();
    const tray = page.getByTestId('tray-date');
    await expect(tray.getByRole('button', { name: '1 小时', exact: true })).toBeVisible();
    await tray.getByRole('button', { name: '全天', exact: true }).click();
    await tray.getByRole('button', { name: '共 3 天', exact: true }).click();
    await expect(date).toContainText('起 3 天');
    await page.getByTestId('field-project').click();
    await page.getByTestId('tray-project').getByRole('button', { name: '不分类', exact: true }).click();
    await expect(page.getByTestId('field-remind'), '全天默认不提醒').toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('field-remind').click();
    await expect(page.getByTestId('field-remind')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '记下' }).click();
    await expect(page.getByTestId('type-notice')).toContainText('去釜山出差');
    await expect.poll(() => rowOf(page, 'events', '去釜山出差')).toMatchObject({ time: null, duration_min: 3 * 1440, remind_min: null, remind_days: 0, project: '' });
  });
});
