// B1 K9：设置页骨架（TC-B1-19 中韩切换和“刷新后保持”；TC-B1-71 分组顺序，R-256 ①；R-325 合卡，SETTINGS-merge-cards）
// 带真实响应头跑（wrangler pages dev + _headers，csp-fixture 收 CSP 报错）。
// e2e 构建没有 VITE_PUBLIC_SUPABASE_URL，设置页拿不到 Supabase 客户端：设备列表显示“读不出来、重试”（不当成被移除、不跳登录页），
// 语言切换照样在本机生效，写账号失败只提示一句。设备列表、移除、退出其他设备、session_revoked 的流程在组件测试里
// （src/features/settings/__tests__/），真登录的两台设备（TC-B1-18、77～79）要 /sb 接本地 Supabase，归 QA 的 S-B1 用例。
// 合卡以后首页是三张卡（账号；常用：语言、日历、提醒（倾斜高光 R-373 已删除）；更多：数据、电脑、关于），设备列表和注销入口在账号二级页，导出在数据二级页
import type { Page } from '@playwright/test';
import { ko as sharedKo } from '../../shared/i18n/ko.ts';
import { zh as sharedZh } from '../../shared/i18n/zh.ts';
import { waitPreloaded } from './page-helpers.ts';
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

  // TC-B1-71（R-256 改过；R-325 合卡；R-441 加“最近删除”一张）：四张卡依次是账号、常用、最近删除、更多，行按定稿顺序；“退出登录”单独一行在所有卡之后。
  // 导出、注销的流程（含断网、错误码、确认词）在组件测试 src/features/settings/__tests__/account.test.tsx
  test('能打开；四张卡是账号、常用、最近删除、更多，行的顺序照定稿；“退出登录”在最底下；导出在数据二级页、注销在账号二级页；读设备失败有提示，仍停在 /app/', async ({ page }) => {
    await page.goto(SETTINGS);
    const main = settingsMain(page);
    await expect(main).toBeVisible();
    const cards = main.locator('section[data-testid^="settings-card-"]');
    await expect(cards).toHaveCount(4);
    expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual([
      'settings-card-account',
      'settings-card-main',
      'settings-card-trash',
      'settings-card-more',
    ]);
    // 日历、提醒与通知、语音与 AI、在 Claude 聊天里记事几行一开始就在（值懒加载，M4）；顺序照定稿线框 s13（B3 FA-4 加了 voiceAi、claude；B4 加了随手记显示方式 notesView；B6 加了皮肤 skin、字体 font；B5 加了隐私记 vault，同 SettingsPage.test.tsx）
    // 11-15 加了待办“完成 7 天后自动删除”todos（开关整行懒加载，先等它到）
    await expect(main.getByTestId('settings-todo-autodel')).toBeVisible();
    const rows = await main.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')));
    // R-471 加了“声音和触感”开关 fx（同 SettingsPage.test.tsx）
    expect(rows).toEqual(['account', 'language', 'skin', 'font', 'notesView', 'fx', 'todos', 'calendar', 'reminders', 'voiceAi', 'vault', 'trash-todos', 'trash-notes', 'data', 'claude', 'about']);
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

  // 首屏瘦身 D（11-17）：公共词典只下载当前语言那一份（platform/doc-locale.ts 的 loadSharedDict）；点“한국어”后先等韩文那份，
  // 下载完以前界面、页面标题照旧是中文，页面上不出现词条键名；到了才一起换成韩文。挡住 SW（不然请求不经 page.route），把韩文那份卡住再放行
  test.describe('公共词典按语言懒加载', () => {
    test.use({ serviceWorkers: 'block' });

    test('冷启动只下载中文那份；切换期间照旧中文、不出键名；韩文那份到了才换', async ({ page }) => {
      const keys = Object.keys(sharedZh);
      const keysOnPage = async (): Promise<string[]> => {
        const text = await page.locator('body').innerText();
        return keys.filter((k) => text.includes(k));
      };
      const dicts: string[] = [];
      page.on('request', (r) => {
        const m = /\/assets\/(zh|ko)-[\w-]+\.js$/.exec(new URL(r.url()).pathname);
        if (m?.[1]) dicts.push(m[1]);
      });
      let release = (): void => undefined;
      const held = new Promise<void>((r) => (release = r));
      await page.route(/\/assets\/ko-[\w-]+\.js$/, async (route) => {
        await held;
        await route.continue();
      });

      await page.goto(SETTINGS);
      await expect(settingsMain(page)).toBeVisible();
      expect(dicts).toEqual(['zh']);
      expect(await page.title()).toBe(sharedZh['app.name']);

      await page.getByRole('button', { name: '한국어' }).click();
      await expect.poll(() => dicts).toEqual(['zh', 'ko']);
      // 韩文那份卡着：还是中文、没有键名
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
      expect(await pressedLocale(page)).toBe('zh');
      expect(await page.title()).toBe(sharedZh['app.name']);
      expect(await keysOnPage()).toEqual([]);

      release();
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko-KR');
      expect(await pressedLocale(page)).toBe('ko');
      expect(await page.title()).toBe(sharedKo['app.name']);
      expect(await keysOnPage()).toEqual([]);
      // 换回中文：那份已经有了，当场换，不再下载
      await page.getByRole('button', { name: '中文' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
      expect(dicts).toEqual(['zh', 'ko']);
    });
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

    // R-436（底子评审 11-15）：语言切换改用 kit 的 ModeSeg slide，外观以纪念日确认稿第 4 条为准——切换框看得见 36，两个选项看得见 30，上下边框外 2px 仍点到自己（点击区 44）。
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
    expect(Math.round(seg.h)).toBe(36);
    expect(seg.hit).toHaveLength(2);
    for (const b of seg.hit) {
      expect(Math.round(b.h)).toBe(30);
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
  // 注销页有自己的地址 #/settings/delete；合卡以后从账号二级页点进去，一层一层退：注销 → 账号 → 设置 → 今天。
  // R-487 起浏览器历史只有一条：退一步走页面里的“‹ 返回”（和左边往右划同一个 goBack），全程 history.length 不变
  test('今天 → 设置 → 账号 → 注销账号：一层一层退回今天，浏览器历史一条不多', async ({ page }) => {
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

    const len = await page.evaluate(() => history.length);
    const depth = (): Promise<number> => page.evaluate(() => ((history.state as { lemoStack?: unknown[] } | null)?.lemoStack ?? []).length);
    expect(await depth()).toBe(3);
    await page.getByTestId('settings-delete-back').click();
    await expect(page).toHaveURL(/#\/settings\/account$/);
    await expect(page.getByTestId('settings-delete')).toHaveCount(0);
    await expect(page.getByTestId('settings-delete-entry')).toBeVisible();
    expect(await depth()).toBe(2);
    await page.getByTestId('settings-account-back').click();
    await expect(page).toHaveURL(/#\/settings$/);
    expect(await depth()).toBe(1);
    await settingsMain(page).locator('header a[href="#/today"]').click();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
    expect(await depth()).toBe(0);
    expect(await page.evaluate(() => history.length)).toBe(len);
  });

  // 负责人 10-31（iPhone 主屏幕版）：“点击注销账号跟回退到设置页，注销账号 4 个字都会跳一下”“界面语言 4 个字也不用特意加粗”。
  // 原因和改法见 src/features/settings/__tests__/settings-jump-css.test.ts 头注释；这里在真浏览器里量计算后的样式
  test('“注销账号”那一行按下不缩放、字不挪，只变淡；设置和注销页的顶栏都不单独起过渡名（跟整页一起滑）；“界面语言”和同页其他行同一字重', async ({ page }) => {
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
    expect(await headName()).toBe('none');

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
    // 变淡用轮询：CI 上 webkit 负载高时 200ms 还没出过渡的第一帧（11-17 ci 读到 pressed 但 opacity 仍是 1，重试通过）
    await expect.poll(async () => Number((await look()).opacity)).toBeLessThan(1);
    expect(Math.abs(pressed.x - before.x)).toBeLessThan(0.5);
    await row.dispatchEvent('pointerup');
    await expect.poll(async () => (await look()).opacity).toBe('1');

    await row.click();
    await expect(page.getByTestId('settings-delete')).toBeVisible();
    expect(await headName()).toBe('none');
  });

  // 负责人 11-20：“所有点击进入下一页……画面都黑一下”，选“新页从右滑进盖住”（关键帧原来在 base.css lemo-push-* / lemo-pop-*，
  // 11-20 起整页推页不用 View Transition，数值原样搬进 motion/page-swap.ts，旧页是真 DOM 副本 [data-tab-ghost]、新页是真 main）。
  // 过渡中途两页都看得见、不再有整屏只剩底色的一帧；返回反方向
  test('账号 → 注销账号：新页从右滑进盖住、旧页往左退，中途不黑；“‹ 返回”反过来滑出（负责人 11-20）', async ({ page, browserName }, info) => {
    await page.goto(ACCOUNT);
    await expect(page.getByTestId('settings-delete-entry')).toBeVisible({ timeout: 10_000 });
    // 推页动画实现首屏画完才下载，到之前换页直接换、不播（motion/index.ts）：等冷启动预加载跑完，它早就到了
    await waitPreloaded(page);
    /** 点 testId，等整页推页的动画（关键帧里带 vw 的平移）出来就全部暂停，回旧页副本、新页的平移关键帧 */
    const start = (id: string) =>
      page.evaluate(async (tid) => {
        document.querySelector<HTMLElement>(`[data-testid="${tid}"]`)?.click();
        const slides = () =>
          document.getAnimations().filter((a) => a.effect instanceof KeyframeEffect && a.effect.getKeyframes().some((k) => String(k['translate'] ?? '').includes('vw')));
        const of = (sel: string) => slides().find((a) => ((a.effect as KeyframeEffect).target as Element | null)?.closest(sel) != null);
        for (let i = 0; i < 120 && !(of('[data-tab-ghost]') && of('main')); i++) await new Promise((r) => requestAnimationFrame(r));
        for (const a of document.getAnimations()) a.pause();
        const kf = (a: Animation | undefined) => ((a?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? []).map((k) => String(k['translate'] ?? ''));
        return { old: kf(of('[data-tab-ghost]')), now: kf(of('main')) };
      }, id);
    const at = (ms: number) =>
      page.evaluate(async (t) => {
        for (const a of document.getAnimations()) a.currentTime = t;
        await new Promise((r) => requestAnimationFrame(r));
        const tx = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).translate) || 0 : NaN);
        const main = document.querySelector('main');
        const part = [main, ...(main?.querySelectorAll('*') ?? [])].find((e) => e && e.getAnimations().length > 0) ?? null;
        return { old: tx(document.querySelector('[data-tab-ghost]')), now: tx(part), w: innerWidth };
      }, ms);
    // 截图只在 chromium 留：webkit 截图时 Playwright 往页面插 <style>，被本站 CSP（style-src-elem）拦（11-20 实测，caret: 'initial' 也照插）
    const shot = async (name: string) => void (browserName === 'chromium' && (await page.screenshot({ path: info.outputPath(`${name}.png`) })));

    const go = await start('settings-delete-entry');
    expect(go.old, '旧页往左退 30vw（原 lemo-push-old）').toEqual(['0px', '-30vw']);
    expect(go.now, '新页从 100vw 滑进来（原 lemo-push-new）').toEqual(['100vw', '0px']);
    const mid = await at(150);
    // 新页还没盖满、旧页往左退了一点：两页同时在屏上（原来 150ms 两页都透明，整屏只剩底色）
    expect(mid.now).toBeGreaterThan(0);
    expect(mid.now).toBeLessThan(mid.w);
    expect(mid.old).toBeLessThan(0);
    expect(mid.old).toBeGreaterThan(-mid.w * 0.3 - 1);
    await shot('进页-150ms');
    expect((await at(379)).now).toBeLessThan(2);
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.finish();
    });
    await expect(page.getByTestId('settings-delete')).toBeVisible();

    const back = await start('settings-delete-back');
    expect(back.old, '旧页往右滑出（原 lemo-pop-old）').toEqual(['0px', '100vw']);
    expect(back.now, '上一页从 -30vw 回来（原 lemo-pop-new）').toEqual(['-30vw', '0px']);
    const mid2 = await at(150);
    // 旧页往右滑出、上一页从左边回来
    expect(mid2.old).toBeGreaterThan(0);
    expect(mid2.now).toBeLessThan(0);
    await shot('返回-150ms');
  });
});
