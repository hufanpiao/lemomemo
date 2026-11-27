// 周视图全部直接显示（负责人 11-18“这个+2的全天内容在下面都列出来，周历目的就是将全部日程都能一眼看清楚”“+2的日程跟代办也都显示出来”）：
// 一周灌满（同一时段三件日程、一天三件全天日程、有时刻和没时刻的待办），量：每一件都画出来、没有“+N”，同一泳道里的条互不重叠，
// 标题写全（没被省略号截断：WebKit 没有 OffscreenCanvas 时也要量到字宽），排多的泳道比空泳道高。chromium、webkit 都跑；设了 LEMO_SHOT_DIR 才截图
import { cached, idbPut } from './idb.ts';
import { shot } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };
const EV = [
  ['e1', '客户周会', 'NEOX', '2026-11-02', '10:00', 60],
  ['e2', '设计评审', '柠檬记', '2026-11-02', '10:30', 90],
  ['e3', '牙医', '家', '2026-11-02', '10:45', 45],
  ['a1', '出差深圳', 'NEOX', '2026-11-04', null, 3 * 1440],
  ['a2', '妈妈生日', '家', '2026-11-04', null, 1440],
  ['a3', '团建', 'NEOX', '2026-11-04', null, 1440],
  ['e5', '和小王吃饭', '', '2026-11-04', '19:00', 90],
].map(([id, title, project, date, time, dur]) => ({ ...base, id, title, project, date, time, duration_min: dur }));
const TD = [
  ['t1', '交季度报告', 'NEOX', '2026-11-02', '16:00'],
  ['t2', '买菜', '家', '2026-11-02', null],
  ['t3', '回邮件', '', '2026-11-02', null],
  ['t4', '续签合同', 'NEOX', '2026-11-02', null],
].map(([id, title, project, due, due_time]) => ({ ...base, id, title, project, due, due_time, done: false }));

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: TZ, locale: 'zh-CN' });

test('周视图：全天日程、同时段日程、待办全部画出来，不重叠、标题写全，泳道随排数变高', async ({ page }, info) => {
  await page.goto('/app/#/cal/week/2026-11-02');
  await page.getByTestId('calendar-page').waitFor({ timeout: 30000 });
  await idbPut(page, [...EV.map((r) => ['events', cached(r)] as const), ...TD.map((r) => ['todos', cached(r)] as const)]);
  await page.reload();
  await expect(page.getByTestId('cal-week')).toBeVisible();
  // 量到轨道宽度、字宽以后才按完整标题排
  await expect(page.locator('[data-date="2026-11-02"] [data-todo]')).toHaveCount(4);
  const m = await page.evaluate(() => {
    const lane = (d: string) => document.querySelector<HTMLElement>(`[data-testid="cal-week"] li[data-date="${d}"]`);
    const boxes = (d: string) =>
      [...(lane(d)?.querySelectorAll<HTMLElement>('[data-item], [data-todo]') ?? [])].map((el) => {
        const r = el.getBoundingClientRect();
        const tx = el.querySelector<HTMLElement>('span');
        return { id: el.dataset['item'] ?? el.dataset['todo'] ?? '', l: r.left, r: r.right, t: r.top, b: r.bottom, cut: tx ? tx.scrollWidth > tx.clientWidth + 1 : false };
      });
    const overlaps = (bs: ReturnType<typeof boxes>) =>
      bs.flatMap((a, i) => bs.slice(i + 1).filter((b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5).map((b) => `${a.id}×${b.id}`));
    const mon = boxes('2026-11-02');
    const wed = boxes('2026-11-04');
    return {
      mon: mon.map((x) => x.id).sort(),
      wed: wed.map((x) => x.id).sort(),
      overlap: [...overlaps(mon), ...overlaps(wed)],
      cut: [...mon, ...wed].filter((x) => x.cut).map((x) => x.id),
      plus: document.querySelector('[data-testid="cal-week"]')?.textContent?.match(/\+\d/) ?? null,
      hMon: lane('2026-11-02')?.getBoundingClientRect().height ?? 0,
      hSun: lane('2026-11-08')?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(m.mon).toEqual(['e1', 'e2', 'e3', 't1', 't2', 't3', 't4']);
  expect(m.wed).toEqual(['a1', 'a2', 'a3', 'e5']);
  expect(m.overlap).toEqual([]);
  expect(m.cut).toEqual([]);
  expect(m.plus).toBeNull();
  expect(m.hMon).toBeGreaterThan(m.hSun + 10);
  const dir = process.env['LEMO_SHOT_DIR'];
  if (dir) await page.getByTestId('cal-week').screenshot({ path: `${dir}/week-all-${info.project.name}.png` });
});

// 勾完成的待办留在周历上、只划删除线（负责人 11-21“勾选完成的待办在周历不消失，只划删除线，要留痕”）；没完成的不划
test('周视图：已完成的待办留着、划删除线', async ({ page, browserName }) => {
  await page.goto('/app/#/cal/week/2026-11-02');
  await page.getByTestId('calendar-page').waitFor({ timeout: 30000 });
  const done = { ...base, id: 'd1', title: '确认热处理', project: '奥锐', due: '2026-11-03', due_time: null, done: true, done_at: 2 };
  const open = { ...base, id: 'd2', title: '买菜', project: '家', due: '2026-11-03', due_time: null, done: false };
  await idbPut(page, [done, open].map((r) => ['todos', cached(r)] as const));
  await page.reload();
  const lane = page.locator('[data-testid="cal-week"] li[data-date="2026-11-03"]');
  await expect(lane.locator('[data-todo]')).toHaveCount(2);
  const deco = (id: string) => lane.locator(`[data-todo="${id}"] span`).first().evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(await deco('d1')).toContain('line-through');
  expect(await deco('d2')).not.toContain('line-through');
  await shot(page, browserName, 'week-done');
});
