// 待办行结构（R-434）和待办页精致化（R-436）：不要后端，往本机库 planner-v4 写好待办再重新载入
// • 标题前优先级彩点、行右边 H / M / L：点哪一格就设成哪一档（主持人 11-17 评审），键盘按下去照旧换下一档，写进 outbox，重新载入还是新的那一档；老行只有 important=true 的按“高”
// • 逾期的行副行“! 过期 11/13 14:00 · 项目”（日期、时刻等宽数字）；标题下面一行“月日 周几 · 完成 / 总数 完成”
// • 今天页的待办行同一套 H / M / L
// • 负责人 11-17 选 T-A：行尾 H / M / L 三格并排、当前档那一格亮起（推翻 R-434 第 6 条单格），所以这里断言亮起那一格（[data-on]）的字母
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, priority: 'mid', rev: 1 };

/** 三格里亮起的那一格（T-A） */
const lit = (box: ReturnType<Page['getByTestId']>) => box.locator('[data-on]');
const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

/** 浏览器里的“今天”（按 Asia/Seoul），逾期那条用前天 */
const dayOf = (page: Page, offset: number) =>
  page.evaluate(([tz, off]) => {
    const d = new Date(Date.now() + (off as number) * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz as string, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }, [TZ, offset] as const);

async function seed(page: Page, to: string): Promise<{ late: string }> {
  await page.goto(to);
  await page.waitForLoadState('domcontentloaded');
  const today = await dayOf(page, 0);
  const late = await dayOf(page, -2);
  await idbPut(page, [
    { ...base, id: 'p1', title: '交报销单', due: late, due_time: '14:00', project: '工作' },
    { ...base, id: 'p2', title: '准备提纲', due: today, priority: 'high', important: true },
    // 老行：本机缓存里还没有 priority 这一列，important = true → 按“高”
    { ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'priority')), id: 'p3', title: '老的重要待办', due: today, important: true },
    { ...base, id: 'p4', title: '给猫买猫砂', done: true, done_at: 5 },
    // 没过期的中档：换档用它（负责人 11-21“过期的项目不显示HML，只有推迟”，p1 过期只出推迟）
    { ...base, id: 'p5', title: '取快递', due: today },
  ].map((r) => ['todos', cached(r)] as const));
  await page.reload();
  return { late };
}

test.describe('待办优先级和行结构（R-434、R-436）', () => {
  test('待办页：彩点、H / M / L 换档进 outbox、重新载入还在；逾期副行、标题下日期一行', async ({ page }) => {
    const { late } = await seed(page, '/app/#/todos');
    await page.getByTestId('todos-row-p1').waitFor({ timeout: 30000 });
    await expect(lit(page.getByTestId('todos-prio-p2'))).toHaveText('H');
    await expect(lit(page.getByTestId('todos-prio-p3'))).toHaveText('H');
    // 过期的 p1 只出“推迟”、不出 H / M / L（负责人 11-21）
    await expect(page.getByTestId('todos-prio-p1')).toHaveCount(0);
    await expect(page.getByTestId('todos-later-p1')).toBeVisible();
    const p5 = page.getByTestId('todos-prio-p5');
    await expect(lit(p5)).toHaveText('M');
    await expect(p5).toHaveAccessibleName('优先级：中，按一下换成低');
    // 逾期副行
    const md = `${Number(late.slice(5, 7))}/${Number(late.slice(8, 10))}`;
    await expect(page.getByTestId('todos-tag-p1')).toHaveText(`! 过期 ${md} 14:00 · 工作`);
    await expect(page.getByTestId('todos-sub')).toContainText('· 1 / 5 完成');
    // “全部”胶囊只数没做完的（负责人 11-22“划掉了3个标签还显示4”，选“只数没完成的”）：5 条里完成 1 条，剩 4
    await expect(page.getByTestId('todos-filter-all')).toHaveText(/^全部\s*4$/);
    // 点在哪一格就设成哪一档（主持人 11-17 评审）：点“L”那一格，中 → 低
    await p5.locator('[data-p="low"]').click();
    await expect(lit(p5)).toHaveText('L');
    await expect.poll(() => outboxOf(page)).toContain('todos:p5:patch');
    await page.reload();
    await expect(lit(page.getByTestId('todos-prio-p5'))).toHaveText('L', { timeout: 30000 });
    // 点“H”那一格：低 → 高（不是轮换的下一档，跳过中）
    await page.getByTestId('todos-prio-p5').locator('[data-p="high"]').click();
    await expect(lit(page.getByTestId('todos-prio-p5'))).toHaveText('H');
    // 键盘按下去没有落点：照旧换下一档，高 → 中
    await page.getByTestId('todos-prio-p5').focus();
    await page.keyboard.press('Enter');
    await expect(lit(page.getByTestId('todos-prio-p5'))).toHaveText('M');
  });

  test('今天页：今天截止的待办行右边同一套 H / M / L', async ({ page }) => {
    await seed(page, '/app/#/today');
    const box = page.getByTestId('today-prio-p2');
    await expect(lit(box)).toHaveText('H', { timeout: 30000 });
    // 点“M”那一格
    await box.locator('[data-p="mid"]').click();
    // 今天页的写入在按需下载的 core/todo-priority.ts，点了才下：两种浏览器一起跑时这一包可能排队几秒（11-15 trace：请求还没回）
    await expect(lit(box)).toHaveText('M', { timeout: 15000 });
    await expect.poll(() => outboxOf(page)).toContain('todos:p2:patch');
  });
});
