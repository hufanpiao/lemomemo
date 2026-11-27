// 网页版宽屏改版（2026-11-24 负责人定的 A 方案“助手常驻”；参考 本机资料/01-设计方案/2026-11-24_网页端日历待办改善/web-layout-plan.html），chromium、webkit 都跑：
//   ① 今天、日历、待办、随手记、纪念日、设置六页：铺满一屏（不整页滚），右边常驻 AI 栏，AI 栏顶边、底边和左边卡片齐平（负责人：“ai助手高度要跟其他的齐平”）
//   ② 设置：左边分组目录，点哪组右边出哪组；二级页（皮肤）直接显示在右边详情里，目录跟着亮“外观”；网页版没有“电脑”一组
//   ③ iPad（负责人 11-24“电脑端同样适配ipad”）：横屏 1024 也是这套排法；触屏时页头工具、设置目录、AI 栏建议问题至少 44 高；竖屏 834、分屏 507 回到手机排法、没有横向滚动
//   ⑦ AI 栏标题前是吉祥物里的光球（负责人 11-25“网页端的ai助手改成光球”）：盒子和原来小脸一样 47×32、光球本体和小脸一样高（负责人看图要放大）、在框里居中不出框、加载前后标题不跳；
//      素材下不来退回原来的小脸；减少动态效果时画出首帧后停住
//   ⑧ 进设置、退设置、进出最近删除和页签互切同一份原地模糊淡换（负责人 11-25）；
//   ⑨ 设置里换层只有右边详情有动画：同一份模糊淡换只加在详情那一栏，侧栏、左目录、页头、AI 栏逐帧不动（负责人 11-25）
// 评审截图（设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截）：1440×900、1180×760、1024×768（iPad 横屏）、834×1194、768×1024（iPad 竖屏）、430×932（手机）
import type { Page } from '@playwright/test';
import { B6_NOW, clickAndRead, DESK_USE, idleAll, seedNotes, seedToday, type SwapRead } from './b6-desk-helpers.ts';
import { afterPageFade, shot } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.use(DESK_USE);
// 一个用例连开六页（① 还要切周视图），WebKit 慢的时候 30 秒不够
test.describe.configure({ timeout: 120_000 });

const PAGES = [
  ['today', 'today'],
  ['calendar', 'calendar'],
  ['todos', 'todos'],
  ['notes', 'notes'],
  ['anniv', 'anniv'],
  ['settings', 'settings'],
] as const;

async function seed(page: Page): Promise<void> {
  await page.clock.setFixedTime(B6_NOW);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 20_000 });
  await seedToday(page);
  await seedNotes(page);
}

async function go(page: Page, hash: string): Promise<void> {
  await page.goto(`/app/#/${hash}`);
  // 切页时旧页还在淡出（隐藏），只认看得见的那一个
  await expect(page.locator('main[data-feature]:visible').first()).toBeVisible({ timeout: 20_000 });
  await afterPageFade(page);
}

