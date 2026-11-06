// 设置首页账号一行（SETTINGS-merge-cards）：从 b1-settings.spec.ts 拆出来（原文件超 300 行，11-06）
// 头像圈和今天页右上角的同一组件、同样尺寸（负责人 11-05 ①）；邮箱和设备摘要上下两行、不截断（韩文审校 A-4）；
// 长邮箱在“.”后、“@”前断行（韩文复审建议，<wbr>）。e2e 没后端，设备摘要是“设备列表读不出来”
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const SETTINGS = '/app/#/settings';
const LONG_MAIL = 'hoobey.lemomemo.longname.test.account@example-company-mail.co.kr';

/** 账号一行：行名（邮箱）和值（设备摘要）都没被截断，值在行名下面；按钮至少 44 高 */
async function expectAccountRowWhole(page: Page): Promise<void> {
  const summary = page.getByTestId('settings-account-summary');
  await expect(summary).not.toHaveText('');
  const m = await page.getByTestId('settings-account-entry').evaluate((btn) => {
    const v = btn.querySelector('[data-testid="settings-account-summary"]') as HTMLElement;
    const label = v.previousElementSibling as HTMLElement;
    const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis' && getComputedStyle(el).overflow === 'hidden';
    return {
      h: btn.getBoundingClientRect().height,
      below: v.getBoundingClientRect().top >= label.getBoundingClientRect().bottom - 1,
      vCut: cut(v),
      lCut: cut(label),
      right: Math.max(v.getBoundingClientRect().right, label.getBoundingClientRect().right) <= btn.getBoundingClientRect().right,
    };
  });
  expect(m).toEqual({ h: m.h, below: true, vCut: false, lCut: false, right: true });
  expect(m.h).toBeGreaterThanOrEqual(44);
}

test.describe('设置首页账号一行', () => {
  test.use({ loggedIn: true });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['zh-CN', 'zh'] });
    });
  });

  // 负责人 11-05 ①：账号一行用今天页那个头像圈，同一组件、同样尺寸（手机宽才有今天页右上角那个）
  test('375 宽：设置首页账号一行的头像圈和今天页右上角的一样大、圆圈一样内缩', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const measure = async (sel: string) =>
      page.locator(sel).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const b = getComputedStyle(el, '::before');
        return { w: r.width, h: r.height, inset: b.inset, radius: b.borderRadius, bg: b.backgroundColor, fs: getComputedStyle(el).fontSize };
      });
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today-settings')).toBeVisible();
    const today = await measure('[data-testid="today-settings"] > span');
    await page.goto(SETTINGS);
    await expect(page.getByTestId('settings-account-avatar')).toBeVisible();
    const row = await measure('[data-testid="settings-account-avatar"]');
    expect(row).toEqual(today);
    expect(today.w).toBe(44);
    expect(today.h).toBe(44);
    // 韩文审校 A-4：账号一行邮箱和设备摘要上下两行，摘要在邮箱下面、不省略（e2e 没后端，摘要是“设备列表读不出来”）
    await expectAccountRowWhole(page);
  });

  test('375 宽长邮箱：账号一行邮箱折行、设备摘要在下面一行，都不截断（韩文审校 A-4）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript((mail) => {
      for (const k of Object.keys(localStorage)) {
        if (!/^sb-.*-auth-token$/.test(k)) continue;
        const v = JSON.parse(localStorage.getItem(k) ?? '{}') as { user?: { email?: string } };
        if (v.user) v.user.email = mail;
        localStorage.setItem(k, JSON.stringify(v));
      }
    }, LONG_MAIL);
    await page.goto(SETTINGS);
    await expect(page.getByTestId('settings-account-entry')).toContainText(LONG_MAIL);
    await expectAccountRowWhole(page);
    // 韩文复审建议：折行只落在“.”后、“@”前（插了 <wbr>），不从单词中间断
    const starts = await page.getByTestId('settings-account-summary').evaluate((v) => {
      const label = v.previousElementSibling as HTMLElement;
      const out: string[] = [];
      let lastTop: number | null = null;
      let prev = '';
      for (const node of label.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const txt = node.textContent ?? '';
        for (let i = 0; i < txt.length; i++) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + 1);
          const top = Math.round(r.getBoundingClientRect().top);
          if (lastTop !== null && top > lastTop + 2) out.push(`${prev}|${txt[i] ?? ''}`);
          lastTop = top;
          prev = txt[i] ?? '';
        }
      }
      return out;
    });
    expect(starts.length).toBeGreaterThan(0);
    // 连字符后面本来就是正常的断行处（example-company），也认
    for (const s of starts) expect(s.startsWith('.|') || s.startsWith('-|') || s.endsWith('|@'), s).toBe(true);
  });
});
