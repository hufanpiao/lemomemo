// 纪念日的真浏览器用例（B5 S14、S16；TC-B5 列表、新建、今天页一行、设置里的默认提醒）
// jsdom 测过排序、表单、提醒弹层（src/features/anniv/__tests__），这里用真构建守：农历和推算按需加载（anniv-lib）真的加载得出来、
// 小外壳 AnnivRoot 再懒加载页面、今天页按服务器 next_date 出一行、设置 › 提醒与通知 里“纪念日提醒”一行能点开改。
//   ① 本机库写三条（3 天后的生日、9 天后的纪念日、20 天后的倒数日）：列表按还有几天排，“最近的一个”是 3 天后的生日，筛选“纪念日”只剩一条；
//   ② 今天页顶部出“3 天后 김지민”，点了进纪念日页；
//   ③ “＋ 新建”盖上编辑层，写名字后 Esc 关掉，列表里多了这一条；
//   ④ 设置 › 提醒与通知 的“纪念日提醒”写着出厂默认“提前 7 天、前一天 · 9:00”，点开加上“提前 3 天”，回来那一行跟着变；时刻滚轮点“08”“05”变成 8:05；
//   ⑤ 列表左滑露出“编辑 / 删除”（kit 的 SwipeRow）：删了出撤销条、撤销回来；一次只露一行；竖着拖、滚轮滚动列表都不误触发；
//   ⑥ 新建页头像在名字左边、年月日三列滚轮（视觉稿 annnew）；编辑页日期一行“阳历 …月…日 · 年 ›”，点开出滚轮，滚月份那一列换月（annface）；
//     编辑页名字、日期、提醒、备注同一张卡，“下一次”在卡下面一行、没有“再往后”，没照片不出“去掉”（主持人 11-14 定照稿）
// 纪念日在界面上只能一条条建，先让 App 开好本机库，再往 anniversaries 仓写服务器形状的行、刷新（同 b4-notes-s7s8.spec.ts 的分类）
// 截图：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（WebKit 截图会往页面插 <style>、被 CSP 记成违规）；断言两种浏览器都跑
import type { Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { expect, test } from './session-fixture.ts';

test.use({ trace: 'off', loggedIn: true, viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'];
async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

/** 首尔的今天往后 n 天 → { date, y, m, d } */
function dayAfter(n: number): { date: string; y: number; m: number; d: number } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const date = t.toISOString().slice(0, 10);
  return { date, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const BDAY = dayAfter(3);
const WED = dayAfter(9);
const LAUNCH = dayAfter(20);

/** 往本机库 anniversaries 仓写三行（server、view 同一份服务器行，带服务器算好的 next_date） */
async function seedAnniv(page: Page): Promise<void> {
  const now = Date.now();
  const base = { calendar: 'solar', lunar_variant: 'cn', is_leap: false, after_due: 'archive', remind_offsets: null, remind_time: null, avatar_id: null, note: '',
    remind_at: null, snooze_at: null, notified_for: null, archived_at: null, deleted_at: null, undone: false, rev: 1, created_at: now - 86_400_000, updated_at: now };
  const rows = [
    { ...base, id: '0e2e0000-0000-4000-8000-0000000b5a01', kind: 'birthday', name: '김지민', month: BDAY.m, day: BDAY.d, year: 1997, next_date: BDAY.date },
    { ...base, id: '0e2e0000-0000-4000-8000-0000000b5a02', kind: 'anniversary', name: '结婚纪念日', month: WED.m, day: WED.d, year: 2020, next_date: WED.date },
    { ...base, id: '0e2e0000-0000-4000-8000-0000000b5a03', kind: 'countdown', name: '上线', month: LAUNCH.m, day: LAUNCH.d, year: LAUNCH.y, next_date: LAUNCH.date },
  ];
  await page.evaluate(
    (rs) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onerror = () => reject(new Error(String(req.error)));
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['anniversaries'], 'readwrite');
          for (const r of rs) tx.objectStore('anniversaries').put({ id: r.id, server: r, view: r });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error(String(tx.error)));
        };
      }),
    rows,
  );
}

