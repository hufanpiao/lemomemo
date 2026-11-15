// 待办行结构（R-434）和待办页精致化（R-436）：不要后端，往本机库 planner-v4 写好待办再重新载入
// • 标题前优先级彩点、行右边 H / M / L：点一下换下一档（中 → 低 → 高），写进 outbox，重新载入还是新的那一档；老行只有 important=true 的按“高”
// • 逾期的行副行“! 过期 11/13 14:00 · 项目”（日期、时刻等宽数字）；标题下面一行“月日 周几 · 完成 / 总数 完成”
// • 今天页的待办行同一套 H / M / L
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, priority: 'mid', rev: 1 };

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
  ].map((r) => ['todos', cached(r)] as const));
  await page.reload();
  return { late };
}

test.describe('待办优先级和行结构（R-434、R-436）', () => {
  test('待办页：彩点、H / M / L 换档进 outbox、重新载入还在；逾期副行、标题下日期一行', async ({ page }) => {
    const { late } = await seed(page, '/app/#/todos');
    await page.getByTestId('todos-row-p1').waitFor({ timeout: 30000 });
    await expect(page.getByTestId('todos-prio-p2')).toHaveText('H');
    await expect(page.getByTestId('todos-prio-p3')).toHaveText('H');
    const p1 = page.getByTestId('todos-prio-p1');
    await expect(p1).toHaveText('M');
    await expect(p1).toHaveAccessibleName('优先级：中，点一下换成低');
    // 逾期副行
    const md = `${Number(late.slice(5, 7))}/${Number(late.slice(8, 10))}`;
    await expect(page.getByTestId('todos-tag-p1')).toHaveText(`! 过期 ${md} 14:00 · 工作`);
    await expect(page.getByTestId('todos-sub')).toContainText('· 1 / 4 完成');
    // “全部”胶囊和标题下一行同一个口径：含已完成（确认图“全部 10”“1 / 10 完成”）
    await expect(page.getByTestId('todos-filter-all')).toHaveText(/^全部\s*4$/);
    // 点一下：中 → 低
    await p1.click();
    await expect(p1).toHaveText('L');
    await expect.poll(() => outboxOf(page)).toContain('todos:p1:patch');
    await page.reload();
    await expect(page.getByTestId('todos-prio-p1')).toHaveText('L', { timeout: 30000 });
    // 再点一下：低 → 高
    await page.getByTestId('todos-prio-p1').click();
    await expect(page.getByTestId('todos-prio-p1')).toHaveText('H');
  });

  test('今天页：今天截止的待办行右边同一套 H / M / L', async ({ page }) => {
    await seed(page, '/app/#/today');
    const box = page.getByTestId('today-prio-p2');
    await expect(box).toHaveText('H', { timeout: 30000 });
    await box.click();
    // 今天页的写入在按需下载的 core/todo-priority.ts，点了才下：两种浏览器一起跑时这一包可能排队几秒（11-15 trace：请求还没回）
    await expect(box).toHaveText('M', { timeout: 15000 });
    await expect.poll(() => outboxOf(page)).toContain('todos:p2:patch');
  });
});
