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
});
