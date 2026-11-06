// 液态玻璃底栏在切页时的样子和点按（B2 FA-7；负责人 11-06 选方案 B，B2-动效审查-切页先出后入.md 第四批）；别的底栏用例见 b2-tabbar.spec.ts。
// • 四个页签之间互切不起 View Transition：新页直接换上，main 做一次 opacity 0→1；底栏、“＋”、液滴一直是真元素、一直实时模糊，液滴连续滑、能被下一次点按打断
// • 进出没有底栏的页（今天 → 编辑页）照旧 View Transition：圆角和阴影画在快照自己身上，组上没有阴影，只有一边有底栏时不剩空阴影壳（代码审查 M5）
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';


/** 点页签以后每一帧记一次：有没有 View Transition、页面上几个 main、main 的不透明度、液滴横向位置、底栏和“＋”的 backdrop-filter 计算值 */
const sampleAfterClick = (page: Page, name: string, ms: number) =>
  page.evaluate(
    async ({ name, ms }) => {
      const nav = document.querySelector<HTMLElement>('[data-testid="tabbar"]');
      const drop = nav?.querySelector<HTMLElement>('[class*="_drop_"]');
      const add = document.querySelector<HTMLElement>('[data-testid="tabbar-add"]');
      const rows: { t: number; vt: number; mains: number; op: number; x: number; fx: string; addFx: string; dataVt: boolean }[] = [];
      const take = (t0: number): void => {
        const main = document.querySelector('main');
        rows.push({
          t: performance.now() - t0,
          vt: document.getAnimations().filter((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')).length,
          mains: document.querySelectorAll('main').length,
          op: main ? Number(getComputedStyle(main).opacity) : -1,
          x: drop ? drop.getBoundingClientRect().x : NaN,
          fx: nav ? getComputedStyle(nav).backdropFilter : '',
          addFx: add ? getComputedStyle(add).backdropFilter : 'none-add',
          dataVt: document.documentElement.hasAttribute('data-vt'),
        });
      };
      const t0 = performance.now();
      take(t0);
      nav?.querySelector<HTMLElement>(`a[data-tab="${name}"]`)?.click();
      while (performance.now() - t0 < ms) {
        await new Promise((r) => requestAnimationFrame(r));
        take(t0);
      }
      return rows;
    },
    { name, ms },
  );

test.describe('底栏：页签互切（FA-7，方案 B）', () => {
  // 手机宽度的底栏：chromium 项目默认 1280 宽，那里是电脑版侧栏（D5，见 b2-sidebar.spec.ts）
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  test('页签互切不起 View Transition；新页淡入、两页不同时在屏上；底栏一直实时模糊；液滴连续滑', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 }); // 首屏后部分到了（实时模糊接管）
    await page.waitForTimeout(400);
    for (const [name, testid] of [['todos', 'todos'], ['calendar', 'cal'], ['today', 'today']] as const) {
      const rows = await sampleAfterClick(page, name, 700);
      await expect(page.locator(testid === 'cal' ? 'main[data-feature="calendar"]' : `[data-testid="${testid}"]`)).toBeVisible();
      expect(rows.every((r) => r.vt === 0 && !r.dataVt), `${name}：起了 View Transition`).toBe(true);
      expect(rows.every((r) => r.mains <= 1), `${name}：两页同时在屏上`).toBe(true);
      // 底栏和“＋”一直带 backdrop-filter（不进快照，实时模糊）；随手记没有“＋”
      expect(rows.every((r) => r.fx.includes('blur(')), `${name}：底栏某一帧没有 backdrop-filter ${JSON.stringify(rows.map((r) => r.fx))}`).toBe(true);
      expect(rows.every((r) => r.addFx === 'none-add' || r.addFx.includes('blur(')), `${name}：“＋”某一帧没有 backdrop-filter`).toBe(true);
      // 新页淡入：点完以后有一段 main 在 0～1 之间，最后是 1
      const after = rows.slice(1).filter((r) => r.op >= 0);
      expect(after.some((r) => r.op > 0 && r.op < 0.95), `${name}：新页没有淡入 ${JSON.stringify(after.map((r) => r.op))}`).toBe(true);
      expect(after.at(-1)?.op).toBe(1);
      // 没有空白帧：淡入跳过 opacity 0 的第一帧（motion FADE_SKIP_MS），点完以后每一帧新页都看得见
      expect(after.every((r) => r.op > 0.1), `${name}：有整页透明的一帧 ${JSON.stringify(after.map((r) => r.op))}`).toBe(true);
      // 液滴连续滑：中途至少 5 个不同的位置，每帧走的不超过总路程的一半（没有瞬移）；--ease-drop 带一点回弹，
      // 允许冲过终点再回来，但不超过总路程的 15%，也不先往反方向走
      const xs = rows.map((r) => Math.round(r.x * 10) / 10);
      const [x0, x1] = [xs[0] ?? 0, xs.at(-1) ?? 0];
      const total = Math.abs(x1 - x0);
      expect(total, `${name}：液滴没动`).toBeGreaterThan(40);
      const lo = Math.min(x0, x1) - total * 0.15;
      const hi = Math.max(x0, x1) + total * 0.15;
      expect(xs.every((x) => x >= lo && x <= hi), `${name}：液滴跑出了起点到终点之间 ${JSON.stringify(xs)}`).toBe(true);
      expect(Math.sign((xs[2] ?? x0) - x0) === Math.sign(x1 - x0), `${name}：液滴先往反方向走 ${JSON.stringify(xs)}`).toBe(true);
      // 按每帧实际时长折算成 60Hz 一帧走多少（并发跑时 webkit 会丢帧，一次隔 50 ms，不算瞬移）
      const steps = xs.slice(1).map((x, k) => ((x - (xs[k] ?? 0)) * 16.7) / Math.max(16.7, (rows[k + 1]?.t ?? 0) - (rows[k]?.t ?? 0)));
      expect(Math.max(...steps.map(Math.abs)), `${name}：液滴一帧跳了太远 ${JSON.stringify(xs)}`).toBeLessThan(total / 2);
      expect(new Set(xs).size, `${name}：液滴中途位置太少 ${JSON.stringify(xs)}`).toBeGreaterThanOrEqual(5);
    }
  });

  test('滑到一半点下一个页签：液滴从当前位置接着滑（被打断，不跳）；上一次的淡入取消，新页照样淡入', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const first = await sampleAfterClick(page, 'notes', 120);
    const second = await sampleAfterClick(page, 'calendar', 700);
    await expect(page.locator('main[data-feature="calendar"]')).toBeVisible();
    const mid = first.at(-1)?.x ?? 0;
    const start = first[0]?.x ?? 0;
    expect(mid - start, '第一次还没滑到就停了').toBeGreaterThan(5);
    // 第二次从打断那一刻的位置接着走：每一帧（按实际帧时长折算成 60Hz）都不超过 25pt，没有先跳回起点或跳到终点
    // （打断后头一两帧液滴还带着往随手记去的速度，再掉头，是 CSS 过渡从当前值重新起步，正常）
    const jump = Math.max(...second.slice(1).map((r, k) => (Math.abs(r.x - (second[k]?.x ?? 0)) * 16.7) / Math.max(16.7, r.t - (second[k]?.t ?? 0))));
    expect(jump, `打断时液滴跳了 ${JSON.stringify(second.slice(0, 6).map((r) => [Math.round(r.t), Math.round(r.x)]))}`).toBeLessThan(25);
    expect(second.every((r) => r.vt === 0)).toBe(true);
    expect(second.at(-1)?.op).toBe(1);
    expect(await page.evaluate(() => document.querySelector('main')?.getAnimations().length ?? -1)).toBe(0);
  });

  test('减少动态效果：页签互切直接换页，main 不做动画', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar')).toBeVisible(); // 底栏在页面画出来以后才挂，没挂上时点不到
    const rows = await sampleAfterClick(page, 'todos', 200);
    await expect(page.getByTestId('todos')).toBeVisible();
    expect(rows.every((r) => r.vt === 0)).toBe(true);
    expect(rows.slice(1).filter((r) => r.op >= 0).every((r) => r.op === 1), JSON.stringify(rows.map((r) => r.op))).toBe(true);
  });
});

