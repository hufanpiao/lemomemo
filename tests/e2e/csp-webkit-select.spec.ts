// WebKit 新建 <select> 时报 CSP style-src-attr 的误报（11-05 查明；B2-代码审查-FA7底栏外壳.md 第四节；
// bug 草稿 docs/03-评审/B2/B2-WebKit-bug草稿-select-CSP误报.md）。CSP 不放宽，csp-fixture.ts 只对 webkit 精确放过这一种。
// • 最小复现：在带本站 CSP 的页面里只 createElement('select')，不挂进文档。WebKit 报一条，Chromium 不报。
//   这里读的是没经过配对的原始违规（window.__csp），所以不受 fixture 放过规则影响，用 expectViolations 自己判
//   webkit 下标 test.fail：哪天 WebKit 修好了，这条会变红，那时去掉 fixture 里的放过规则。
// • 放过规则本身：建 select 的那条被标成 webkitSelect；别的内联样式违规（setAttribute('style')）不被标，照样判失败
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const violationsAfter = async (page: Page, act: string) =>
  page.evaluate(async (what) => {
    const before = window.__csp?.length ?? 0;
    if (what === 'select') document.createElement('select');
    else document.createElement('div').setAttribute('style', 'color: red');
    await new Promise((r) => setTimeout(r, 200));
    return (window.__csp ?? []).slice(before);
  }, act);

test.describe('webkit 新建 select 的 CSP 误报', () => {
  test('最小复现：只 createElement(select) 不该有 CSP 违规（webkit 内核误报，标 test.fail）', async ({ page, browserName, csp }) => {
    test.fail(browserName === 'webkit', 'WebKit 内核新建 <select> 时误报 style-src-attr（待 WebKit 修复）');
    csp.expectViolations();
    await page.goto('/app/');
    expect(await violationsAfter(page, 'select')).toEqual([]);
  });

  test.describe('放过规则', () => {
    test.use({ loggedIn: true });

    test('只认 React 建 select 的那一种：webkit 下编辑页的那条被标出，setAttribute(style) 照样算违规', async ({ page, browserName, csp }) => {
      csp.expectViolations();
      await page.goto('/app/#/todo/new');
      await expect(page.getByTestId('todo-edit-due')).toBeVisible();
      await expect(page.locator('select')).not.toHaveCount(0);
      await page.waitForTimeout(300);
      const all = await csp.allViolations();
      if (browserName === 'webkit') {
        expect(all.length, '编辑页的 select 在 webkit 下报了违规').toBeGreaterThan(0);
        for (const v of all) expect(v).toMatchObject({ directive: 'style-src-attr', blocked: 'inline', webkitSelect: true });
      } else {
        expect(all).toEqual([]);
      }
      const before = (await csp.allViolations()).length;
      await violationsAfter(page, 'attr');
      const attr = (await csp.allViolations()).slice(before);
      expect(attr.length, 'setAttribute(style) 被 CSP 拦下').toBeGreaterThan(0);
      expect(attr.every((v) => v.webkitSelect !== true), '不是 select 的违规不被放过').toBe(true);
      expect((await csp.violations()).length, '它也留在判失败的那份里').toBe(attr.length);
    });
  });
});
