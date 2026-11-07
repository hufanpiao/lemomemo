// WebKit 新建 <select> 时报 CSP style-src-attr 的误报（11-05 查明；B2-代码审查-FA7底栏外壳.md 第四节；
// bug 草稿 docs/03-评审/B2/B2-WebKit-bug草稿-select-CSP误报.md）。CSP 不放宽，csp-fixture.ts 只对 webkit 精确放过这一种。
// • 最小复现：在带本站 CSP 的页面里只 createElement('select')，不挂进文档。WebKit 报一条，Chromium 不报。
//   这里读的是没经过配对的原始违规（window.__csp），所以不受 fixture 放过规则影响，用 expectViolations 自己判
//   webkit 下标 test.fail：哪天 WebKit 修好了，这条会变红，那时去掉 fixture 里的放过规则。
// • 放过规则本身：建 select 的那条被标成 webkitSelect；别的内联样式违规（setAttribute('style')）不被标，照样判失败
import type { Page } from '@playwright/test';
import { CARRY_KEY, consoleRest } from './csp-fixture.ts';
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

    // 整条用例累计（11-07，csp-fixture.ts 文件头）：先待办编辑页、再整页载入日程编辑页，两个文档都建 select。
    // 原来计数每个文档从 0 重数，前一页的报错没有 select 抵，收尾判失败（hit-target 的 webkit 用例就是这样挂的）
    // 测试自己再挂一层只数“本文档”的计数（注册在 fixture 之后，包在它外面，建 select 时两边都加一）：
    // __zzCarried 是本文档一开头从前一个文档接过来的累计数，__zzDoc 是本文档自己建的个数
    const B_URL = '/app/?csp-doc=b#/event/new'; // 查询串不同：整页载入新文档（不是只改 hash）
    const docCounter = async (page: Page): Promise<void> => {
      await page.addInitScript(() => {
        const w = window as unknown as { __zzCarried: number; __zzDoc: number; __zzPersisted: boolean; __cspSelects?: number };
        w.__zzCarried = w.__cspSelects ?? 0;
        w.__zzDoc = 0;
        w.__zzPersisted = false;
        const ce = Document.prototype.createElement;
        Document.prototype.createElement = function (this: Document, tag: string, opts?: ElementCreationOptions) {
          if (String(tag).toLowerCase() === 'select') w.__zzDoc += 1;
          return ce.call(this, tag, opts) as HTMLElement;
        } as typeof Document.prototype.createElement;
        addEventListener('pageshow', (e) => {
          if (e.persisted) w.__zzPersisted = true;
        });
      });
    };
    const docState = (page: Page) =>
      page.evaluate(() => {
        const w = window as unknown as { __zzCarried: number; __zzDoc: number; __zzPersisted: boolean };
        return { carried: w.__zzCarried, doc: w.__zzDoc, persisted: w.__zzPersisted };
      });
    const pageA = async (page: Page): Promise<void> => {
      await page.goto('/app/#/todo/new');
      await expect(page.getByTestId('todo-edit-due')).toBeVisible();
      await expect(page.locator('select')).not.toHaveCount(0);
      await page.waitForTimeout(300);
    };
    const pageB = async (page: Page): Promise<void> => {
      await page.goto(B_URL);
      await expect(page.getByTestId('event-edit-tz')).toBeVisible();
      await page.waitForTimeout(300);
    };

    test('一条用例连进两个带 select 的页面：不误报（select 个数、违规事件整条用例累计）', async ({ page, browserName, csp }) => {
      await docCounter(page);
      await pageA(page);
      const a = await docState(page);
      await pageB(page);
      const b = await docState(page);
      if (browserName === 'webkit') {
        expect(a.carried, '第一个文档前面没有别的文档').toBe(0);
        expect(a.doc, '第一页建了 select').toBeGreaterThan(0);
        expect(b.doc, '第二页自己也建了 select').toBeGreaterThan(0);
        expect(b.carried, '第二页一开头接过来的就是第一页建的个数').toBe(a.doc);
        expect(await csp.selects(), '累计数 = 第一页 + 第二页单独数出的个数').toBe(a.doc + b.doc);
        const all = await csp.allViolations();
        expect(all.length, '两页的违规事件都在（一个 select 一条）').toBe(a.doc + b.doc);
        for (const v of all) expect(v).toMatchObject({ directive: 'style-src-attr', blocked: 'inline', webkitSelect: true });
      } else {
        expect(await csp.selects(), 'chromium 不计数').toBe(0);
      }
      expect(await csp.violations()).toEqual([]);
      expect(consoleRest(csp.consoleErrors, await csp.selects()), '控制台报错都被 select 抵掉').toEqual([]);
      // 不调 expectViolations：收尾时 fixture 自己再判一次（那一路才是这次修的地方）
    });

    test('后退缓存：A → B → 后退回 A，累计数不倒退、不误报（不管 A 是从后退缓存恢复还是重新载入）', async ({ page, browserName, csp }) => {
      await docCounter(page);
      await pageA(page);
      await pageB(page);
      const beforeBack = await csp.selects();
      await page.goBack();
      await expect(page.getByTestId('todo-edit-due')).toBeVisible();
      await page.waitForTimeout(300);
      const back = await docState(page);
      test.info().annotations.push({ type: '后退方式', description: back.persisted ? '后退缓存恢复（pageshow persisted）' : '重新载入' });
      if (browserName === 'webkit') {
        expect(beforeBack, 'A、B 两页都建了 select').toBeGreaterThan(0);
        // 恢复：pageshow 读回 B 离开时存的累计数，正好相等；重新载入：接着累计，再加上 A 重建的
        if (back.persisted) expect(await csp.selects()).toBe(beforeBack);
        else expect(await csp.selects()).toBe(beforeBack + back.doc);
      }
      expect(await csp.violations()).toEqual([]);
      expect(consoleRest(csp.consoleErrors, await csp.selects()), '控制台报错都被 select 抵掉').toEqual([]);
    });

    // Playwright 里后退实际都是重新载入（上一条的“后退方式”注记两档都是“重新载入”），恢复那条分支真跑覆盖不到，这里直接派发
    // pageshow（persisted: true）：放好“离开 B 时存下的累计数”，看 A 是否原样读回、读完删掉存档
    test('后退缓存恢复那条分支：pageshow persisted 时读回累计数（模拟）', async ({ page, csp }) => {
      await pageA(page);
      const now = await csp.selects();
      const r = await page.evaluate(
        ([key, n]) => {
          sessionStorage.setItem(key, JSON.stringify({ selects: n, list: window.__csp ?? [], own: window.__cspOwn ?? '' }));
          dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          return { selects: window.__cspSelects ?? 0, left: sessionStorage.getItem(key) };
        },
        [CARRY_KEY, now + 3] as const,
      );
      expect(r.selects, '读回存档里的累计数').toBe(now + 3);
      expect(r.left, '读完删掉存档').toBeNull();
    });

    test('多一条真违规仍然报：在第一页加一条内联样式违规，进第二页以后事件、控制台两路都还在', async ({ page, csp }) => {
      csp.expectViolations();
      await page.goto('/app/#/todo/new');
      await expect(page.getByTestId('todo-edit-due')).toBeVisible();
      await violationsAfter(page, 'attr');
      await pageB(page);
      const bad = await csp.violations();
      expect(bad.length, '第一页那条真违规（事件）跨页面后仍在判失败的那份里').toBe(1);
      expect(bad[0]).toMatchObject({ directive: 'style-src-attr', blocked: 'inline' });
      expect(bad[0]?.webkitSelect).not.toBe(true);
      expect(consoleRest(csp.consoleErrors, await csp.selects()).length, '控制台多出的那一条没被 select 抵掉').toBe(1);
    });
  });
});
