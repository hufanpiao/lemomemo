// B1 K9：设置页骨架（TC-B1-19 中韩切换和“刷新后保持”；TC-B1-71 分组顺序，R-256 ①；R-325 合卡，SETTINGS-merge-cards）
// 带真实响应头跑（wrangler pages dev + _headers，csp-fixture 收 CSP 报错）。
// e2e 构建没有 VITE_PUBLIC_SUPABASE_URL，设置页拿不到 Supabase 客户端：设备列表显示“读不出来、重试”（不当成被移除、不跳登录页），
// 语言切换照样在本机生效，写账号失败只提示一句。设备列表、移除、退出其他设备、session_revoked 的流程在组件测试里
// （src/features/settings/__tests__/），真登录的两台设备（TC-B1-18、77～79）要 /sb 接本地 Supabase，归 QA 的 S-B1 用例。
// 合卡以后首页是三张卡（账号；常用：语言、倾斜高光、日历、提醒；更多：数据、电脑、关于），设备列表和注销入口在账号二级页，导出在数据二级页
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const SETTINGS = '/app/#/settings';
const ACCOUNT = '/app/#/settings/account';

function settingsMain(page: Page) {
  return page.locator('main[data-feature="settings"]');
}

async function pressedLocale(page: Page): Promise<string | null> {
  return page.locator('[data-testid="settings-lang"] [aria-pressed="true"]').getAttribute('data-value');
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

  // TC-B1-71（R-256 改过；R-325 合卡）：三张卡依次是账号、常用、更多，行按定稿顺序；“退出登录”单独一行在所有卡之后。
  // 导出、注销的流程（含断网、错误码、确认词）在组件测试 src/features/settings/__tests__/account.test.tsx
  test('能打开；三张卡是账号、常用、更多，行的顺序照定稿；“退出登录”在最底下；导出在数据二级页、注销在账号二级页；读设备失败有提示，仍停在 /app/', async ({ page }) => {
    await page.goto(SETTINGS);
    const main = settingsMain(page);
    await expect(main).toBeVisible();
    const cards = main.locator('section[data-testid^="settings-card-"]');
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual([
      'settings-card-account',
      'settings-card-main',
      'settings-card-more',
    ]);
    // 日历、提醒与通知两行一开始就在（值懒加载，M4）
    const rows = await main.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')));
    expect(rows).toEqual(['account', 'language', 'skin', 'calendar', 'reminders', 'data', 'about']);
    // e2e 构建读不到设备：账号一行写“设备列表读不出来”
    await expect(main.getByTestId('settings-account-summary')).toHaveText('设备列表读不出来');
    await expect(main.getByTestId('settings-export')).toHaveCount(0);
    await expect(main.getByTestId('settings-delete-entry')).toHaveCount(0);
    await expect(main).not.toContainText('即将开放');

    // 退出登录：不在任何卡里，DOM 里排在最后一张卡之后
    const signOut = main.getByTestId('settings-signout');
    await expect(signOut).toBeVisible();
    await expect(main.locator('section').getByTestId('settings-signout')).toHaveCount(0);
    const after = await signOut.evaluate((el) => {
      const sections = el.ownerDocument.querySelectorAll('main[data-feature="settings"] section[data-testid^="settings-card-"]');
      const last = sections[sections.length - 1];
      return last ? Boolean(last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    });
    expect(after).toBe(true);

    await main.getByTestId('settings-data-entry').click();
    await expect(page).toHaveURL(/#\/settings\/data$/);
    await expect(main.getByTestId('settings-export')).toContainText('导出全部数据');
    await main.getByTestId('settings-data-back').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await main.getByTestId('settings-account-entry').click();
    await expect(page).toHaveURL(/#\/settings\/account$/);
    await expect(main.getByTestId('settings-delete-entry')).toContainText('注销账号');
    await expect(main.getByTestId('settings-export')).toHaveCount(0);
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
  // 在按钮上下边框外 2px 用 elementFromPoint 点，命中的仍是按钮本身。e2e 构建读不到设备，账号二级页里是“重试”按钮（.btn）
  test('R-276/R-277/R-282 实测：单行行高 44；“重试”看得见 38、上下边框外 2px 仍点到按钮本身；“退出登录”和注销那行一样高 44；语言切换框看得见 38', async ({ page }) => {
    await page.goto(SETTINGS);
    const main = settingsMain(page);
    await expect(main).toBeVisible();

    // 首页的单行入口行（数据、关于、日历、提醒与通知）：量整行的 <li>（合卡代码审查 S7：只量按钮的话行本身被撑高查不出来），
    // 等于按钮的 44 加上这一行自己的下分隔线（卡里最后一行没有），上下不加内边距。日历、提醒与通知两行的值是懒加载的：
    // 等值的字出来了再量，值晚到也不把行撑高。
    // 账号一行 11-06 起是邮箱、设备摘要上下两行（韩文审校 A-4），行高可以超过 44，另在“375 宽”两条里查不截断、不低于 44
    for (const id of ['settings-cal-summary', 'settings-remind-summary']) await expect(main.getByTestId(id), id).toHaveText(/\S/);
    for (const id of ['settings-data-entry', 'settings-about-entry', 'settings-cal-entry', 'settings-remind-entry']) {
      const r = await main.getByTestId(id).evaluate((el) => {
        const li = el.closest('li');
        const cs = li ? getComputedStyle(li) : null;
        return {
          btn: el.getBoundingClientRect().height,
          li: li?.getBoundingClientRect().height ?? 0,
          line: cs ? parseFloat(cs.borderBottomWidth) : -1,
          pad: cs ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : -1,
        };
      });
      expect(Math.round(r.btn), id).toBe(44);
      expect(r.pad, id).toBe(0);
      expect(Math.round(r.li - r.line), id).toBe(44);
    }
    // R-277（负责人 10-30）：“退出登录”整行高 44，和“注销账号”那行一样
    const so = await main.getByTestId('settings-signout').evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.round(so)).toBe(44);

    // R-282（负责人 10-30 选“再小一点”）：语言切换框看得见 38；两个选项看得见 32，上下边框外 2px 仍点到自己（点击区 44）。
    // 合卡以后语言行是两行（第二行灰字说明，M1），切换框不再按 44 的单行行居中，上下各留 3 不再量
    const seg = await main.getByTestId('settings-lang').evaluate((el) => {
      const b = el.getBoundingClientRect();
      const btns = [...el.querySelectorAll('button')];
      const hit = btns.map((btn) => {
        const r = btn.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const own = (y: number): boolean => el.ownerDocument.elementFromPoint(cx, y)?.closest('button') === btn;
        return { h: r.height, up: own(b.top - 2), down: own(b.bottom + 2) };
      });
      return { h: b.height, hit };
    });
    expect(Math.round(seg.h)).toBe(38);
    expect(seg.hit).toHaveLength(2);
    for (const b of seg.hit) {
      expect(Math.round(b.h)).toBe(32);
      expect(b.up).toBe(true);
      expect(b.down).toBe(true);
    }

    // 进账号二级页：等切页过渡（View Transition）放完再量，过渡中 elementFromPoint 命中的是过渡层
    await main.getByTestId('settings-account-entry').click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    const del = await main.getByTestId('settings-delete-entry').locator('xpath=ancestor::li[1]').evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.round(del)).toBe(44);
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
  });

  // 负责人 10-30（iPhone 主屏幕版）：“注销账号点进去后左滑应该是回到设置里面的页面，而不是主页”。
  // 注销页有自己的地址 #/settings/delete；合卡以后从账号二级页点进去，左滑一层一层退：注销 → 账号 → 设置 → 今天
  test('今天 → 设置 → 账号 → 注销账号：一层一层后退回今天；注销页“‹ 账号”同样回账号二级页、不多压一条历史', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
    // 从界面点进去（接手清单 NAV-today-no-settings；负责人 11-05 ①：设置入口是今天页右上角头像，B2 FA-7）；
    // 宽屏（chromium 项目 1280 宽）右上角头像藏掉，入口在电脑版侧栏最下面（D5），两种都认看得见的那个
    await page.locator('[data-testid="today-settings"]:visible, [data-testid="tabbar-settings"]:visible').first().click();
    await expect(settingsMain(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.getByTestId('settings-account-entry').click();
    await expect(page).toHaveURL(/#\/settings\/account$/);
    await page.getByTestId('settings-delete-entry').click();
    await expect(page.getByTestId('settings-delete')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings\/delete$/);

    await page.goBack();
    await expect(page).toHaveURL(/#\/settings\/account$/);
    await expect(page.getByTestId('settings-delete')).toHaveCount(0);
    await expect(page.getByTestId('settings-delete-entry')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();

    // 左上角“‹ 账号”：退回账号二级页；之后再后退两次就是今天（说明返回没有 push 新的一条）
    await page.goForward();
    await page.goForward();
    await expect(page).toHaveURL(/#\/settings\/account$/);
    await page.getByTestId('settings-delete-entry').click();
    await expect(page.getByTestId('settings-delete')).toBeVisible();
    await page.getByTestId('settings-delete-back').click();
    await expect(page).toHaveURL(/#\/settings\/account$/);
    await expect(page.getByTestId('settings-delete-entry')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/today$/);
  });

  // 负责人 10-31（iPhone 主屏幕版）：“点击注销账号跟回退到设置页，注销账号 4 个字都会跳一下”“界面语言 4 个字也不用特意加粗”。
  // 原因和改法见 src/features/settings/__tests__/settings-jump-css.test.ts 头注释；这里在真浏览器里量计算后的样式
  test('“注销账号”那一行按下不缩放、字不挪，只变淡；设置和注销页的顶栏都叫 page-head；“界面语言”和同页其他行同一字重', async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('settings-lang')).toBeVisible();
    const weights = await page.evaluate(() => {
      const w = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fontWeight : '';
      };
      return { lang: w('li[data-row-id="language"] > span'), row: w('[data-testid="settings-about-entry"] span') };
    });
    expect(weights.lang).not.toBe('');
    expect(weights.lang).toBe(weights.row);
    expect(Number(weights.lang)).toBeLessThan(600);

    await page.goto(ACCOUNT);
    const row = page.getByTestId('settings-delete-entry');
    await expect(row).toBeVisible();
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
  test('账号 → 注销账号的过渡中途：顶栏旧标题、新标题不会同时看得见；新标题在过渡里画出来了；顶栏的组不滑位置', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkit（Windows）过渡期间不画起名元素的新图');
    await page.goto(ACCOUNT);
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
