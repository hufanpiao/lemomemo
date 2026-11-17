// R-457 月历收起、展开时日清单里各块同一帧一起走（负责人 preview.383 真机：“收缩放大下面的待办跟不上节奏”）。chromium、webkit 都跑（430×932）
// • 逐帧断言：收起、展开途中每一帧量“待办组（cal-todos）上沿 − 第一条日程行上沿”，和起手时比，任何一帧都不许差出 1 px
// • 运行日志：停稳时那一行“cal fold open→folded via=tap ms= todo_drift= todo_tf=”里，todo_drift 是 0、todo_tf 是 0/帧数
//   （todo_tf 数的是待办组自己身上带 transform 的帧：Motion 的 layout 动画补位置时会写它）
import type { Page } from '@playwright/test';
import { runLog } from './fake-media.ts';
import { cached, idbPut } from './idb.ts';
import { afterPageFade } from './page-helpers.ts';
import { expect, FAKE_USER_ID, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

logOnFail(test);

const TZ = 'Asia/Seoul';
const DAY = '2026-11-12';
const base = { user_id: FAKE_USER_ID, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, tz: TZ };
const id = (n: number) => `0e2e0000-0000-4000-8000-0000004570${String(n).padStart(2, '0')}`;

test.use({ trace: 'off', loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: TZ, locale: 'zh-CN' });

async function open(page: Page): Promise<void> {
  await page.goto('/app/#/cal/month/2026-11');
  await page.getByTestId('calendar-page').waitFor({ timeout: 30_000 });
  await idbPut(page, [
    ['events', cached({ ...base, id: id(1), title: '客户周会', project: 'NEOX', date: DAY, time: '10:00', duration_min: 60 })],
    ['events', cached({ ...base, id: id(2), title: '设计评审', project: '柠檬记', date: DAY, time: '14:00', duration_min: 90 })],
    ...[3, 4, 5].map((n) => ['todos', cached({ ...base, id: id(n), title: `待办 ${n}`, project: '', due: DAY, due_time: null, done: false })] as const),
  ]);
  await page.reload();
  await page.getByTestId('cal-month').waitFor({ timeout: 30_000 });
  await afterPageFade(page);
  await page.locator(`[data-testid="cal-month"] [data-date="${DAY}"]`).click();
  await expect(page.getByTestId('cal-todos')).toBeVisible();
  // 列表动画实现（motion）首屏画完以后才下载换上：等它到了再量，真机上用户点的时候早就换上了
  await page.waitForTimeout(1500);
}

/** 点一下拖动柄，动画途中每一帧（这一帧的 rAF 都跑完以后）量待办组相对第一条日程行的位置，返回和起手时相比的最大偏差（px）、
 *  待办组身上带 transform 的帧数、帧数 */
async function tapAndSample(page: Page): Promise<{ drift: number; tf: number; frames: number }> {
  return page.evaluate(
    () =>
      new Promise<{ drift: number; tf: number; frames: number }>((done) => {
        const todos = document.querySelector<HTMLElement>('[data-testid="cal-todos"]');
        const row = document.querySelector<HTMLElement>('[data-testid="cal-day-list"] li');
        const handle = document.querySelector<HTMLElement>('[data-testid="cal-fold"]');
        if (!todos || !row || !handle) return done({ drift: 999, tf: 0, frames: 0 });
        const off = (): number => todos.getBoundingClientRect().top - row.getBoundingClientRect().top;
        const base = off();
        let drift = 0;
        let tf = 0;
        let frames = 0;
        let still = 0;
        let last = row.getBoundingClientRect().top;
        const sample = (): void => {
          drift = Math.max(drift, Math.abs(off() - base));
          if (todos.style.transform !== '' && todos.style.transform !== 'none') tf += 1;
          frames += 1;
          const y = row.getBoundingClientRect().top;
          still = Math.abs(y - last) < 0.01 ? still + 1 : 0;
          last = y;
          // 日程行停下 20 帧以后再多看一会儿（待办组晚到的话这时还在动）
          if (still > 20 && frames > 30) done({ drift, tf, frames });
          else requestAnimationFrame(() => setTimeout(sample, 0));
        };
        handle.click();
        requestAnimationFrame(() => setTimeout(sample, 0));
      }),
  );
}

test('R-457 收起、展开：待办组和日程行同一帧一起走（逐帧），运行日志 todo_drift=0', async ({ page }) => {
  await open(page);
  const fold = await tapAndSample(page);
  await expect(page.getByTestId('cal-fold')).toHaveAttribute('aria-expanded', 'false');
  const unfold = await tapAndSample(page);
  await expect(page.getByTestId('cal-fold')).toHaveAttribute('aria-expanded', 'true');
  // 运行日志隔一会儿才落到 localStorage：等两行都到了再读
  await expect.poll(async () => (await runLog(page)).filter((l) => l.includes('cal fold ')).length).toBeGreaterThanOrEqual(2);
  const lines = (await runLog(page)).filter((l) => l.includes('cal fold '));
  console.log(JSON.stringify({ fold, unfold, lines }));
  expect(fold.frames, '收起途中量到了帧').toBeGreaterThan(10);
  expect(fold.drift, '收起：待办组每一帧都跟日程行一起走').toBeLessThanOrEqual(1);
  expect(unfold.drift, '展开：待办组每一帧都跟日程行一起走').toBeLessThanOrEqual(1);
  expect([fold.tf, unfold.tf], '待办组自己身上从来没有补位置的 transform（Motion layout 没被触发）').toEqual([0, 0]);
  expect(lines.some((l) => /cal fold open→folded via=tap ms=\d+ todo_drift=[01] todo_tf=0\/\d+/.test(l)), lines.join('\n')).toBe(true);
  expect(lines.some((l) => /cal fold folded→open via=tap ms=\d+ todo_drift=[01] todo_tf=0\/\d+/.test(l)), lines.join('\n')).toBe(true);
});

test('R-457 按住拖动柄往上拖、松手：拖的每一步待办组都和日程行同步，日志 via=drag', async ({ page }) => {
  await open(page);
  const off = () =>
    page.evaluate(() => {
      const todos = document.querySelector<HTMLElement>('[data-testid="cal-todos"]');
      const row = document.querySelector<HTMLElement>('[data-testid="cal-day-list"] li');
      return todos && row ? { d: todos.getBoundingClientRect().top - row.getBoundingClientRect().top, tf: todos.style.transform, y: row.getBoundingClientRect().top } : null;
    });
  const base = await off();
  const box = await page.getByTestId('cal-fold').boundingBox();
  if (!base || !box) throw new Error('没找到拖动柄或日清单');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const seen: { d: number; tf: string; y: number }[] = [];
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(x, y - i * 25);
    const o = await off();
    if (o) seen.push(o);
  }
  await page.mouse.up();
  await expect(page.getByTestId('cal-fold')).toHaveAttribute('aria-expanded', 'false');
  expect(seen.at(-1)?.y ?? 0, '日清单真的跟着手指上来了').toBeLessThan(base.y - 100);
  expect(seen.map((o) => Math.round(Math.abs(o.d - base.d)))).toEqual(seen.map(() => 0));
  expect(seen.filter((o) => o.tf !== '' && o.tf !== 'none')).toEqual([]);
  await expect.poll(async () => (await runLog(page)).some((l) => /cal fold open→folded via=drag ms=\d+ todo_drift=[01] todo_tf=0\/\d+/.test(l))).toBe(true);
});
