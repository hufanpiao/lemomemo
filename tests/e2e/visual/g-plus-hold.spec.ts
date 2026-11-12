// Q3 守门测试第 1 条（B3 任务单第四节，R-352 ④：给“＋”加按住事件，只加事件，外观、透明度、像素不变）：
// 底栏和“＋”的截图 0 像素差（maxDiffPixels 0、threshold 0），不用全局的 maxDiffPixelRatio 0.002。
// 裁剪区域：底栏和“＋”两块的外接框再外扩 24 px（带阴影、上沿渐隐），夹在视口内。
// 场景：
//   ① 静止：今天、日历、待办三页，随手记页（没有“＋”，只截底栏）
//   ② 外观组合（今天页）：简洁深色、磨砂玻璃浅色 / 深色、App 浅色 + 系统深色、减少透明效果（data-rt="1"）、
//      宽屏 ≥ 900 侧栏（1000×800）、键盘弹起（data-kbhide，底栏藏起）
//   ③ “＋”键盘聚焦（Tab 走到“＋”，:focus-visible）
//   ④ 按下中：按下后挪 12 px（还在“＋”里面，过了 HOLD_SLOP_PX 10 px，按住判定作废、不进录音），按着等 Pressable 过渡放完再截，
//      和改之前同样按下的截图比
//   ⑤ 按住 → 松开、按住 → 上拖取消、点一下之后各截一张静止图，必须和 ① 的今天页同一张基准完全一样。录音面板、打字条打开时不截，关掉以后再截
// 基准图：win32 本机生成（.gitignore 忽略），基准取改之前的代码（B3 任务单第 2 条：B2-UI-a 签字的提交，FA-3 开工时 main 上底栏没再动过，
// 用 FA-3 的父提交 3d3a21de 截）：
//   git checkout 3d3a21de && npx playwright test -c playwright.visual.config.ts --project=chromium-plus-hold --update-snapshots --grep-invert "之后"
// 再切回 FA-3 跑全部（不带 --update-snapshots）。⑤ 那几条只在接上按住以后才有意义，基准用 ① 的同名图。
// 只跑 playwright.visual.config.ts 的 chromium-plus-hold 项目（Chromium 才画 backdrop-filter，和底栏锁定同一种截法）。
import type { Page } from '@playwright/test';
import { fakeMedia } from '../fake-media.ts';
import { applyTheme, expect, frames, freeze, seedTodos, settle, still, test } from './visual-helpers.ts';

type Rect = { x: number; y: number; width: number; height: number };
const PAD = 24;

/** 底栏（和“＋”）外接框外扩 24 px；藏起来（visibility）的也按布局位置算 */
async function barClip(page: Page): Promise<Rect> {
  return page.evaluate((pad) => {
    const els = ['tabbar', 'tabbar-add'].map((id) => document.querySelector(`[data-testid="${id}"]`)).filter((e): e is Element => e !== null);
    const rs = els.map((e) => e.getBoundingClientRect());
    const x0 = Math.max(0, Math.min(...rs.map((r) => r.left)) - pad);
    const y0 = Math.max(0, Math.min(...rs.map((r) => r.top)) - pad);
    const x1 = Math.min(window.innerWidth, Math.max(...rs.map((r) => r.right)) + pad);
    const y1 = Math.min(window.innerHeight, Math.max(...rs.map((r) => r.bottom)) + pad);
    return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0) };
  }, PAD);
}

interface Look {
  skin?: 'simple' | 'glass';
  theme?: 'light' | 'dark';
  /** 系统深色（App 照样浅色） */
  systemDark?: boolean;
  /** 减少透明效果 */
  rt?: boolean;
  /** 宽屏侧栏 */
  wide?: boolean;
}

/** 皮肤、减少透明效果在页面脚本之前改掉并守住（和底栏锁定同一个写法） */
async function applyLook(page: Page, look: Look): Promise<void> {
  await page.addInitScript(
    ({ skin, rt }) => {
      const apply = (): void => {
        const r = document.documentElement;
        if (!r) return;
        if (r.dataset['skin'] !== skin) r.dataset['skin'] = skin;
        if (rt && r.dataset['rt'] !== '1') r.dataset['rt'] = '1';
      };
      apply();
      new MutationObserver(apply).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-skin', 'data-rt'] });
    },
    { skin: look.skin ?? 'simple', rt: look.rt === true },
  );
  await applyTheme(page, look.theme ?? 'light');
  if (look.systemDark) await page.emulateMedia({ colorScheme: 'dark' });
  if (look.wide) await page.setViewportSize({ width: 1000, height: 800 });
}

const TESTID: Record<string, string> = { today: 'today', calendar: 'cal', todos: 'todos', notes: 'notes' };

/** ⑤ 按住那两条：AI 开着才走录音（不开走手机自带识别，Chromium 无头里不能用）。往本机库 settings 写 ai.enabled = true，重新打开。
 *  小气泡记成按住过在 seedTodos 里（visual-helpers 的 HINT_HELD） */
async function aiOn(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const row = { id: 'vis-set-ai', key: 'ai.enabled', value: true, deleted_at: null, updated_at: Date.now() };
    const tx = db.transaction(['settings'], 'readwrite');
    tx.objectStore('settings').put({ id: row.id, server: row, view: row });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  });
  await page.reload();
}

