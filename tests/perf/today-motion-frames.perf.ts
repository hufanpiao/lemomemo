// 今天页动效逐帧截图（前端-15 改重画方式前后对照用：改前跑一遍、改后跑一遍，两边逐帧逐像素比，必须一样）。chromium、webkit 都跑。
// 场景（手机宽度 430×932、DPR 3，钟定在 2026-11-12 首尔 10:00，2 条日程 + 5 条待办，第 1 条待办带 3 项子任务）：
//   ① done：勾第 3 条待办 → 方框回弹、划线、停留、收起、下面的行收上来、页底升起“已完成 · 撤销”
//   ② undo：点“撤销” → 那一行回到原位、下面的行让开
//   ③ past：再勾一条、等它收进“已过去”，点“已过去”展开 → 过去的那几行淡入、下面的行让开
//   ④ subs：点第 1 条待办的“展开”子任务 → 卡片展开、下面的行挪位，再点“收起”
// 每个场景从点下去一直截到画面完全停住后再 1 秒（负责人规则：对照图从按下截到停住以后至少多 1 秒）。
// 时间怎么定死：page.clock 装假钟（定时器、rAF、performance.now 都归它；Motion 的帧循环和弹簧跟着走），点之前 pauseAt 停住，
// 之后每格 runFor(16ms)；CSS 动画、过渡和 Motion 交给 WAAPI 的那些不走假钟，每格把页面上所有动画停住、拨到“第一次看到它以后过了多少假时间”
// （到头的 finish()，让 Motion 收到播完），再截图。截图按场景、浏览器存进 FRAMES_DIR/<标签>/<浏览器>/<场景>/0000.png（FRAMES_DIR 必填，标签 FRAMES_TAG，默认 run）
// 比对：tests/perf/compare-frames.mjs <改前目录> <改后目录>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { cached, idbPut } from '../e2e/idb.ts';
import { FAKE_USER_ID, test } from '../e2e/session-fixture.ts';

const TZ = 'Asia/Seoul';
const NOW = new Date('2026-11-12T10:00:00+09:00');
const DAY = '2026-11-12';
const DIR = process.env['FRAMES_DIR'];
const TAG = process.env['FRAMES_TAG'] ?? 'run';
const STEP = 16;
test.use({ loggedIn: true, timezoneId: TZ, locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
test.skip(!DIR, '要设 FRAMES_DIR');

const T = (i: number) => `0e2e0000-0000-4000-8000-0000000f0d0${i}`;
const E = (i: number) => `0e2e0000-0000-4000-8000-0000000f0e0${i}`;

async function seed(page: Page): Promise<void> {
  const at = NOW.getTime() - 86_400_000;
  const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: at, updated_at: at, deleted_at: null, undone: false, short: null, rev: 1 };
  const td = (i: number, title: string, priority: string) => ({ ...base, id: T(i), title, project: i % 2 ? '工作' : '', due: DAY, due_time: null, done: false, important: false, priority });
  const ev = (i: number, title: string, time: string) => ({ ...base, id: E(i), title, project: 'NEOX', date: DAY, time, duration_min: 30 });
  const it = (k: number, title: string, done: boolean) => ({ ...base, id: `0e2e0000-0000-4000-8000-0000000f0a0${k}`, todo_id: T(1), title, sort: k, done });
  await idbPut(page, [
    ...[ev(1, 'NEOX 横版对片', '14:00'), ev(2, 'SignPlex 客户反馈会', '16:30')].map((r) => ['events', cached(r)] as const),
    ...[td(1, '整理旧照片', 'high'), td(2, '回邮件', 'high'), td(3, '买猫砂', 'mid'), td(4, '交 NEOX 片尾', 'mid'), td(5, '订周末的票', 'low')].map((r) => ['todos', cached(r)] as const),
    ...[it(1, '挑出要冲印的', true), it(2, '备份到硬盘', false), it(3, '删掉重复的', false)].map((r) => ['todo_items', cached(r)] as const),
  ]);
}

/** 停住页面上所有动画，拨到第一次看到以后过了 fake 毫秒假时间；到头的 finish() */
async function seekAll(page: Page, fake: number): Promise<void> {
  await page.evaluate((now) => {
    const w = window as unknown as { __seen?: WeakMap<Animation, number> };
    const seen = (w.__seen ??= new WeakMap());
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) seen.set(a, now);
      const t = now - (seen.get(a) ?? now);
      const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
      if (Number.isFinite(end) && t >= end) {
        if (a.playState !== 'finished') a.finish();
      } else {
        a.pause();
        a.currentTime = t;
      }
    }
  }, fake);
}

/** 从现在起按 STEP 一格一格往前拨 ms 假时间，每格截一张；每格之间让真异步（IndexedDB 写入、Promise）走完 */
async function film(page: Page, name: string, ms: number, browser: string): Promise<void> {
  const dir = join(DIR ?? '', TAG, browser, name);
  mkdirSync(dir, { recursive: true });
  let fake = 0;
  for (let i = 0; fake <= ms; i++, fake += STEP) {
    if (i > 0) await page.clock.runFor(STEP);
    await page.waitForTimeout(20);
    await seekAll(page, fake);
    await page.screenshot({ path: join(dir, `${String(i).padStart(4, '0')}.png`), animations: 'allow', caret: 'hide' });
  }
}

/** 动作前：让画面完全停住（假钟往前走 2 秒，动画全部到头），再从这一刻开始拍 */
async function settle(page: Page): Promise<void> {
  await page.clock.runFor(2000);
  await page.waitForTimeout(200);
  await seekAll(page, 1e9);
  await page.evaluate(() => ((window as unknown as { __seen?: unknown }).__seen = undefined));
}

test('今天页动效逐帧：勾完成、撤销、展开已过去、子任务展开', async ({ page, browserName }) => {
  // 五段一共 500 多张 1290×2796 的截图，webkit 在机器忙时 5 分钟拍不完
  test.setTimeout(1_200_000);
  await page.clock.install({ time: NOW });
  await page.goto('/app/#/today');
  await page.getByTestId('today').waitFor({ timeout: 30_000 });
  await seed(page);
  await page.reload();
  await page.getByTestId(`today-done-${T(5)}`).waitFor({ timeout: 30_000 });
  // 首屏画完才下载的几包（动画实现、左滑、子任务卡片、未同步小标记）都换上，面板停稳
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await page.getByTestId(`today-subs-${T(1)}`).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
  await settle(page);

  // ① 勾第 3 条：停留约 720ms、收起 100ms，再到撤销条升起放完，再多 1 秒
  await page.getByTestId(`today-done-${T(3)}`).click();
  await film(page, 'done', 2600, browserName);
  // ② 撤销
  await page.getByTestId('today-done-toast').getByRole('button').first().click();
  await film(page, 'undo', 1600, browserName);
  await settle(page);
  // ③ 勾第 5 条、等它收进“已过去”，展开“已过去”
  await page.getByTestId(`today-done-${T(5)}`).click();
  await page.clock.runFor(3000);
  await page.waitForTimeout(200);
  await settle(page);
  await page.getByTestId('today-past').click();
  await film(page, 'past', 1500, browserName);
  await settle(page);
  // ④ 子任务卡片展开、收起
  await page.getByTestId(`today-fold-${T(1)}`).click();
  await film(page, 'subs-open', 1300, browserName);
  await settle(page);
  await page.getByTestId(`today-fold-${T(1)}`).click();
  await film(page, 'subs-close', 1300, browserName);
});
