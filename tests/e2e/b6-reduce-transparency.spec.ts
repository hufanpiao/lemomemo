// 减少透明效果只有一处判断（皮肤字体整块评审 11-14 第 1、6 条；R-84、R-93；ADR-008 实现说明）在真浏览器里：
// platform/look.ts 把“系统设置了 prefers-reduced-transparency: reduce”写成 <html data-rt="1">，CSS 只认这个属性
// （设置里原来的开关 11-14 负责人要求去掉）。
// 三种情况各看六样浮层是不是实色（自己和子孙、::before / ::after 都没有 backdrop-filter）：
//   底栏、打字条、撤销提示条、同步提示卡（真页面里调出来）；提醒横幅、随手记错误条（造数据代价大：从已加载的构建样式里取这两个部件的
//   真类名挂一个探针元素，测的是同一条规则）。
// ① 设置里没有开关；② 系统设置了 reduce → 全部实色（只有 Chromium 能模拟这条媒体查询，WebKit 跳过）；③ 系统没设置 → 磨砂。
// ④ 月历：系统设置了 reduce 时节假日和平时同一种斜纹画法，选中的假日格底色是 --panel-2（R-432 评审第 11 条；只 Chromium）。
// 系统“减少动态效果”同样并进 data-rm（Playwright 的 reducedMotion 两种浏览器都能模拟）。
// 评审截图同别处（page-helpers.ts 的 shot）：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（WebKit 不画模糊）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { putGoneTodo } from './idb.ts';
import { afterPageFade, shot, swipeRow } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 390, height: 844 } });

const TZ = 'Asia/Seoul';
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, undone: false, short: null, project: '', due_time: null, done: false };
const attr = (page: Page, name: string) => page.evaluate((n) => document.documentElement.getAttribute(n), name);
const go = (page: Page, hash: string) =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

/** 本机库：g1 在服务器上已删、outbox 有它的 gone 项（出同步提示卡）；n1 普通待办（删它出撤销条）。同 b2-sync-notice.spec.ts */
async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await putGoneTodo(page, base, today(), '0e2e0000-0000-4000-8000-0000000000b6');
  await page.reload();
  await page.getByTestId('todos-row-n1').waitFor({ timeout: 30000 });
}

/** 把六样浮层都调出来：随手记页走一趟（加载它的样式），回待办页删 n1 出撤销条、点“＋”出打字条 */
async function showAll(page: Page): Promise<void> {
  await go(page, '#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30000 });
  await go(page, '#/todos');
  await page.getByTestId('todos-row-n1').waitFor({ timeout: 30000 });
  await expect(page.getByTestId('sync-notice-card')).toBeVisible({ timeout: 15000 });
  // 页签互切后 FADE_GUARD_MS 以内落在 main 里的点按按设计吞掉（motion/index.ts 的 guardTaps；11-14 运行日志 route 1.63 → click 1.70，
  // 推进计划 7b 查明，见 b6-tab-switch-tap.spec.ts）：新页已经出来，等换页放完（afterPageFade，窗口一定过了）再点
  await afterPageFade(page);
  await swipeRow(page, 'todos-row-n1');   // 左滑拉到底删（负责人 11-15 去掉 ×）
  await expect(page.locator('[data-undo-toast]')).toBeVisible();
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-bar')).toBeVisible();
  // 进场动画、样式分包都到位
  await page.waitForTimeout(500);
}

type Look = Record<'tabbar' | 'typeBar' | 'undo' | 'sync' | 'remind' | 'notesError', boolean | null>;

/**
 * 构建后的模块类名是 _<本地名>_<哈希>_<行号>，行号是 .<本地名> 在源文件里第一次出现的那一行（postcss-modules 默认的
 * generateScopedName：css.indexOf('.' + 本地名) 之前有几行；注释里先提到也算）。
 * 探针按“本地名 + 行号”在所有已加载的样式表里找，不认样式块的文件名：打包把 NotesPage.module.css 并进
 * NoteDrawer-*.css 以后，按文件名找就找不到了（11-15 ci 2e5b1791 失败）
 */
function ruleLine(file: string, local: string): number {
  const css = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
  const at = css.search(new RegExp(`\\.${local}(?![\\w-])`));
  if (at < 0) throw new Error(`${file} 里没有 .${local}`);
  return css.slice(0, at).split('\n').length;
}

/** 浮条的宽度、磨砂、减少透明兜底在 kit 公共浮条（外观四项统一，负责人 11-25 选“全部统一”）：组件上和自己的类一起挂，探针也一起挂 */
const FLOAT = 'src/kit/components/Float.module.css';

/** 每样浮层有没有模糊（true 磨砂、false 实色、null 找不到）；提醒横幅、随手记错误条用探针（自己的类 + 组件上一起挂的公共浮条类） */
function frosted(page: Page): Promise<Look> {
  const probes = {
    remind: [
      { local: 'banner', line: ruleLine('src/features/reminders/ui/Remind.module.css', 'banner') },
      { local: 'float', line: ruleLine(FLOAT, 'float') },
    ],
    notesError: [
      { local: 'error', line: ruleLine('src/features/notes/ui/NotesPage.module.css', 'error') },
      { local: 'glass', line: ruleLine(FLOAT, 'glass') },
    ],
  };
  return page.evaluate((probes) => {
    const fx = (e: Element, p?: string): string => {
      const s = getComputedStyle(e, p) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
      return s.backdropFilter || s.webkitBackdropFilter || 'none';
    };
    const blurred = (root: Element | null): boolean | null => {
      if (!root) return null;
      return [root, ...root.querySelectorAll('*')].some((e) => [undefined, '::before', '::after'].some((p) => fx(e, p) !== 'none'));
    };
    /** 每个类在所有样式表里找 ._本地名_哈希_行号（选择器列表拆开逐个比），挂一个带这些类名的探针；有一个找不到或对上不止一个类名都算 null */
    const probe = (want: { local: string; line: number }[]): boolean | null => {
      const found: string[] = [];
      for (const { local, line } of want) {
        const re = new RegExp(`^\\._${local}_[A-Za-z0-9-]+_${line}$`);
        const names = new Set<string>();
        for (const sh of [...document.styleSheets]) {
          for (const r of [...sh.cssRules]) {
            for (const sel of ((r as CSSStyleRule).selectorText ?? '').split(',').map((s) => s.trim())) if (re.test(sel)) names.add(sel.slice(1));
          }
        }
        if (names.size !== 1) return null;
        found.push([...names][0] ?? '');
      }
      const el = document.createElement('div');
      el.className = found.join(' ');
      el.dataset['probe'] = '1';
      document.body.append(el);
      const v = blurred(el);
      el.remove();
      return v;
    };
    return {
      tabbar: blurred(document.querySelector('[data-testid="tabbar"]')),
      typeBar: blurred(document.querySelector('[data-testid="type-bar"]')),
      undo: blurred(document.querySelector('[data-undo-toast]')),
      sync: blurred(document.querySelector('[data-testid="sync-notice-card"]')),
      remind: probe(probes.remind),
      notesError: probe(probes.notesError),
    };
  }, probes);
}

const all = (v: boolean): Look => ({ tabbar: v, typeBar: v, undo: v, sync: v, remind: v, notesError: v });

test.describe('减少透明效果：跟系统设置，六样浮层都变实色', () => {
  test('① 设置里没有“减少透明效果”开关（11-14 去掉）', async ({ page }) => {
    await seed(page);
    await go(page, '#/settings');
    await page.getByTestId('settings-skin-entry').waitFor({ timeout: 30000 });
    await expect(page.getByTestId('settings-rt')).toHaveCount(0);
    await expect(page.getByTestId('settings-rm')).toHaveCount(0);
  });

  test('② 开关关着、系统设置了 reduce（Chromium 模拟媒体查询）：data-rt=1，全部实色', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit 不能模拟 prefers-reduced-transparency');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await seed(page);
    await expect.poll(() => attr(page, 'data-rt')).toBe('1');
    await showAll(page);
    expect(await frosted(page)).toEqual(all(false));
    await shot(page, browserName, 'rt-system', { settleMs: 0 });
    // 系统改回来：跟着变回磨砂（不用重新打开 App）
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
    await expect.poll(() => attr(page, 'data-rt')).toBeNull();
    expect((await frosted(page)).tabbar).toBe(true);
  });

  test('③ 两者都没有：磨砂', async ({ page, browserName }) => {
    await seed(page);
    expect(await attr(page, 'data-rt')).toBeNull();
    await showAll(page);
    expect(await frosted(page)).toEqual(all(true));
    await shot(page, browserName, 'rt-off', { settleMs: 0 });
  });
});