/** 主区里最上、最下的卡片边（页头下面那一层的直接子块）和 AI 栏的上下边 */
async function edges(page: Page): Promise<{ who: string; cardTop: number; cardBottom: number; dockTop: number; dockBottom: number; scrollW: number; docW: number; mainScroll: number }> {
  // 切页、切周视图的那一下新旧 main 都可能还没显示（页里懒加载的块晚到时 Suspense 会再把整页藏一下）：找和量放在同一个任务里，
  // 没有看得见的 main 就下一帧再来（原来先等、再另起一次 evaluate 量，中间那一下被藏起来就读到 undefined，webkit 1180 偶发）
  const h = await page.waitForFunction(() => {
    const main = [...document.querySelectorAll<HTMLElement>('main[data-feature]')].find((m) => m.checkVisibility());
    if (!main) return null;
    const dock = document.querySelector('[data-testid="chat-dock"]') as HTMLElement;
    // 页头是 main 里第一个够高的块（只给读屏的 h1 只有 1px，不算），它下面的块就是内容区
    // 下拉层（PullSlot）是 display: contents，自己没有框：展开成它的子块
    const flat = (k: Element): Element[] => (getComputedStyle(k).display === 'contents' ? [...k.children].flatMap(flat) : [k]);
    const kids = [...main.children].flatMap(flat).filter((k) => k instanceof HTMLElement && k.getBoundingClientRect().height > 2 && getComputedStyle(k).position !== 'fixed' && getComputedStyle(k).position !== 'absolute') as HTMLElement[];
    const headAt = kids.findIndex((k) => k.getBoundingClientRect().height >= 40);
    const body = kids.slice(headAt + 1);
    const r = dock.getBoundingClientRect();
    const topmost = body.reduce((a, k) => (k.getBoundingClientRect().top < a.getBoundingClientRect().top ? k : a));
    return {
      who: `${topmost.tagName}.${topmost.className}@${Math.round(topmost.getBoundingClientRect().top)}`,
      cardTop: Math.min(...body.map((k) => k.getBoundingClientRect().top)),
      cardBottom: Math.max(...body.map((k) => k.getBoundingClientRect().bottom)),
      dockTop: r.top,
      dockBottom: r.bottom,
      scrollW: document.documentElement.scrollWidth,
      docW: document.documentElement.clientWidth,
      mainScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  const e = await h.jsonValue();
  if (!e) throw new Error('没量到看得见的 main');
  return e;
}

test.describe('网页版宽屏改版', () => {
  for (const [w, h] of [[1440, 900], [1180, 760], [1024, 768]] as const) {
    test(`① ${w}×${h}：六页铺满一屏，AI 栏和卡片顶底齐平`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: w, height: h });
      await seed(page);
      for (const [hash, name] of PAGES) {
        await go(page, hash);
        await expect(page.getByTestId('chat-dock')).toBeVisible({ timeout: 20_000 });
        await shot(page, browserName, `wide-${w}x${h}-${name}`);
        // 软断言：一页不齐也接着把六页都截完，最后一起报
        const e = await edges(page);
        expect.soft(Math.abs(e.dockTop - e.cardTop), `${hash} 顶边 ${e.who}`).toBeLessThanOrEqual(1);
        expect.soft(Math.abs(e.dockBottom - e.cardBottom), `${hash} 底边`).toBeLessThanOrEqual(1);
        expect.soft(e.scrollW, `${hash} 横向滚动`).toBeLessThanOrEqual(e.docW);
        expect.soft(e.mainScroll, `${hash} 整页滚动`).toBeLessThanOrEqual(1);
      }
      // 周视图（“周视图版本 1 时间轴加当天”）同样齐平
      await go(page, 'calendar');
      await page.getByRole('main').getByText('周', { exact: true }).first().click();
      await expect(page.locator('main[data-mode="week"], main [data-mode="week"]').first()).toBeVisible();
      const e = await edges(page);
      expect(Math.abs(e.dockBottom - e.cardBottom), '周视图底边').toBeLessThanOrEqual(1);
      await shot(page, browserName, `wide-${w}x${h}-calendar-week`);
    });
  }

  test('② 设置：左目录点哪组右边出哪组；皮肤二级页在右边详情里，目录亮“外观”', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page);
    await go(page, 'settings');
    const nav = page.getByTestId('settings-dk-nav');
    await expect(nav.getByRole('button')).toHaveText(['账号', '外观', '日历和提醒', 'AI', '数据和隐私', '关于']);
    await expect(page.getByTestId('settings-dk-nav-account')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('settings-account-entry')).toBeVisible();
    // 照参考左边有侧栏（负责人 11-24 定）：不亮页签、有“＋”；页头没有“‹ 今天”；AI 栏只挂一份
    const bar = page.getByTestId('tabbar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('a[data-tab][aria-current]')).toHaveCount(0);
    await expect(page.getByTestId('tabbar-add')).toBeVisible();
    await expect(page.getByTestId('settings-dk-back')).toHaveCount(0);
    // AI 栏首屏画完以后才挂（plus 的 TypeBarPreload），机器忙时 5 秒不够
    await expect(page.getByTestId('chat-dock')).toHaveCount(1, { timeout: 20_000 });
    // 右边详情卡的组名只读一次（标题行就是这一组的标题，不再另带隐藏卡名）
    await expect(page.getByTestId('settings-dk-detail').getByRole('heading', { name: /^账号/ })).toHaveCount(1);
    const navBox = await nav.boundingBox();
    expect(navBox?.x ?? 0, '目录卡从侧栏右边开始（参考 x=110）').toBeGreaterThanOrEqual(109);
    expect(navBox?.x ?? 0).toBeLessThanOrEqual(111);
    await page.getByTestId('settings-dk-nav-look').click();
    const detail = page.getByTestId('settings-dk-detail');
    await expect(detail.getByTestId('settings-dk-group-look')).toBeVisible();
    await expect(detail.getByTestId('settings-account-entry')).toHaveCount(0);
    await shot(page, browserName, 'wide-1440x900-settings-look');
    await detail.getByTestId('settings-skin-entry').click();
    await expect(page).toHaveURL(/#\/settings\/skin$/);
    await expect(detail.getByTestId('settings-skin-back')).toBeVisible();
    await expect(page.getByTestId('settings-dk-nav-look')).toHaveAttribute('aria-current', 'true');
    await expect(nav).toBeVisible();
    await shot(page, browserName, 'wide-1440x900-settings-skin');
    // 从二级页点目录别的组：回到设置首页、右边出那一组
    await page.getByTestId('settings-dk-nav-data').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(detail.getByTestId('settings-dk-group-data')).toBeVisible();
    // 回别的页走侧栏
    await page.getByTestId('tabbar').locator('a[data-tab="today"]').click();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.getByTestId('today')).toBeVisible();
  });

  for (const [w, h] of [[1440, 900], [1024, 768]] as const) {
    test(`⑤ ${w}×${h} 最近删除：照设置页有侧栏（不亮页签）和 AI 栏，内容不压到 AI 栏`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: w, height: h });
      await seed(page);
      await go(page, 'trash');
      await expect(page.getByTestId('trash')).toBeVisible();
      const bar = page.getByTestId('tabbar');
      await expect(bar).toBeVisible();
      await expect(bar.locator('a[data-tab][aria-current]')).toHaveCount(0);
      await expect(page.getByTestId('chat-dock')).toHaveCount(1, { timeout: 20_000 });
      const [main, dock] = await Promise.all([page.getByTestId('trash').boundingBox(), page.getByTestId('chat-dock').boundingBox()]);
      const content = await page.getByTestId('trash').evaluate((m) => m.getBoundingClientRect().right - parseFloat(getComputedStyle(m).paddingRight));
      expect(content, '内容右边在 AI 栏左边').toBeLessThanOrEqual((dock?.x ?? 0) - 12);
      expect(main?.x ?? 0, '在侧栏右边').toBeGreaterThanOrEqual(110);
      await shot(page, browserName, `wide-${w}x${h}-trash`);
    });
  }

  test('⑧ 进设置、退设置、进出最近删除和页签互切一模一样（负责人 11-25“切换动效改成跟导航栏的动效一样”“最近删除进出一起改”）：旧页快照、新页的关键帧、时长、曲线都相同，不整页推、不平移，AI 栏不动', async ({ page }) => {
    await seed(page);
    await afterPageFade(page);
    // 分包先都到（头一次进某页时新页晚到，动画等新页出来才建）
    for (const [sel, ready] of [['[data-testid="tabbar"] a[data-tab="todos"]', 'todos'], ['[data-testid="tabbar-settings"]', 'settings-dk-nav'], ['[data-testid="tabbar"] a[data-tab="today"]', 'today']] as const) {
      await page.locator(sel).click();
      await expect(page.getByTestId(ready)).toBeVisible({ timeout: 30_000 });
      await idleAll(page);
    }
    await expect(page.getByTestId('chat-dock')).toHaveCount(1, { timeout: 20_000 });
    const tab = await clickAndRead(page, '[data-testid="tabbar"] a[data-tab="todos"]');
    await idleAll(page);
    const ok = (r: SwapRead | null, what: string) => {
      expect(r, `${what}：点完新页还没出来`).not.toBeNull();
      expect(r?.vt, `${what}：起了整页推页`).toBe(false);
      expect(r?.ghosts, `${what}：旧页快照不是一份`).toBe(1);
      expect(r?.ghost, `${what}：旧页快照的动画`).toEqual(tab?.ghost);
      expect(r?.fade, `${what}：新页淡入`).toEqual(tab?.fade);
      expect(r?.moved, `${what}：有平移 ${JSON.stringify(r?.moved)}`).toEqual([]);
      expect(r?.dockAnims, `${what}：AI 栏跟着动了`).toBe(0);
    };
    expect(tab?.ghost.length, '页签互切没有旧页快照动画').toBe(1);
    expect(tab?.fade.length, '页签互切没有新页淡入').toBeGreaterThan(0);
    expect(tab?.moved, '页签互切有平移').toEqual([]);
    await page.locator('[data-testid="tabbar"] a[data-tab="today"]').click();
    await expect(page.getByTestId('today')).toBeVisible();
    await idleAll(page);
    // 从今天进（navigate 压栈）、从待办进（原地换），两条路都一样
    ok(await clickAndRead(page, '[data-testid="tabbar-settings"]'), '今天 → 设置');
    await idleAll(page);
    ok(await clickAndRead(page, '[data-testid="tabbar"] a[data-tab="todos"]'), '设置 → 待办');
    await idleAll(page);
    ok(await clickAndRead(page, '[data-testid="tabbar-settings"]'), '待办 → 设置');
    await idleAll(page);
    // 从二级页直接退出设置
    await page.getByTestId('settings-dk-nav-look').click();
    await page.getByTestId('settings-skin-entry').click();
    await expect(page).toHaveURL(/#\/settings\/skin$/);
    await idleAll(page);
    ok(await clickAndRead(page, '[data-testid="tabbar"] a[data-tab="today"]'), '设置 › 皮肤 → 今天');
    await idleAll(page);
    // 最近删除（原来进出都整页推）：设置 → 最近删除、‹ 返回设置、从最近删除经侧栏回今天
    await page.locator('[data-testid="tabbar-settings"]').click();
    await expect(page.getByTestId('settings-dk-nav')).toBeVisible();
    // 整页淡换刚换上来的 FADE_GUARD_MS 里点 main 会被吞（换页守卫），等放完再点
    await idleAll(page);
    await page.getByTestId('settings-dk-nav-data').click();
    // 最近删除的分包先到（同上：头一次进时新页晚到）
    await page.getByTestId('settings-trash-todos-entry').click();
    await expect(page.getByTestId('trash')).toBeVisible({ timeout: 30_000 });
    await idleAll(page);
    await page.getByTestId('trash-back').click();
    await expect(page.getByTestId('settings-dk-nav')).toBeVisible();
    await idleAll(page);
    await page.getByTestId('settings-dk-nav-data').click();
    await expect(page.getByTestId('settings-trash-todos-entry')).toBeVisible();
    await idleAll(page);
    ok(await clickAndRead(page, '[data-testid="settings-trash-todos-entry"]'), '设置 → 最近删除');
    await expect(page).toHaveURL(/#\/trash\/todos$/);
    await idleAll(page);
    ok(await clickAndRead(page, '[data-testid="trash-back"]'), '最近删除 ‹ 返回设置');
    await expect(page).toHaveURL(/#\/settings$/);
    await idleAll(page);
    await page.getByTestId('settings-dk-nav-data').click();
    await page.getByTestId('settings-trash-notes-entry').click();
    await expect(page.getByTestId('trash')).toBeVisible();
    await idleAll(page);
    ok(await clickAndRead(page, '[data-testid="tabbar"] a[data-tab="today"]'), '最近删除 → 今天');
    await idleAll(page);
    expect(await page.evaluate(() => document.querySelectorAll('[data-tab-ghost]').length), '放完旧页快照没拿掉').toBe(0);
  });

  test('⑨ 设置里点进下一层（外观 → 皮肤、关于 → 鸣谢）、返回、换组：只有右边详情有动画——和页签互切同一份模糊淡换（旧详情快照一份、新详情淡入，关键帧、时长、曲线都相同，不平移），侧栏、左目录、页头、AI 栏逐帧不动（负责人 11-25“进入三级画面的时候整个页面都切换”“详情也模糊淡入”）', async ({ page }) => {
    await seed(page);
    await afterPageFade(page);
    // 页签互切的读数当参照（同 ⑧）；分包先都到
    for (const [sel, ready] of [['[data-testid="tabbar"] a[data-tab="todos"]', 'todos'], ['[data-testid="tabbar"] a[data-tab="today"]', 'today']] as const) {
      await page.locator(sel).click();
      await expect(page.getByTestId(ready)).toBeVisible({ timeout: 30_000 });
      await idleAll(page);
    }
    await expect(page.getByTestId('chat-dock')).toHaveCount(1, { timeout: 20_000 });
    const tab = await clickAndRead(page, '[data-testid="tabbar"] a[data-tab="todos"]');
    expect(tab?.ghost.length, '页签互切没有旧页快照动画').toBe(1);
    expect(tab?.fade.length, '页签互切没有新页淡入').toBeGreaterThan(0);
    await idleAll(page);
    await page.locator('[data-testid="tabbar-settings"]').click();
    await expect(page.getByTestId('settings-dk-nav')).toBeVisible({ timeout: 30_000 });
    await idleAll(page);
    const step = async (sel: string, what: string, landed: () => Promise<void>) => {
      const r = await clickAndRead(page, sel, { part: true, frames: 1200 });
      await landed();
      await idleAll(page);
      // 放完快照拿掉（WebKit 慢、头一次进的分包晚到时 1200ms 里可能还没放完，所以等放完再看）
      expect(await page.evaluate(() => document.querySelectorAll('[data-tab-ghost]').length), `${what}：放完旧详情快照没拿掉`).toBe(0);
      expect(r, `${what}：点完详情栏不见了`).not.toBeNull();
      expect(r?.ghosts, `${what}：旧详情快照不是一份`).toBe(1);
      expect(r?.ghost, `${what}：旧详情快照的动画`).toEqual(tab?.ghost);
      expect(r?.fade, `${what}：新详情淡入`).toEqual(tab?.fade);
      expect(r?.moved, `${what}：有平移 ${JSON.stringify(r?.moved)}`).toEqual([]);
      expect(r?.outside, `${what}：详情栏以外有动画`).toBe(0);
      const rows = r?.frames ?? [];
      const first = rows[0];
      expect(first, `${what}：没采到帧`).toBeDefined();
      for (const f of rows) {
        expect(f.vt, `${what} ${f.t}ms：起了整页推页`).toBe(false);
        expect(f.ghosts, `${what} ${f.t}ms：快照多于一份`).toBeLessThanOrEqual(1);
        expect(f.sameMain, `${what} ${f.t}ms：main 换了一个`).toBe(true);
        // 侧栏、左目录、页头、AI 栏：位置、透明度、模糊、平移都和点之前一样
        expect(f.fixed, `${what} ${f.t}ms`).toEqual(first?.fixed);
      }
    };
    await page.getByTestId('settings-dk-nav-look').click();
    await expect(page.getByTestId('settings-skin-entry')).toBeVisible();
    await idleAll(page);
    await step('[data-testid="settings-skin-entry"]', '外观 → 皮肤', async () => {
      await expect(page).toHaveURL(/#\/settings\/skin$/);
      await expect(page.getByTestId('settings-dk-detail').getByTestId('settings-skin-back')).toBeVisible();
    });
    await step('[data-testid="settings-skin-back"]', '皮肤 ‹ 返回', async () => {
      await expect(page).toHaveURL(/#\/settings$/);
      await expect(page.getByTestId('settings-skin-entry')).toBeVisible();
    });
    await page.getByTestId('settings-dk-nav-about').click();
    await page.getByTestId('settings-about-entry').click();
    await expect(page).toHaveURL(/#\/settings\/about$/);
    await idleAll(page);
    await step('[data-testid="settings-credits-entry"]', '关于 → 鸣谢', async () => {
      await expect(page).toHaveURL(/#\/settings\/credits$/);
    });
    await step('[data-testid="settings-dk-nav-data"]', '三级页上点目录换组', async () => {
      await expect(page).toHaveURL(/#\/settings$/);
      await expect(page.getByTestId('settings-dk-detail').getByTestId('settings-dk-group-data')).toBeVisible();
    });
  });

  test('⑥ 1440×900 隐私记：不出常驻栏', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page);
    await go(page, 'vault');
    await expect(page.getByTestId('tabbar')).toBeVisible();
    // 等 AI 栏有机会挂上（今天页上已经挂过，切到隐私记要卸下）
    await expect(page.getByTestId('chat-dock')).toHaveCount(0, { timeout: 10_000 });
  });

  test.describe('⑦ AI 栏标题前的光球（负责人 11-25“网页端的ai助手改成光球”）', () => {
    // 不走 SW：拦 .riv 的那两条要所有请求都经过 page.route
    test.use({ serviceWorkers: 'block' });
    const ORB_RIV = /\/assets\/orb-[^/]+\.riv$/;
    /** 光球盒子、标题的位置，画布上画出来的部分（不透明像素的外框，换成屏幕坐标） */
    const measure = (page: Page) =>
      page.getByTestId('chat-dock').evaluate((dock) => {
        const box = dock.querySelector('[data-mascot-mini]') as HTMLElement;
        const title = dock.querySelector('b') as HTMLElement;
        const b = box.getBoundingClientRect();
        const c = box.querySelector('canvas');
        let ink: { l: number; r: number; t: number; b: number } | null = null;
        const g = c && c.width > 0 ? c.getContext('2d') : null;
        if (c && g) {
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let [l, r, t, bt] = [Infinity, -1, Infinity, -1];
          for (let y = 0; y < c.height; y++)
            for (let x = 0; x < c.width; x++)
              if ((d[(y * c.width + x) * 4 + 3] ?? 0) > 40) [l, r, t, bt] = [Math.min(l, x), Math.max(r, x), Math.min(t, y), Math.max(bt, y)];
          const cr = c.getBoundingClientRect();
          const k = cr.width / c.width;
          if (r >= 0) ink = { l: cr.left + l * k, r: cr.left + (r + 1) * k, t: cr.top + t * k, b: cr.top + (bt + 1) * k };
        }
        return { x: b.x, y: b.y, w: b.width, h: b.height, titleX: title.getBoundingClientRect().x, titleY: title.getBoundingClientRect().y, ink, hidden: box.getAttribute('aria-hidden'), pe: getComputedStyle(box).pointerEvents };
      });

    for (const [w, h] of [[1280, 820], [1440, 900]] as const) {
      test(`${w}×${h}：盒子和原来小脸一样 47×32，光球画在框里居中，加载前后标题不跳`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        // 光球素材先压住：量“还没加载好”时的标题位置，再放行
        let release: () => void = () => undefined;
        const held = new Promise<void>((r) => (release = r));
        await page.route(ORB_RIV, async (r) => {
          await held;
          await r.continue();
        });
        await seed(page);
        const orb = page.getByTestId('chat-dock').locator('[data-mascot-mini="7"]');
        await expect(orb).toHaveAttribute('data-state', 'wait', { timeout: 20_000 });
        const wait = await measure(page);
        release();
        await expect(orb).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
        // 等画面真画出来（Rive 开头几帧可能是空的）
        await expect.poll(async () => (await measure(page)).ink !== null, { timeout: 10_000 }).toBe(true);
        const m = await measure(page);
        expect([m.w, m.h], '盒子同原来小脸').toEqual([47, 32]);
        expect([m.titleX, m.titleY], '标题不跳').toEqual([wait.titleX, wait.titleY]);
        expect(m.hidden).toBe('true');
        expect(m.pe, '不接指针').toBe('none');
        const ink = m.ink ?? { l: NaN, r: NaN, t: NaN, b: NaN };
        expect(ink.l, '左边不出框').toBeGreaterThanOrEqual(m.x - 0.5);
        expect(ink.r, '右边不出框').toBeLessThanOrEqual(m.x + m.w + 0.5);
        expect(ink.t, '上边不出框').toBeGreaterThanOrEqual(m.y - 0.5);
        expect(ink.b, '下边不出框').toBeLessThanOrEqual(m.y + m.h + 0.5);
        expect(Math.abs((ink.l + ink.r) / 2 - (m.x + m.w / 2)), '横向居中').toBeLessThanOrEqual(2);
        // 负责人 11-25 看图：“放大，和原来小脸一样高”（小脸 32 高）：本体呼吸时在 28～32 之间（ChatDock 的 ORB_CROP）
        expect(ink.b - ink.t, '光球本体和原来小脸差不多高').toBeGreaterThanOrEqual(26);
        expect(ink.r - ink.l, '光球本体宽').toBeGreaterThanOrEqual(26);
      });
    }

    test('光球素材下不来：退回原来的小脸，大小不变，不报错', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.route(ORB_RIV, (r) => r.abort());
      await seed(page);
      // 灌数据那一下会重载页面，WebKit 把被打断的分包记成 pageerror（“Importing a module script failed”，和光球无关）：灌完再开始收
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const orb = page.getByTestId('chat-dock').locator('[data-mascot-mini="7"]');
      await expect(orb).toHaveAttribute('data-state', 'fail', { timeout: 20_000 });
      const m = await measure(page);
      expect([m.w, m.h]).toEqual([47, 32]);
      // 小脸：白色椭圆底 + 两只眼睛（::before、::after）
      const face = await orb.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el, '::before').content, getComputedStyle(el, '::after').content]);
      expect(face[0]).not.toBe('rgba(0, 0, 0, 0)');
      expect(face.slice(1)).toEqual(['""', '""']);
      expect(errors).toEqual([]);
    });

    test('减少动态效果：光球画出首帧后停住', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await seed(page);
      const orb = page.getByTestId('chat-dock').locator('[data-mascot-mini="7"]');
      await expect(orb).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
      await expect.poll(async () => (await measure(page)).ink !== null, { timeout: 10_000 }).toBe(true);
      const frame = (): Promise<string> => orb.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
      await page.waitForTimeout(600);
      const a = await frame();
      await page.waitForTimeout(1200);
      expect(await frame()).toBe(a);
    });
  });

  test.describe('③ iPad 触屏', () => {
    test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    test('页头工具、设置目录、建议问题至少 44 高', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '触屏模拟只在 Chromium 上做（WebKit 这一组是 iPhone 模拟）');
      await seed(page);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      const small = async (): Promise<string[]> =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('main [class*="tools"] button, main [class*="tools"] [role="radio"], main nav button, [data-testid="chat-dock"] button')]
            // 点按区 = 自己的框和 ::after 扩出来的点按区（kit ModeSeg 看得见 30、::after 扩到 44）取大的
            .filter((b) => b.getClientRects().length > 0 && Math.max(b.getBoundingClientRect().height, parseFloat(getComputedStyle(b, '::after').height) || 0) < 43.5)
            .map((b) => `${b.textContent?.trim() ?? ''}:${Math.round(b.getBoundingClientRect().height)}`),
        );
      for (const [hash, name] of PAGES) {
        await go(page, hash);
        await expect(page.getByTestId('chat-dock')).toBeVisible({ timeout: 20_000 });
        expect(await small(), hash).toEqual([]);
        await shot(page, browserName, `ipad-1180x820-touch-${name}`);
      }
    });
  });

  for (const [w, h, tag] of [[834, 1194, 'ipad-portrait-834'], [768, 1024, 'ipad-portrait-768'], [507, 1024, 'ipad-split-507'], [430, 932, 'phone-430']] as const) {
    test(`④ ${tag}：回到手机排法，不挂常驻栏，没有横向滚动`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: w, height: h });
      await seed(page);
      for (const [hash, name] of PAGES) {
        await go(page, hash);
        await expect(page.getByTestId('chat-dock')).toHaveCount(0);
        // 窄屏设置页照旧没有底栏（宽屏才照参考画侧栏）
        if (hash === 'settings') await expect(page.getByTestId('tabbar')).toHaveCount(0);
        const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(sw, `${hash} 横向滚动`).toBeLessThanOrEqual(0);
        await shot(page, browserName, `${tag}-${name}`);
      }
    });
  }
});

