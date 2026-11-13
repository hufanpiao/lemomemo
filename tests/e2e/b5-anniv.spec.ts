// 纪念日的真浏览器用例（B5 S14、S16；TC-B5 列表、新建、今天页一行、设置里的默认提醒）
// jsdom 测过排序、表单、提醒弹层（src/features/anniv/__tests__），这里用真构建守：农历和推算按需加载（anniv-lib）真的加载得出来、
// 小外壳 AnnivRoot 再懒加载页面、今天页按服务器 next_date 出一行、设置 › 提醒与通知 里“纪念日提醒”一行能点开改。
//   ① 本机库写三条（3 天后的生日、9 天后的纪念日、20 天后的倒数日）：列表按还有几天排，“最近的一个”是 3 天后的生日，筛选“纪念日”只剩一条；
//   ② 今天页顶部出“3 天后 김지민”，点了进纪念日页；
//   ③ “＋ 新建”盖上编辑层，写名字后 Esc 关掉，列表里多了这一条；
//   ④ 设置 › 提醒与通知 的“纪念日提醒”写着出厂默认“提前 7 天、前一天 · 9:00”，点开加上“提前 3 天”，回来那一行跟着变。
// 纪念日在界面上只能一条条建，先让 App 开好本机库，再往 anniversaries 仓写服务器形状的行、刷新（同 b4-notes-s7s8.spec.ts 的分类）
// 截图：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（WebKit 截图会往页面插 <style>、被 CSP 记成违规）；断言两种浏览器都跑
import type { Page } from '@playwright/test';
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
  });
});
