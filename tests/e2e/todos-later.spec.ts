// 过期没做完的行尾“推迟”（负责人 11-21“没赶上的加一个推迟按钮，按一下把时间推迟到明天”）：不要后端，往本机库 planner-v4 写好待办再重新载入
// • 待办页过期组、今天页“没赶上”的行尾有“推迟”（读屏“推迟到明天：标题”），点击区不小于 44；没过期的行没有
// • 按一下：截止日改成明天（按 Asia/Seoul）、截止时刻不变，写进 outbox；行不再过期、按钮消失；页底“已推迟到明天 · 撤销”，撤销回到过期
// • 评审图（设了 LEMO_SHOT_DIR 才截，Chromium，430×932、DPR 3 同真机）：待办页有过期待办的样子，两套皮肤 × 深浅色
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { SHOT_DIR, shot } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, locale: 'zh-CN' });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, priority: 'mid', rev: 1 };

const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

/** 浏览器里按 Asia/Seoul 的某一天 */
const dayOf = (page: Page, offset: number) =>
  page.evaluate(([tz, off]) => {
    const d = new Date(Date.now() + (off as number) * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz as string, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }, [TZ, offset] as const);

async function seed(page: Page, to: string): Promise<{ late: string; tomorrow: string }> {
  await page.goto(to);
  await page.waitForLoadState('domcontentloaded');
  const late = await dayOf(page, -1);
  const tomorrow = await dayOf(page, 1);
  await idbPut(page, [
    { ...base, id: 'l1', title: '测试一下', due: late, due_time: '20:00', remind_before_min: 60, project: '个人' },
    { ...base, id: 'n1', title: '弄清楚待办到底怎么产生', due: tomorrow, project: '个人' },
  ].map((r) => ['todos', cached(r)] as const));
  await page.reload();
  return { late, tomorrow };
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

test.describe('过期待办的“推迟”', () => {
  test('待办页：按一下推到明天 20:00、进 outbox、按钮消失；撤销回到过期', async ({ page, browserName }) => {
    const { late, tomorrow } = await seed(page, '/app/#/todos');
    const btn = page.getByTestId('todos-later-l1');
    await expect(btn).toBeVisible({ timeout: 30000 });
    await expect(btn).toHaveText('推迟');
    await expect(btn).toHaveAccessibleName('推迟到明天：测试一下');
    await expect(page.getByTestId('todos-later-n1')).toHaveCount(0);
    // 点击区（含 ::after 外扩）不小于 44 × 44：中心上下各 21 px 的点还落在这个按钮上，看得见的宽度本身就 ≥ 44
    // 在页面里现找按钮、一个任务量完：locator.evaluate 先拿元素再执行，中间列表换成动画实现会重挂，
    // 量到已卸下的旧按钮（矩形全 0，ci #514 的 up/down 都是 false）
    const hit = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="todos-later-l1"]');
      if (!b) throw new Error('找不到推迟按钮');
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const on = (y: number) => b.contains(document.elementFromPoint(cx, y));
      return { up: on(cy - 21), down: on(cy + 21), w: r.width };
    });
    expect(hit).toEqual({ up: true, down: true, w: expect.any(Number) });
    expect(hit.w).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId('todos-tag-l1')).toContainText(`过期 ${md(late)} 20:00`);
    // 评审图：两套皮肤 × 深浅色（深色跟系统，皮肤直接打在 <html> 上，只为截图）
    if (SHOT_DIR && browserName === 'chromium') {
      for (const theme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        for (const skin of ['glass', 'simple']) {
          await page.evaluate((k) => (document.documentElement.dataset['skin'] = k), skin);
          await shot(page, browserName, `todos-later-${skin}-${theme}`);
        }
      }
    }

    await btn.click();
    // 不进编辑页
    await expect(page).toHaveURL(/#\/todos$/);
    await expect(page.getByTestId('todos-later-toast')).toContainText('已推迟到明天');
    await expect(page.getByTestId('todos-later-l1')).toHaveCount(0);
    await expect(page.getByTestId('todos-g-late')).toHaveCount(0);
    // 挪组时离场那一份还在播，按组找
    await expect(page.getByTestId('todos-g-tomorrow').getByTestId('todos-tag-l1')).toContainText('明天 20:00');
    await expect.poll(() => outboxOf(page)).toContain('todos:l1:patch');
    // 本机库里一行是 { id, server, view }（tests/e2e/idb.ts 的 cached）：改过的在 view
    const row = (await idbRead<{ view: Record<string, unknown> }>(page, 'todos', 'get', 'l1'))?.view;
    expect(row?.['due']).toBe(tomorrow);
    expect(row?.['due_time']).toBe('20:00');
    await shot(page, browserName, 'todos-later-after');

    await page.getByTestId('todos-later-toast-undo').click();
    await expect(page.getByTestId('todos-g-late').getByTestId('todos-later-l1')).toBeVisible();
    await expect(page.getByTestId('todos-g-late').getByTestId('todos-tag-l1')).toContainText(`过期 ${md(late)} 20:00`);
  });

  test('今天页“没赶上”：同一个“推迟”，按了以后离开“没赶上”', async ({ page }) => {
    await seed(page, '/app/#/today');
    const btn = page.getByTestId('today-later-l1');
    await expect(btn).toBeVisible({ timeout: 30000 });
    await expect(btn).toHaveAccessibleName('推迟到明天：测试一下');
    await btn.click();
    await expect(page.getByTestId('today-later-toast')).toContainText('已推迟到明天', { timeout: 15000 });
    await expect(page.getByTestId('today-late')).toHaveCount(0);
    await expect.poll(() => outboxOf(page)).toContain('todos:l1:patch');
  });
});