test.describe('B5 纪念日', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/#/anniv');
    await expect(page.getByTestId('anniv-new')).toBeVisible({ timeout: 30_000 });
    await seedAnniv(page);
    await page.reload();
    await expect(page.getByTestId('anniv-list')).toBeVisible({ timeout: 30_000 });
  });

  test('列表按还有几天排；最近的一个是 3 天后的生日；筛选“纪念日”只剩一条', async ({ page, browserName }) => {
    const rows = page.getByTestId('anniv-list').getByTestId('anniv-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('김지민');
    await expect(rows.nth(1)).toContainText('结婚纪念日');
    await expect(rows.nth(2)).toContainText('上线');
    const near = page.getByTestId('anniv-nearest');
    await expect(near).toContainText('김지민');
    await expect(near).toContainText('3');
    await expect(page.getByTestId('anniv-filter-all')).toHaveText('全部 3');
    // 一行 64px（视觉稿 anniv；kit 列表的 44px 不能盖过它）
    expect((await rows.nth(0).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(64);
    await shot(page, browserName, 'e2e-纪念日列表');
    await page.getByTestId('anniv-filter-anniversary').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText('结婚纪念日');
  });

  test('今天页顶部出“3 天后 김지민”，点了进纪念日页', async ({ page, browserName }) => {
    await page.goto('/app/#/today');
    const line = page.getByTestId('today-anniv');
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(line).toContainText('3 天后');
    await expect(line).toContainText('김지민');
    await shot(page, browserName, 'e2e-今天页纪念日一行');
    // 今天页分包挂上后 FADE_GUARD_MS 以内落在 main 里的点按按设计吞掉（motion/index.ts 的 guardTaps）；这一行要等数据出来才画，晚于页面挂上，
    // 等它出现后再等一个窗口就够（11-14 CI 失败：运行日志 click 无 focusin，即 pointerdown 被拦）
    await page.waitForTimeout(FADE_GUARD_MS);
    await line.click();
    await expect(page).toHaveURL(/#\/anniv\/0e2e0000-0000-4000-8000-0000000b5a01$/);
    await expect(page.getByTestId('anniv-edit-layer')).toBeVisible({ timeout: 30_000 });
    // 关掉回今天页（换页照常起过渡；WebKit 不崩）
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('today-anniv')).toBeVisible({ timeout: 30_000 });
  });

  test('“＋ 新建”盖上编辑层，写名字后 Esc 关掉，列表里多了这一条', async ({ page, browserName }) => {
    await page.getByTestId('anniv-new').click();
    await expect(page.getByTestId('anniv-edit-layer')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('anniv-page')).toHaveAttribute('inert', '');
    const name = page.getByTestId('anniv-edit-name');
    await name.click();
    await name.fill('妈妈');
    await name.press('Tab');
    await expect(page.getByTestId('anniv-edit-next')).toBeVisible();
    await shot(page, browserName, 'e2e-新建纪念日');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('anniv-edit-layer')).toHaveCount(0);
    await expect(page.getByTestId('anniv-row').filter({ hasText: '妈妈' })).toHaveCount(1);
  });

  test('设置里的“纪念日提醒”：出厂默认，点开加“提前 3 天”，回来那一行跟着变', async ({ page, browserName }) => {
    await page.goto('/app/#/settings/remind');
    const open = page.getByTestId('anniv-defaults-open');
    await expect(open).toBeVisible({ timeout: 30_000 });
    const value = page.getByTestId('anniv-defaults-value');
    await expect(value).toHaveText('提前 7 天、前一天 · 9:00');
    await shot(page, browserName, 'e2e-设置纪念日提醒');
    await open.click();
    await expect(page.getByTestId('anniv-rm-off-7')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('anniv-rm-off-3').click();
    await expect(page.getByTestId('anniv-rm-off-3')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, browserName, 'e2e-设置纪念日提醒-弹层');
    await page.getByTestId('anniv-rm-done').click();
    await expect(value).toHaveText('提前 7 天、提前 3 天、前一天 · 9:00');
    // 时刻滚轮（视觉稿 annedit）：左边露出的“08”、右边露出的“05”点了就选上（等上一个弹层淡出完再开）
    await expect(page.getByTestId('anniv-rm-time')).toHaveCount(0);
    await open.click();
    const time = page.getByTestId('anniv-rm-time');
    await expect(time).toHaveAttribute('data-value', '09:00');
    // “08”在时那一列的可见范围里（左半格）：弹层在 <dialog> 里，toBeInViewport 判不准，直接比位置
    const b8 = await stableBox(page.getByTestId('anniv-rm-hour').locator('[data-value="08"]'));
    const hb = await stableBox(page.getByTestId('anniv-rm-hour'));
    expect(Math.abs(b8.x - hb.x)).toBeLessThan(2);
    await shot(page, browserName, 'annedit-提醒时刻滚轮');
    // 按坐标点那一格（真人点按；locator.click 会先把元素滚进视野，滚轮一滚就换了值）
    await page.mouse.click(b8.x + b8.width / 2, b8.y + b8.height / 2);
    await expect(time).toHaveAttribute('data-value', '08:00');
    const b5 = await stableBox(page.getByTestId('anniv-rm-minute').locator('[data-value="05"]'));
    await page.mouse.click(b5.x + b5.width / 2, b5.y + b5.height / 2);
    await expect(time).toHaveAttribute('data-value', '08:05');
    await page.getByTestId('anniv-rm-done').click();
    await expect(value).toHaveText('提前 7 天、提前 3 天、前一天 · 8:05');
  });

  test('左滑露出“编辑 / 删除”：删了出撤销条、撤销回来；一次只露一行', async ({ page, browserName }) => {
    const rows = page.getByTestId('anniv-list').getByTestId('anniv-row');
    await swipeLeft(page, rows.nth(0));
    await expect(rows.nth(0)).toHaveAttribute('data-swipe', 'open');
    await expect(rows.nth(0).getByTestId('anniv-swipe-del')).toBeInViewport();
    await shot(page, browserName, 'anniv-左滑露出编辑删除');
    // 再滑第二行：第一行收起
    await swipeLeft(page, rows.nth(1));
    await expect(rows.nth(1)).toHaveAttribute('data-swipe', 'open');
    await expect(rows.nth(0)).not.toHaveAttribute('data-swipe', 'open');
    await rows.nth(1).getByTestId('anniv-swipe-del').click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('anniv-row').filter({ hasText: '结婚纪念日' })).toHaveCount(0);
    await page.getByTestId('anniv-toast-undo').click();
    await expect(rows).toHaveCount(3);
    // “编辑”进编辑层
    await swipeLeft(page, rows.nth(0));
    await rows.nth(0).getByTestId('anniv-swipe-edit').click();
    await expect(page).toHaveURL(/#\/anniv\/0e2e0000-0000-4000-8000-0000000b5a01$/);
  });

  test('竖着拖、滚轮滚动列表：不误触发左滑', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 390, height: 480 });
    const rows = page.getByTestId('anniv-list').getByTestId('anniv-row');
    const box = await rows.nth(0).boundingBox();
    if (!box) throw new Error('no box');
    // 斜着往下拖（竖向为主）：不起滑
    await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2 + 30, { steps: 4 });
    await page.mouse.move(box.x + box.width - 70, box.y + box.height / 2 + 90, { steps: 4 });
    await expect(rows.nth(0)).not.toHaveAttribute('data-swipe', 'open');
    expect(await rows.nth(0).evaluate((li) => (li.lastElementChild as HTMLElement).style.transform)).toBe('');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    // 滚轮滚列表：页面滚了，行没动
    await page.goto('/app/#/anniv');
    await expect(page.getByTestId('anniv-list')).toBeVisible({ timeout: 30_000 });
    const y0 = await page.evaluate(() => scrollY);
    const b2 = await rows.nth(1).boundingBox();
    if (!b2) throw new Error('no box');
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    // 手机版 WebKit（iPhone 设备）不支持鼠标滚轮：改用触屏不可模拟的滚动，这里由页面滚动代替（只证明滚过以后行没被打开）
    if (browserName === 'webkit') await page.evaluate(() => scrollBy(0, 200));
    else await page.mouse.wheel(0, 200);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y0);
    for (const i of [0, 1, 2]) await expect(rows.nth(i)).not.toHaveAttribute('data-swipe', 'open');
  });

  test('新建页：头像在名字左边、年月日三列滚轮；编辑页日期一行点开出滚轮', async ({ page, browserName }) => {
    await page.getByTestId('anniv-new').click();
    await expect(page.getByTestId('anniv-edit-layer')).toBeVisible({ timeout: 30_000 });
    const pick = page.getByTestId('anniv-avatar-pick');
    const name = page.getByTestId('anniv-edit-name');
    // 头像在名字左边、贴着表单左边、和输入框竖向居中（弹层滑上来途中量不准：等两者对齐）
    await expect
      .poll(async () => {
        const pb = await pick.boundingBox();
        const nb = await name.boundingBox();
        if (!pb || !nb) return false;
        return pb.x + pb.width <= nb.x && pb.x < 60 && Math.abs(pb.y + pb.height / 2 - (nb.y + nb.height / 2)) < 8;
      })
      .toBe(true);
    await expect(page.getByTestId('anniv-avatar-row')).toHaveCount(0);
    await expect(page.getByTestId('anniv-edit-year')).toBeVisible();
    await expect(page.getByTestId('anniv-edit-month')).toBeVisible();
    await expect(page.getByTestId('anniv-edit-day')).toBeVisible();
    await page.getByTestId('anniv-cal-lunar').click();
    await name.click();
    await name.fill('外婆生日');
    await name.press('Tab');
    await expect(page.getByTestId('anniv-edit-next')).toBeVisible();
    await shot(page, browserName, 'annnew-新建阴历');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('anniv-edit-layer')).toHaveCount(0);

    // 编辑页：日期一行，点开出滚轮；滚月份那一列（停稳以后）换月
    await page.getByTestId('anniv-row').filter({ hasText: '김지민' }).click();
    await expect(page.getByTestId('anniv-edit-layer')).toBeVisible({ timeout: 30_000 });
    const date = page.getByTestId('anniv-edit-date');
    await expect(date).toHaveText(new RegExp(`阳历 ${BDAY.m}月${BDAY.d}日 · 1997 年`));
    await expect(page.getByTestId('anniv-edit-month')).toHaveCount(0);
    // 编辑页照视觉稿 annface（主持人 11-14 定）：名字、日期、提醒、备注同一张卡四行；“下一次”是卡下面一行字，不在卡里，没有“再往后”；没照片不出“去掉”
    const card = page.getByTestId('anniv-edit-remind').locator('xpath=ancestor::*[.//*[@data-testid="anniv-edit-name"]][1]');
    for (const id of ['anniv-edit-name', 'anniv-edit-date', 'anniv-edit-note']) await expect(card.getByTestId(id)).toHaveCount(1);
    await expect(card.getByTestId('anniv-edit-next')).toHaveCount(0);
    await expect(page.getByTestId('anniv-edit-next')).not.toContainText('再往后');
    await expect(page.getByTestId('anniv-edit-name')).toHaveCSS('text-align', 'right');
    await expect(page.getByTestId('anniv-avatar-remove')).toHaveCount(0);
    await shot(page, browserName, 'annface-编辑页日期一行');
    await date.click();
    await expect(date).toHaveAttribute('aria-expanded', 'true');
    const month = page.getByTestId('anniv-edit-month');
    await expect(month).toBeVisible();
    await expect(month).toHaveAttribute('data-value', String(BDAY.m));
    await shot(page, browserName, 'annedit-编辑页日期滚轮');
    const mb = await month.boundingBox();
    if (!mb) throw new Error('no box');
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    const nextM = BDAY.m === 12 ? 1 : BDAY.m + 1;
    const dy = BDAY.m === 12 ? -38 * 11 : 38;
    // 手机版 WebKit 不支持鼠标滚轮：直接滚这一列（同样触发 scroll、停稳后读出）
    if (browserName === 'webkit') await month.evaluate((el, d) => el.scrollBy(0, d), dy);
    else await page.mouse.wheel(0, dy);
    await expect(month).toHaveAttribute('data-value', String(nextM), { timeout: 5000 });
    await expect(date).toContainText(`${nextM}月`);
  });
});

/** 等弹层、编辑层滑到位（连着两次量到同一个位置）再量 */
async function stableBox(loc: ReturnType<Page['getByTestId']>): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const b = await loc.boundingBox();
    const k = JSON.stringify(b);
    if (b && k === last) return b;
    last = k;
    await loc.page().waitForTimeout(100);
  }
  throw new Error('box not stable');
}

/** 鼠标在行上往左拖 120px（指针事件；webkit、chromium 一样） */
async function swipeLeft(page: Page, row: ReturnType<Page['getByTestId']>): Promise<void> {
  const box = await row.boundingBox();
  if (!box) throw new Error('no box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 30, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 80, y + 2, { steps: 5 });
  await page.mouse.move(box.x + box.width - 160, y + 2, { steps: 5 });
  await page.mouse.up();
}