// ⑩ 四页互切时旧页快照和原页排版一样（负责人 11-25：“切页的时候第一页的画面瞬间往左滑着切过去看起来很乱”）：
//   快照把 main 抄成 div，原来对不上 Desk 的 main.frame，退回手机版的窄宽度（今天 560、日历 960…），整块挤到左边再淡掉
test('⑩ 宽屏四页互切：旧页快照的位置、宽度、第一块内容都和切走前一样，不跳版', async ({ page }) => {
  await seed(page);
  for (const tab of ['calendar', 'todos', 'notes', 'today'] as const) {
    await page.getByTestId('tabbar').locator(`a[data-tab="${tab}"]`).click();
    await afterPageFade(page);
    // 预热时每页多停 1.5 秒，等晚到的分包、吉祥物落定（并发跑时 chromium 头一次从今天切走偶尔不出快照，待查，见台账 #704）
    await page.waitForTimeout(1500);
  }
  for (const tab of ['calendar', 'todos', 'notes', 'today'] as const) {
    const before = await page.evaluate(() => {
      const m = [...document.querySelectorAll<HTMLElement>('main[data-feature]')].find((x) => x.checkVisibility()) as HTMLElement;
      const r = (e: Element | null) => { const b = e?.getBoundingClientRect(); return b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null; };
      return { main: r(m), first: r(m.firstElementChild) };
    });
    await expect(page.locator('[data-tab-ghost]')).toHaveCount(0);
    await page.getByTestId('tabbar').locator(`a[data-tab="${tab}"]`).click();
    // 快照放动画的 880ms 里只改透明度和模糊、不改排版：点完等它出现（每帧看一次）就量
    const ghost = await (
      await page.waitForFunction(
        () => {
          const c = document.querySelector('[data-tab-ghost]')?.firstElementChild ?? null;
          if (!c) return null;
          const r = (e: Element | null) => { const b = e?.getBoundingClientRect(); return b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null; };
          return { main: r(c), first: r(c.firstElementChild) };
        },
        undefined,
        { polling: 'raf', timeout: 8000 },
      )
    ).jsonValue();
    expect(ghost, `切到 ${tab}：旧页快照跳版`).toEqual(before);
    await afterPageFade(page);
  }
});