test.describe('底栏：进出没有底栏的页照旧 View Transition（代码审查 M5）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  /** 等切页过渡出来、停在中途，读底栏几个伪元素的计算样式 */
  const holdAndRead = (page: Page) =>
    page
      .waitForFunction(
        () => {
          const vt = document.getAnimations().filter((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition'));
          for (const x of vt) {
            x.pause();
            x.currentTime = 120;
          }
          if (vt.length === 0) return null;
          const cs = (p: string) => getComputedStyle(document.documentElement, p);
          const pick = (p: string) => ({ shadow: cs(p).boxShadow, radius: cs(p).borderRadius, overflow: cs(p).overflow, opacity: cs(p).opacity });
          return { group: pick('::view-transition-group(tabbar)'), old: pick('::view-transition-old(tabbar)'), addGroup: pick('::view-transition-group(tabbar-add)'), addOld: pick('::view-transition-old(tabbar-add)') };
        },
        undefined,
        { timeout: 2000, polling: 4 },
      )
      .then((h) => h.jsonValue());
  const finishAll = (page: Page) =>
    page.evaluate(() => {
      for (const x of document.getAnimations()) if (String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')) x.finish();
    });

  test('今天 → 新建日程（只有旧的一边有底栏）：组上没有阴影，旧快照自己裁圆角、补阴影', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await page.getByTestId('tabbar-add').click({ noWaitAfter: true });
    const s = await holdAndRead(page);
    expect(s, '没等到切页过渡').not.toBeNull();
    expect(s?.group.shadow, '组上有阴影（只有一边有底栏时会剩空壳）').toBe('none');
    expect(s?.addGroup.shadow).toBe('none');
    expect(s?.old.shadow).not.toBe('none');
    expect(s?.old.overflow).toBe('clip');
    expect(s?.old.radius).not.toBe('0px');
    expect(s?.addOld.radius).toBe('50%');
    await finishAll(page);
    await expect(page).toHaveURL(/#\/event\/new$/);
  });

  test('键盘弹着（data-kb）时底栏不进快照：没有 view-transition-name，不会画出空阴影壳', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-add')).toBeVisible();
    const names = await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>('[data-testid="tabbar"],[data-testid="tabbar-add"]')];
      for (const el of els) el.setAttribute('data-kb', '1');
      const v = els.map((el) => getComputedStyle(el).viewTransitionName);
      for (const el of els) el.removeAttribute('data-kb');
      return { hidden: v, shown: els.map((el) => getComputedStyle(el).viewTransitionName) };
    });
    expect(names.hidden).toEqual(['none', 'none']);
    expect(names.shown).toEqual(['tabbar', 'tabbar-add']);
  });
});
