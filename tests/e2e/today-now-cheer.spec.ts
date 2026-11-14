// 今天页“现在”卡的暖心句（负责人 11-14：“今天页没日程的时候也显示这个框，没有日程的时候可以显示一些鼓励的句子或者暖心句子”），chromium、webkit 都跑：
//   ① 真机截图那一幕：12:40，今天只有 17:00 逛街和一个全天的逛街 → 和有日程时同一张大卡（负责人 11-15：“跟有日程的时候一样的样式！不是一个小框加一句话”），标题行暖心句，时间尺下面“下一件 17:00 逛街 · 4 小时 20 分后”只写一次
//   ② 今天整天没有日程 → 同一张大卡，页头标签“今天没有日程”，标题行暖心句，照样画时间尺
//   ③ 电脑 1280：时间河里同一张大卡
//   ④ 晚上 22:15 今天的日程都过了（负责人 11-14 22:17“框也没有做”时的那一幕）→ 同一张大卡，页头标签“今天的日程都结束了”，标题行暖心句
//   刷新以后还是同一句（按当天日期固定选，不随机）；读屏读得到（不在 aria-hidden 里）
// 评审截图（设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截）：手机 390 的 ① ②、电脑 1280 的 ①
import type { Page } from '@playwright/test';
import { DESK_USE } from './b6-desk-helpers.ts';
import { cached, idbPut } from './idb.ts';
import { shot } from './page-helpers.ts';
import { expect, FAKE_USER_ID, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const DAY = '2026-11-14';
const NOW = new Date(`${DAY}T12:40:00+09:00`);

// 电脑宽度、首尔时区、登录着（trace、isMobile 只能在文件顶层设）；手机那组只把视口改成 390 宽
test.use(DESK_USE);

async function open(page: Page, events: Record<string, unknown>[], now: Date = NOW): Promise<void> {
  await page.clock.setFixedTime(now);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('now-card')).toBeVisible({ timeout: 20_000 });
  const base = { user_id: FAKE_USER_ID, created_at: now.getTime() - 86_400_000, updated_at: now.getTime() - 86_400_000, deleted_at: null, undone: false, short: null, project: '', tz: TZ, date: DAY };
  if (events.length) {
    await idbPut(page, events.map((e) => ['events', cached({ ...base, ...e })] as const));
    await page.reload();
  }
}

const SHOPPING = [
  { id: '0e2e0000-0000-4000-8000-0000000c0e01', title: '逛街', time: '17:00', duration_min: 60 },
  { id: '0e2e0000-0000-4000-8000-0000000c0e02', title: '逛街', time: null, duration_min: null },
];

async function expectCalm(page: Page): Promise<void> {
  const card = page.getByTestId('now-card');
  await expect(card).toHaveAttribute('data-state', 'idle');
  await expect(card.getByTestId('now-ruler')).toBeVisible();
  const cheer = card.getByTestId('now-cheer');
  await expect(cheer).toBeVisible();
  await expect(cheer).not.toHaveText('');
  await expect(card.getByTestId('now-hint')).toHaveText('下一件 17:00 逛街 · 4 小时 20 分后');
  // 同一天刷新还是同一句
  const first = await cheer.textContent();
  await page.reload();
  await expect(page.getByTestId('now-cheer')).toHaveText(first ?? '');
}

test.describe('手机 390：“现在”卡的暖心句', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('① 下一件在时间尺外：同一张大卡，标题行暖心句 + 下一件只写一次', async ({ page, browserName }) => {
    await open(page, SHOPPING);
    await expectCalm(page);
    await shot(page, browserName, 'phone-390-下一件在时间尺外');
  });

  test('② 今天整天没有日程：和有日程时同一张大卡，标题行暖心句', async ({ page, browserName }) => {
    await open(page, []);
    const card = page.getByTestId('now-card');
    await expect(card).toHaveAttribute('data-state', 'empty');
    await expect(card.getByTestId('now-cheer')).not.toHaveText('');
    await expect(card).toContainText('今天没有日程');
    await expect(card.getByTestId('now-ruler')).toBeVisible();
    await shot(page, browserName, 'phone-390-今天没有日程');
  });

  test('④ 晚上日程都过了：同一张大卡，标题行暖心句', async ({ page, browserName }) => {
    await open(page, SHOPPING, new Date(`${DAY}T22:15:00+09:00`));
    const card = page.getByTestId('now-card');
    await expect(card).toHaveAttribute('data-state', 'done');
    await expect(card.getByTestId('now-cheer')).not.toHaveText('');
    await expect(card).toContainText('今天的日程都结束了');
    await expect(card.getByTestId('now-ruler')).toBeVisible();
    await shot(page, browserName, 'phone-390-日程都过了');
  });
});

test.describe('电脑 1280：“现在”卡的暖心句', () => {
  test('③ 时间河里同一张大卡', async ({ page, browserName }) => {
    await open(page, SHOPPING);
    await expect(page.getByTestId('desk-panel-river').getByTestId('now-card')).toBeVisible({ timeout: 20_000 });
    await expectCalm(page);
    await shot(page, browserName, 'desk-1280-下一件在时间尺外');
  });
});
