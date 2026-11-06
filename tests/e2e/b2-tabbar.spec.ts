// 液态玻璃底栏（B2 FA-7；负责人 11-05 ①～④；接手清单 NAV-today-no-settings、UI4-B1-C2）：
// 今天、日历、待办、随手记四页都有底栏，点页签换页、选中项跟着走；“＋”按页新建（今天、日历→日程，待办→待办），随手记没有“＋”、只写“即将推出”；
// 今天页右上角头像进设置；切页动画期间点按不被吞（::view-transition 不接点按）；底栏切页时不跟着淡入淡出
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const bar = (page: Page) => page.getByTestId('tabbar');
const tab = (page: Page, name: string) => bar(page).locator(`a[data-tab="${name}"]`);

test.describe('底栏（FA-7）', () => {
  // 手机宽度的底栏：chromium 项目默认 1280 宽，那里是电脑版侧栏（D5，见 b2-sidebar.spec.ts）
  // timezoneId：“今天页“＋”还是今天”那条在浏览器里按本机时区算“今天”，CI 是 UTC、账号数据按首尔日期（前端 A 11-07 查明的同类问题），统一按首尔
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('四页之间点页签切换；选中项 aria-current 跟着走；“＋”按页新建；随手记“即将推出”、没有“＋”', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(bar(page)).toBeVisible();
    await expect(tab(page, 'today')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('tabbar-add')).toHaveAccessibleName('新建日程');

    await tab(page, 'calendar').click();
    await expect(page).toHaveURL(/#\/calendar$/);
    await expect(tab(page, 'calendar')).toHaveAttribute('aria-current', 'page');
    await expect(tab(page, 'today')).not.toHaveAttribute('aria-current', 'page');

    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await expect(page.getByTestId('todos-new')).toHaveCount(0); // 右上角原来的“＋ 新建”去掉了
    await expect(page.getByTestId('tabbar-add')).toHaveAccessibleName('新建待办');

    await tab(page, 'notes').click();
    await expect(page.getByText('即将推出')).toBeVisible();
    await expect(tab(page, 'notes')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('tabbar-add')).toHaveCount(0);
  });

  // webkit 进编辑页会报一条 CSP style-src-attr：是 WebKit 内核新建 <select> 时的误报（直接打开 #/todo/new 也报，11-05 前端 A 查明），
  // csp-fixture.ts 只对 webkit 精确放过这一种，别的违规照样判失败；最小复现见 csp-webkit-select.spec.ts（test.fail）
  test('“＋”：待办页新建待办、今天页新建日程；编辑页没有底栏', async ({ page }) => {
    await page.goto('/app/#/todos');
    await expect(page.getByTestId('todos')).toBeVisible();
    await page.getByTestId('tabbar-add').click();
    await expect(page).toHaveURL(/#\/todo\/new$/);
    await expect(bar(page)).toHaveCount(0);
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await page.getByTestId('tabbar-add').click();
    await expect(page).toHaveURL(/#\/event\/new$/);
  });

  test('日历页“＋”带上选中的那天；今天页“＋”还是今天（FA-7 第 5 项）', async ({ page }) => {
    await page.goto('/app/#/calendar');
    // 只在日历页 main 里找：底栏的内容副本（data-glass-layer，在 nav 里）会复制出同样的日期按钮，inert 只写在副本层上、按钮本身没有（代码复审 L11）；
    // 同一天在 main 里也可能有几个（月历相邻几页），取看得见的第一个
    const cal = page.locator('main[data-feature="calendar"]');
    await expect(cal).toBeVisible();
    const day = (await cal.locator('button[data-date]:not([aria-pressed="true"]):not([inert])').nth(10).getAttribute('data-date')) ?? '';
    const cell = cal.locator(`button[data-date="${day}"]:not([inert])`).first();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await cell.click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('tabbar-add').click();
    await expect(page).toHaveURL(/#\/event\/new$/);
    await expect(page.getByTestId('event-edit-date')).toHaveValue(day);
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    const today = await page.evaluate(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
    await page.getByTestId('tabbar-add').click();
    await expect(page.getByTestId('event-edit-date')).toHaveValue(today);
  });

  test('今天页右上角头像进设置（NAV-today-no-settings）', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today-settings').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.locator('main[data-feature="settings"]')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
  });

  test('切页动画期间点按不被吞（UI4-B1-C2）：点日历后马上点待办，落在待办', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    // 规则本身在不在：读已加载的样式表（不往页面里插样式，CSP 不放行）
    const pe = await page.evaluate(() =>
      [...document.styleSheets].some((s) => {
        try {
          return [...s.cssRules].some((r) => /::view-transition\s*\{[^}]*pointer-events:\s*none/.test(r.cssText));
        } catch {
          return false;
        }
      }),
    );
    expect(pe, '::view-transition { pointer-events: none } 在样式表里').toBe(true);
    await tab(page, 'calendar').click();
    await tab(page, 'todos').click({ timeout: 2000 });
    await expect(page).toHaveURL(/#\/todos$/);
    await expect(page.getByTestId('todos')).toBeVisible();
  });

  // 设计动效评审 D1：底栏原来和页面同一个 Suspense，切到分包没到的页（webkit 每次都是）时整条被 React 藏掉（display:none）、液滴晚 0.3 秒才动。
  // 冷启动以后第一次进待办、日历（分包都没下过），每 16ms 采一次：底栏和“＋”每一帧都看得见、宽度不为 0；液滴的 --i 点下去 100ms 内就变
  // 采样按时间和次数两头算（代码审查 L13）：至少采满 900ms、而且至少 21 次才停；机器忙时定时器被拖慢，就多采一会儿（最多 5 秒）
  test('切页过程中底栏一直看得见；液滴点下去就走，不等页面（设计动效评审 D1）', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(bar(page)).toBeVisible();
    for (const [name, i] of [['todos', '2'], ['calendar', '1'], ['today', '0']] as const) {
      await page.evaluate(() => {
        const w = window as unknown as { __tb: { t: number; nav: boolean; add: boolean; i: string }[]; __tbT0: number; __tbDown: number };
        w.__tb = [];
        w.__tbT0 = performance.now();
        w.__tbDown = -1;
        // 从页面真正收到按下算起（Playwright 点之前还要等元素稳定，那段不算）
        document.addEventListener('pointerdown', () => (w.__tbDown = performance.now() - w.__tbT0), { capture: true, once: true });
        const seen = (el: Element | null): boolean => el instanceof HTMLElement && el.checkVisibility() && el.getBoundingClientRect().width > 0;
        const id = setInterval(() => {
          const nav = document.querySelector('[data-testid="tabbar"]');
          const drop = nav?.querySelector('[style*="--i"]') as HTMLElement | null | undefined;
          w.__tb.push({
            t: performance.now() - w.__tbT0,
            nav: seen(nav),
            add: seen(document.querySelector('[data-testid="tabbar-add"]')),
            i: drop?.style.getPropertyValue('--i') ?? '',
          });
          const t = performance.now() - w.__tbT0;
          if ((t > 900 && w.__tb.length > 20) || t > 5000) clearInterval(id);
        }, 16);
      });
      await tab(page, name).click();
      await page.waitForFunction(() => {
        const tb = (window as unknown as { __tb: { t: number }[] }).__tb;
        const t = tb.at(-1)?.t ?? 0;
        return (t > 900 && tb.length > 20) || t > 5000;
      }, undefined, { timeout: 8000 });
      const { got, down } = await page.evaluate(() => {
        const w = window as unknown as { __tb: { t: number; nav: boolean; add: boolean; i: string }[]; __tbDown: number };
        return { got: w.__tb, down: w.__tbDown };
      });
      expect(down, `${name}：没收到按下`).toBeGreaterThanOrEqual(0);
      expect(got.length, `${name}：采样太少`).toBeGreaterThan(20);
      expect(got.filter((f) => !f.nav).map((f) => Math.round(f.t)), `${name}：这些时刻底栏看不见`).toEqual([]);
      expect(got.filter((f) => !f.add).map((f) => Math.round(f.t)), `${name}：这些时刻“＋”看不见`).toEqual([]);
      const moved = got.find((f) => f.i === i);
      expect(moved, `${name}：液滴一直没到 --i=${i}`).toBeDefined();
      // 按下之前就算“看得见”的帧也在上面查过了；液滴的时间从按下算
      const lag = (moved?.t ?? Infinity) - down;
      expect(lag, `${name}：按下以后 ${Math.round(lag)}ms 液滴才动`).toBeLessThan(100);
      await expect(page).toHaveURL(new RegExp(`#/${name}$`));
    }
  });

  // 设计动效评审 L1：首屏后部分（GlassBarFx，首屏画完以后下载；模糊带出现说明到了）到了以后，果冻由 WAAPI 放，
  // 连点时从当前形变接着放、不重挂元素（重挂会跳回原样）
  test('果冻：首屏后部分到了以后由 WAAPI 放；连点不重挂、不叠动画（L1）', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await expect(bar(page).locator('[class*="jellyJs"]')).toHaveCount(1);
    await page.evaluate(() => {
      (window as unknown as { __jelly: Element | null }).__jelly = document.querySelector('[data-testid="tabbar"] [class*="jellyJs"]');
    });
    await tab(page, 'calendar').click();
    await tab(page, 'todos').click();
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tabbar"] [class*="jellyJs"]');
      return { same: el === (window as unknown as { __jelly: Element | null }).__jelly, running: el?.getAnimations().length ?? -1 };
    });
    expect(r.same, '连点以后还是同一个元素').toBe(true);
    expect(r.running, '只有一个果冻动画在跑').toBe(1);
  });

  test('从没有底栏的页回来（新建日程 → 今天）：实色带和底栏同一次出现，第一帧起就不透明、不淡入（G2；主持人 11-07 复查）', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    const band = page.getByTestId('tabbar-band');
    await expect(band).toBeAttached({ timeout: 10_000 });
    // 启动那一次的淡入放完
    await expect.poll(() => band.evaluate((el) => (el.getAnimations().length === 0 ? Number(getComputedStyle(el).opacity) : -1)), { timeout: 5000 }).toBe(1);
    await page.getByTestId('tabbar-add').click();
    await expect(page).toHaveURL(/#\/event\/new$/);
    await expect(bar(page)).toHaveCount(0);
    await expect(band).toHaveCount(0);
    // 底栏一挂上就记：那一刻实色带在不在；之后逐帧记实色带、渐隐层的不透明度和正在跑的 opacity 过渡
    await page.evaluate(() => {
      type Row = { band: boolean; op: number; edgeOp: number; fades: number };
      const w = window as unknown as { zzRemount: { atMount: boolean | null; rows: Row[] } };
      w.zzRemount = { atMount: null, rows: [] };
      const rec = w.zzRemount;
      const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      const fades = (el: HTMLElement | null): number => (el ? el.getAnimations().filter((a) => (a as CSSTransition).transitionProperty === 'opacity').length : 0);
      const mo = new MutationObserver(() => {
        if (rec.atMount !== null || !q('tabbar')) return;
        rec.atMount = q('tabbar-band') !== null;
        mo.disconnect();
        const frame = (): void => {
          const b = q('tabbar-band');
          const e = q('tabbar-edge');
          rec.rows.push({ band: b !== null, op: b ? Number(getComputedStyle(b).opacity) : -1, edgeOp: e ? Number(getComputedStyle(e).opacity) : -1, fades: fades(b) + fades(e) });
          if (rec.rows.length < 20) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    });
    await page.goBack();
    await expect(page.getByTestId('today')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { zzRemount: { rows: unknown[] } }).zzRemount.rows.length), { timeout: 5000 }).toBe(20);
    const rec = await page.evaluate(() => (window as unknown as { zzRemount: { atMount: boolean | null; rows: { band: boolean; op: number; edgeOp: number; fades: number }[] } }).zzRemount);
    expect.soft(rec.atMount, '底栏挂上那一刻实色带还没在（重挂时又去异步下载首屏后部分）').toBe(true);
    expect(rec.rows.every((r) => r.band && r.op === 1 && r.edgeOp === 1 && r.fades === 0), `重挂后实色带、渐隐层不是一直不透明 ${JSON.stringify(rec.rows)}`).toBe(true);
  });

  test('底栏样式：固定在底部、有切页名字 tabbar；页签触控区够高', async ({ page }) => {
    await page.goto('/app/#/today');
    const box = await bar(page).boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(vh - 120);
    expect(await bar(page).evaluate((el) => getComputedStyle(el).viewTransitionName)).toBe('tabbar');
    const t = await tab(page, 'today').boundingBox();
    expect(t?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