test.describe('减少透明效果：月历选中的假日格（R-432 评审第 11 条）', () => {
  // R-445：选中不再整格换底，格子照旧是格子底（--cal-cell），只把日期数字换成深色小方块（--cal-sel-bg）
  test('系统设置了 reduce：节假日和别的格子同一种画法，斜纹还在，选中只换日期小方块', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit 不能模拟 prefers-reduced-transparency');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await page.clock.setFixedTime(new Date('2026-10-10T12:00:00+09:00'));
    await page.goto('/app/#/cal/month/2026-10');
    await page.getByTestId('cal-month').waitFor({ timeout: 30000 });
    await expect.poll(() => attr(page, 'data-rt')).toBe('1');
    const cell = page.locator('[data-testid="cal-month"] button[data-date="2026-10-01"]');
    await expect(cell).toContainText('国庆节', { timeout: 10_000 });
    await cell.click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    const got = await cell.evaluate((c) => {
      // 用探针元素把令牌换算成浏览器里的颜色（探针放在格子里，令牌按格子所在的皮肤取值）
      const probe = (v: string): string => {
        const p = document.createElement('div');
        p.style.background = `var(${v})`;
        c.append(p);
        const got = getComputedStyle(p).backgroundColor;
        p.remove();
        return got;
      };
      const num = c.querySelector<HTMLElement>(':scope > span > span');
      const before = getComputedStyle(c, '::before');
      return {
        bg: getComputedStyle(c).backgroundColor,
        cell: probe('--cal-cell'),
        num: num ? getComputedStyle(num).backgroundColor : '',
        sel: probe('--cal-sel-bg'),
        stripe: before.content !== 'none' && before.backgroundImage.includes('gradient'),
      };
    });
    expect(got.bg, '选中的假日格底色照旧是格子底').toBe(got.cell);
    expect(got.num, '选中日的日期数字是深色小方块').toBe(got.sel);
    expect(got.stripe, '斜纹还在').toBe(true);
    await shot(page, browserName, 'rt-cal-holiday-sel', { settleMs: 0 });
  });
});

test.describe('减少动态效果：系统设置并进 data-rm', () => {
  test.use({ reducedMotion: 'reduce' });
  test('开关关着、系统设置了 reduce：data-rm=1', async ({ page }) => {
    await page.goto('/app/#/today');
    await page.getByTestId('today').waitFor({ timeout: 30000 });
    await expect.poll(() => attr(page, 'data-rm')).toBe('1');
    expect(await attr(page, 'data-rt')).toBeNull();
  });
});