/** 录音那一套挂上了（这次启动的运行日志里有“voice host ready”）：之后按住才有人接手 */
async function recReady(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (localStorage.getItem('lemo-run-log') ?? '').split('=== start').at(-1)?.includes('voice host ready') ?? false), { timeout: 15_000 })
    .toBe(true);
}

async function open(page: Page, route: string, look: Look = {}, rec = false): Promise<void> {
  await applyLook(page, look);
  await freeze(page);
  await fakeMedia(page);
  await seedTodos(page, route);
  if (rec) await aiOn(page);
  await settle(page, TESTID[route] ?? route);
  if (rec) await recReady(page);
  await still(page);
}

async function shot(page: Page, name: string): Promise<void> {
  await frames(page, 3);
  await page.waitForTimeout(300);
  await still(page);
  await expect(page, `底栏或“＋”的像素变了（R-352 ④：按住事件只加事件，外观不许变）`).toHaveScreenshot(name, {
    clip: await barClip(page),
    maxDiffPixels: 0,
    threshold: 0,
  });
}

/** 鼠标移到“＋”中间 */
async function toFab(page: Page): Promise<{ x: number; y: number }> {
  const b = await page.getByTestId('tabbar-add').boundingBox();
  if (!b) throw new Error('找不到“＋”');
  const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(at.x, at.y);
  return at;
}

test.describe('Q3 守门第 1 条：“＋”加按住事件后底栏像素不变（Chromium，0 像素差）', () => {
  // 麦克风授权：今天页会问 Permissions API，没授权时 Chromium 答 prompt，记下的 granted 被清掉，按住先出说明卡（e2e b3-plus-hold 同一个原因）
  test.use({ loggedIn: true, permissions: ['microphone'] });
  test.describe.configure({ timeout: 120_000 });

  for (const route of ['today', 'calendar', 'todos', 'notes']) {
    test(`① 静止：${route}`, async ({ page }) => {
      await open(page, route);
      await shot(page, `静止-${route}.png`);
    });
  }

  const LOOKS: [string, Look][] = [
    ['简洁深色', { theme: 'dark' }],
    ['磨砂玻璃浅色', { skin: 'glass' }],
    ['磨砂玻璃深色', { skin: 'glass', theme: 'dark' }],
    ['App浅色系统深色', { systemDark: true }],
    ['减少透明效果', { rt: true }],
    ['宽屏侧栏', { wide: true }],
  ];
  for (const [name, look] of LOOKS) {
    test(`② 外观：${name}`, async ({ page }) => {
      await open(page, 'today', look);
      await shot(page, `外观-${name}.png`);
    });
  }

  test('② 外观：键盘弹起（底栏藏起）', async ({ page }) => {
    await open(page, 'today');
    await page.evaluate(() => {
      document.documentElement.dataset['kbhide'] = '1';
    });
    await shot(page, '外观-键盘弹起.png');
  });

  test('③ “＋”键盘聚焦', async ({ page }) => {
    await open(page, 'today');
    // 先按一次 Tab（键盘操作过，之后的聚焦算 :focus-visible），再直接聚焦到“＋”（页面里可聚焦的东西多，一个个 Tab 过去太慢）
    await page.keyboard.press('Tab');
    await page.getByTestId('tabbar-add').focus();
    await expect(page.getByTestId('tabbar-add')).toBeFocused();
    expect(await page.getByTestId('tabbar-add').evaluate((el) => el.matches(':focus-visible')), '“＋”没有显示键盘聚焦框').toBe(true);
    await shot(page, '聚焦-加号.png');
  });

  test('④ 按下中（挪过判定范围，不进录音）', async ({ page }) => {
    await open(page, 'today');
    const at = await toFab(page);
    await page.mouse.down();
    await page.mouse.move(at.x + 12, at.y, { steps: 2 });
    await expect(page.getByTestId('tabbar-add')).toHaveAttribute('data-state', 'pressed');
    await page.waitForTimeout(600);
    await shot(page, '按下中.png');
    await page.mouse.up();
  });

  test('⑤ 按住 → 松开之后：和静止的今天页一样', async ({ page }) => {
    // 假后端组取不到会话令牌，上传那一步直接算没成，出“AI 没回应”提示条，关掉再截
    await open(page, 'today', {}, true);
    await toFab(page);
    await page.mouse.down();
    await expect(page.getByTestId('rec-panel')).toBeVisible();
    await page.waitForTimeout(400);
    await page.mouse.up();
    await page.getByTestId('voice-notice-close').click();
    await expect(page.getByTestId('voice-notice')).toHaveCount(0);
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    await page.mouse.move(10, 10);
    await shot(page, '静止-today.png');
  });

  test('⑤ 按住 → 上拖取消之后：和静止的今天页一样', async ({ page }) => {
    await open(page, 'today', {}, true);
    const at = await toFab(page);
    await page.mouse.down();
    await expect(page.getByTestId('rec-panel')).toBeVisible();
    const zone = await page.getByTestId('rec-cancel-zone').boundingBox();
    if (!zone) throw new Error('找不到取消区');
    await page.mouse.move(at.x, zone.y + zone.height / 2, { steps: 6 });
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    await page.mouse.move(10, 10);
    await shot(page, '静止-today.png');
  });

  test('⑤ 点一下之后（打字条收起）：和静止的今天页一样', async ({ page }) => {
    await open(page, 'today');
    await page.getByTestId('tabbar-add').click();
    await expect(page.getByTestId('type-bar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('type-bar')).toHaveCount(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(10, 10);
    await shot(page, '静止-today.png');
  });
});

