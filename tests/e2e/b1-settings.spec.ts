// B1 K9：设置页骨架（TC-B1-19 中韩切换和“刷新后保持”；TC-B1-71 分组顺序，R-256 ①）
// 带真实响应头跑（wrangler pages dev + _headers，csp-fixture 收 CSP 报错）。
// e2e 构建没有 VITE_PUBLIC_SUPABASE_URL，设置页拿不到 Supabase 客户端：设备列表显示“读不出来、重试”（不当成被移除、不跳登录页），
// 语言切换照样在本机生效，写账号失败只提示一句。设备列表、移除、退出其他设备、session_revoked 的流程在组件测试里
// （src/features/settings/__tests__/），真登录的两台设备（TC-B1-18、77～79）要 /sb 接本地 Supabase，归 QA 的 S-B1 用例。
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const SETTINGS = '/app/#/settings';

function settingsMain(page: Page) {
  return page.locator('main[data-feature="settings"]');
}

async function pressedLocale(page: Page): Promise<string | null> {
  return page.locator('[data-testid="settings-lang"] [aria-pressed="true"]').getAttribute('data-locale');
}

test.describe('设置页骨架', () => {
  // 入口没读到本机会话会跳 /app/auth/（K6）：用 K16 的共用假会话
  test.use({ loggedIn: true });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // 设备语言固定成中文：刷新后还是韩文，才说明是“手动选过的优先”
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['zh-CN', 'zh'] });
    });
  });

  // TC-B1-71（R-256 改过）：账号 → 界面语言 → 数据；导出入口在数据组、注销入口在账号组；“退出登录”单独一行在所有分组之后。
  // 导出、注销的流程（含断网、错误码、确认词）在组件测试 src/features/settings/__tests__/account.test.tsx
  test('能打开；分组顺序是账号、界面语言、数据；导出在数据组，“退出登录”在最底下；读设备失败显示提示（role=alert），仍停在 /app/', async ({ page }) => {
    await page.goto(SETTINGS);
    const main = settingsMain(page);
    await expect(main).toBeVisible();
    const groups = (await main.getByRole('heading', { level: 2 }).allTextContents()).map((s) => s.trim());
    expect(groups.slice(0, 3)).toEqual(['账号', '界面语言', '数据']);

    const account = main.locator('section[data-section="account"]');
    const data = main.locator('section[data-section="data"]');
    await expect(data.getByTestId('settings-export')).toBeVisible();
    await expect(data.getByTestId('settings-export')).toContainText('导出全部数据');
    await expect(account.getByTestId('settings-delete-entry')).toContainText('注销账号');
    await expect(account.getByTestId('settings-export')).toHaveCount(0);
    await expect(main).not.toContainText('即将开放');

    // 退出登录：不在任何分组里，DOM 里排在最后一个分组之后
    const signOut = main.getByTestId('settings-signout');
    await expect(signOut).toBeVisible();
    await expect(main.locator('section').getByTestId('settings-signout')).toHaveCount(0);
    const after = await signOut.evaluate((el) => {
      const sections = el.ownerDocument.querySelectorAll('main[data-feature="settings"] section');
      const last = sections[sections.length - 1];
      return last ? Boolean(last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    });
    expect(after).toBe(true);

    await expect(page.getByRole('alert').first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/app/');
  });

  test('中韩切换：点“한국어”后 <html lang> 变 ko-KR、选中项从 zh 换成 ko、localStorage pv-locale 和 cookie lemo_lang 都是 ko', async ({ page, context }) => {
    await page.goto(SETTINGS);
    await expect(settingsMain(page)).toBeVisible();
    expect(await pressedLocale(page)).toBe('zh');
    await page.getByRole('button', { name: '한국어' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko-KR');
    expect(await pressedLocale(page)).toBe('ko');
    expect(await page.evaluate(() => localStorage.getItem('pv-locale'))).toBe('ko');
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'lemo_lang')?.value).toBe('ko');
  });

  // 主 App 入口 src/app/main.tsx 渲染前按“缓存的 profiles.ui_locale → pv-locale → 设备语言 → 中文”定语言（K6 返工）；
  // 刷新保持的逻辑另由组件测试 src/features/settings/__tests__/locale.test.tsx 覆盖
  test('改语言后刷新：仍是韩文（设备语言是中文）；换回中文再刷新是中文', async ({ page }) => {
    await page.goto(SETTINGS);
    await page.getByRole('button', { name: '한국어' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko-KR');

    await page.reload();
    await expect(settingsMain(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko-KR');
    expect(await pressedLocale(page)).toBe('ko');

    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.reload();
    await expect(settingsMain(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    expect(await pressedLocale(page)).toBe('zh');
  });

  // R-276（负责人 10-30）：单行行整行高 44；按钮（.btn）看得见 38，点击区由 ::after 扩到 44——
  // 在按钮上下边框外 2px 用 elementFromPoint 点，命中的仍是按钮本身。e2e 构建读不到设备，账号组里是“重试”按钮（.btn）
  test('R-276/R-277/R-282 实测：单行行高 44；“重试”看得见 38、上下边框外 2px 仍点到按钮本身；“退出登录”和注销那行一样高 44；语言切换框看得见 38', async ({ page }) => {
    await page.goto(SETTINGS);
    const main = settingsMain(page);
    await expect(main).toBeVisible();
    await expect(page.getByRole('alert').first()).toBeVisible();

    const rows = [
      main.getByTestId('settings-delete-entry').locator('xpath=ancestor::li[1]'),
      main.getByTestId('settings-lang').locator('xpath=ancestor::li[1]'),
      main.getByTestId('settings-export').locator('xpath=ancestor::li[1]'),
    ];
    for (const row of rows) {
      const h = await row.evaluate((el) => el.getBoundingClientRect().height);
      expect(Math.round(h)).toBe(44);
    }

    // R-277（负责人 10-30）：“退出登录”整行高 44，和“注销账号”那行一样
    const so = await main.getByTestId('settings-signout').evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.round(so)).toBe(44);

    const buttons = [main.getByRole('alert').getByRole('button', { name: '重试' })];
    for (const btn of buttons) {
      const r = await btn.evaluate((el) => {
        el.scrollIntoView({ block: 'center' });
        const b = el.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const own = (y: number): boolean => el.ownerDocument.elementFromPoint(cx, y)?.closest('button') === el;
        return { h: b.height, up: own(b.top - 2), down: own(b.bottom + 2) };
      });
      expect(Math.round(r.h)).toBe(38);
      expect(r.up).toBe(true);
      expect(r.down).toBe(true);
    }
    // R-282（负责人 10-30 选“再小一点”）：语言切换框看得见 38、在 44 的行里上下各留 3；两个选项的点按范围仍是整行 44
    const seg = await main.getByTestId('settings-lang').evaluate((el) => {
      const row = el.closest('li')?.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const btns = [...el.querySelectorAll('button')];
      const hit = btns.map((btn) => {
        const r = btn.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const own = (y: number): boolean => el.ownerDocument.elementFromPoint(cx, y)?.closest('button') === btn;
        return { h: r.height, up: own(b.top - 2), down: own(b.bottom + 2) };
      });
      return { h: b.height, top: b.top - (row?.top ?? NaN), bottom: (row?.bottom ?? NaN) - b.bottom, hit };
    });
    expect(Math.round(seg.h)).toBe(38);
    expect(Math.round(seg.top)).toBe(3);
    expect(Math.round(seg.bottom)).toBe(3);
    expect(seg.hit).toHaveLength(2);
    for (const b of seg.hit) {
      expect(Math.round(b.h)).toBe(32);
      expect(b.up).toBe(true);
      expect(b.down).toBe(true);
    }
  });

  // 负责人 10-30（iPhone 主屏幕版）：“注销账号点进去后左滑应该是回到设置里面的页面，而不是主页”。
  // 注销页原来是设置页里的本地状态、没有历史记录，侧滑（浏览器后退）直接退回今天；现在有自己的地址 #/settings/delete
  test('今天 → 设置 → 注销账号：后退一次回设置、再后退回今天；注销页“‹ 返回”同样回设置、不多压一条历史', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByRole('link', { name: /设置/ }).click();
    await expect(settingsMain(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.getByTestId('settings-delete-entry').click();
    await expect(page.getByTestId('settings-delete')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings\/delete$/);

    await page.goBack();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByTestId('settings-delete')).toHaveCount(0);
    await expect(page.getByTestId('settings-delete-entry')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();

    // 左上角“‹ 返回”：退回设置；之后再后退一次就是今天（说明返回没有 push 新的一条）
    await page.goForward();
    await expect(settingsMain(page)).toBeVisible();
    await page.getByTestId('settings-delete-entry').click();
    await expect(page.getByTestId('settings-delete')).toBeVisible();
    await page.getByTestId('settings-delete-back').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByTestId('settings-delete-entry')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/today$/);
  });

  // 负责人 10-31（iPhone 主屏幕版）：“点击注销账号跟回退到设置页，注销账号 4 个字都会跳一下”“界面语言 4 个字也不用特意加粗”。
  // 原因和改法见 src/features/settings/__tests__/settings-jump-css.test.ts 头注释；这里在真浏览器里量计算后的样式
  test('“注销账号”那一行按下不缩放、字不挪，只变淡；设置和注销页的顶栏都叫 page-head；“界面语言”和同页其他行同一字重', async ({ page }) => {
    await page.goto(SETTINGS);
    const row = page.getByTestId('settings-delete-entry');
    await expect(row).toBeVisible();
    const weights = await page.evaluate(() => {
      const w = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fontWeight : '';
      };
      return { lang: w('#settings-lang-title'), row: w('[data-testid="settings-delete-entry"] span') };
    });
    expect(weights.lang).toBe(weights.row);
    expect(Number(weights.lang)).toBeLessThan(600);

    const headName = () => page.locator('main[data-feature="settings"] header').evaluate((el) => getComputedStyle(el).viewTransitionName);
    expect(await headName()).toBe('page-head');

    const look = () =>
      row.evaluate((b) => ({
        state: b.getAttribute('data-state'),
        transform: getComputedStyle(b).transform,
        opacity: getComputedStyle(b).opacity,
        x: b.querySelector('span')?.getBoundingClientRect().x ?? -1,
      }));
    const before = await look();
    await row.dispatchEvent('pointerdown');
    await page.waitForTimeout(200);   // 比 --dur-press（120ms）长：原来的 scale 这时已经缩到底
    const pressed = await look();
    expect(pressed.state).toBe('pressed');
    expect(pressed.transform).toBe('none');
    expect(Number(pressed.opacity)).toBeLessThan(1);
    expect(Math.abs(pressed.x - before.x)).toBeLessThan(0.5);
    await row.dispatchEvent('pointerup');
    await expect.poll(async () => (await look()).opacity).toBe('1');

    await row.click();
    await expect(page.getByTestId('settings-delete')).toBeVisible();
    expect(await headName()).toBe('page-head');
  });

  // 同一条反馈：顶栏 page-head 在过渡中途真的“先出后入”。只跑 chromium：Playwright 的 Windows 版 webkit 过渡期间不画单独起名元素的新图
  // （和本项目无关的最小页面也一样），截出来是空的，判断不了；真机 Safari 由负责人目测
  test('设置 → 注销账号的过渡中途：顶栏旧标题、新标题不会同时看得见；新标题在过渡里画出来了；顶栏的组不滑位置', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkit（Windows）过渡期间不画起名元素的新图');
    await page.goto(SETTINGS);
    await expect(page.getByTestId('settings-delete-entry')).toBeVisible();
    // 页面里点下去，等到 page-head 的动画出现就把整段过渡全部暂停（之后按时间点拨动）
    const names = await page.evaluate(async () => {
      document.querySelector<HTMLElement>('[data-testid="settings-delete-entry"]')?.click();
      const pageHead = () => document.getAnimations().filter((a) => String((a.effect as KeyframeEffect | null)?.pseudoElement ?? '').includes('page-head'));
      for (let i = 0; i < 120 && pageHead().length < 2; i++) await new Promise((r) => requestAnimationFrame(r));
      for (const a of document.getAnimations()) a.pause();
      return pageHead().map((a) => `${(a.effect as KeyframeEffect).pseudoElement ?? ''} ${(a as CSSAnimation).animationName}`);
    });
    expect(names.sort()).toEqual(['::view-transition-new(page-head) lemo-head-in', '::view-transition-old(page-head) lemo-head-out']);

    const at = (ms: number) =>
      page.evaluate(async (t) => {
        for (const a of document.getAnimations()) a.currentTime = t;
        await new Promise((r) => requestAnimationFrame(r));
        const op = (pe: string) => Number(getComputedStyle(document.documentElement, pe).opacity);
        return { old: op('::view-transition-old(page-head)'), now: op('::view-transition-new(page-head)') };
      }, ms);
    // 只截顶栏自己的框：起了名的元素不在 root 的截图里，这块在 root 两边都只是页面底色，变的只有顶栏自己
    const box = await page.locator('main[data-feature="settings"] header').boundingBox();
    expect(box).not.toBeNull();
    const header = box ?? { x: 0, y: 0, width: 1, height: 1 };
    for (const ms of [0, 40, 80, 120, 150, 152, 160, 200, 260, 320, 379]) {
      const o = await at(ms);
      expect(Math.min(o.old, o.now), `${ms}ms：旧 ${o.old}、新 ${o.now}，不能两个都看得见`).toBeLessThan(0.02);
    }
    // 截图：152ms 两边都透明，顶栏一片空；370ms 新标题差不多全显，截出来和空的那帧不一样（真的画出来了）
    await at(152);
    const blank = await page.screenshot({ clip: header });
    await at(370);
    const drawn = await page.screenshot({ clip: header });
    expect(drawn.equals(blank)).toBe(false);
    expect((await at(370)).now).toBeGreaterThan(0.95);
  });
});
