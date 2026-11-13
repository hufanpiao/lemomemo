// 减少透明效果只有一处判断（皮肤字体整块评审 11-14 第 1、6 条；R-84、R-93；ADR-008 实现说明）在真浏览器里：
// platform/look.ts 把“设置里的开关打开 或 系统设置了 prefers-reduced-transparency: reduce”写成 <html data-rt="1">，CSS 只认这个属性。
// 三种情况各看六样浮层是不是实色（自己和子孙、::before / ::after 都没有 backdrop-filter）：
//   底栏、打字条、撤销提示条、同步提示卡（真页面里调出来）；提醒横幅、随手记错误条（造数据代价大：从已加载的构建样式里取这两个部件的
//   真类名挂一个探针元素，测的是同一条规则）。
// ① 开关打开 → 全部实色；② 开关关着、系统设置了 reduce → 全部实色（只有 Chromium 能模拟这条媒体查询，WebKit 跳过）；③ 两者都没有 → 磨砂。
// 系统“减少动态效果”同样并进 data-rm（Playwright 的 reducedMotion 两种浏览器都能模拟）。
// 截图只在 Chromium 截（WebKit 不画模糊），存在 test-results 里
import type { Page, TestInfo } from '@playwright/test';
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
  const due = today();
  await page.evaluate(
    async ({ due, base }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('planner-v4');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(['todos', 'outbox'], 'readwrite');
      const g1 = { ...base, id: 'g1', title: '交周报', due, rev: 3, deleted_at: Date.now() - 60000 };
      const n1 = { ...base, id: 'n1', title: '买牛奶', due, rev: 1, deleted_at: null };
      tx.objectStore('todos').put({ id: 'g1', server: g1, view: g1 });
      tx.objectStore('todos').put({ id: 'n1', server: n1, view: n1 });
      tx.objectStore('outbox').put({
        op_id: '0e2e0000-0000-4000-8000-0000000000b6', table: 'todos', id: 'g1', rec: 'todos:g1', op: 'patch', data: { title: '交周报（改）' },
        base_rev: 2, own_revs: [], client_ts: Date.now() - 120000, tries: 0, next_at: 0, state: 'failed', v: 1, app: '4.0.0', seq: 1,
        remind: false, deps: [], error: 'gone', sent: true,
      });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    { due, base },
  );
  await page.reload();
  await page.getByTestId('todos-row-n1').waitFor({ timeout: 30000 });
}

/** 等切到 hash 这一页落定：运行日志（localStorage lemo-run-log，写入有延迟）里最后一条 route 是它，且后面有 settled(…)
 *  （连着切两页时只记一条落定，原因可能写成 focusout 等，不一定是 route） */
async function settled(page: Page, hash: string): Promise<void> {
  await page.waitForFunction((h) => {
    const log = localStorage.getItem('lemo-run-log') ?? '';
    const route = [...log.matchAll(/ route (#\/\S+)/g)].at(-1);
    return route?.[1] === h && log.indexOf('settled(', route.index) > route.index;
  }, hash);
}

/** 把六样浮层都调出来：随手记页走一趟（加载它的样式），回待办页删 n1 出撤销条、点“＋”出打字条 */
async function showAll(page: Page): Promise<void> {
  await go(page, '#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30000 });
  await settled(page, '#/notes');
  await go(page, '#/todos');
  await page.getByTestId('todos-row-n1').waitFor({ timeout: 30000 });
  await expect(page.getByTestId('sync-notice-card')).toBeVisible({ timeout: 15000 });
  // 11-14 运行日志实测：Chromium 切页没落定（route 1.63 → click 1.70 → settled 2.04）时点的删除不生效，所以等落定再点
  await settled(page, '#/todos');
  await page.getByTestId('todos-del-n1').click();
  await expect(page.locator('[data-undo-toast]')).toBeVisible();
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-bar')).toBeVisible();
  // 进场动画、样式分包都到位
  await page.waitForTimeout(500);
}

type Look = Record<'tabbar' | 'typeBar' | 'undo' | 'sync' | 'remind' | 'notesError', boolean | null>;

/** 每样浮层有没有模糊（true 磨砂、false 实色、null 找不到）；提醒横幅、随手记错误条用探针 */
function frosted(page: Page): Promise<Look> {
  return page.evaluate(() => {
    const fx = (e: Element, p?: string): string => {
      const s = getComputedStyle(e, p) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
      return s.backdropFilter || s.webkitBackdropFilter || 'none';
    };
    const blurred = (root: Element | null): boolean | null => {
      if (!root) return null;
      return [root, ...root.querySelectorAll('*')].some((e) => [undefined, '::before', '::after'].some((p) => fx(e, p) !== 'none'));
    };
    /** 构建后的模块类名是 _<本地名>_<哈希>_<行号>：在文件名以 chunk 开头的样式表里找到 .本地名 那条规则，挂一个同类名的探针 */
    const probe = (chunk: string, local: string): boolean | null => {
      const re = new RegExp(`^\\._${local}_[A-Za-z0-9-]+_\\d+$`);
      for (const sh of [...document.styleSheets]) {
        if (!sh.href?.includes(`/${chunk}-`)) continue;
        for (const r of [...sh.cssRules]) {
          const sel = (r as CSSStyleRule).selectorText ?? '';
          if (!re.test(sel)) continue;
          const el = document.createElement('div');
          el.className = sel.slice(1);
          el.dataset['probe'] = '1';
          document.body.append(el);
          const v = blurred(el);
          el.remove();
          return v;
        }
      }
      return null;
    };
    return {
      tabbar: blurred(document.querySelector('[data-testid="tabbar"]')),
      typeBar: blurred(document.querySelector('[data-testid="type-bar"]')),
      undo: blurred(document.querySelector('[data-undo-toast]')),
      sync: blurred(document.querySelector('[data-testid="sync-notice-card"]')),
      remind: probe('Remind', 'banner'),
      notesError: probe('NotesPage', 'error'),
    };
  });
}

const all = (v: boolean): Look => ({ tabbar: v, typeBar: v, undo: v, sync: v, remind: v, notesError: v });

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  if (info.project.name.includes('chromium')) await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

test.describe('减少透明效果：开关 或 系统设置，六样浮层都变实色', () => {
  test('① 开关打开：全部实色', async ({ page }, info) => {
    await seed(page);
    await go(page, '#/settings');
    await page.getByTestId('settings-rt').click({ timeout: 30000 });
    await expect.poll(() => attr(page, 'data-rt')).toBe('1');
    await showAll(page);
    expect(await frosted(page)).toEqual(all(false));
    await shot(page, info, 'rt-switch-on');
  });

  test('② 开关关着、系统设置了 reduce（Chromium 模拟媒体查询）：data-rt=1，全部实色', async ({ page, browserName }, info) => {
    test.skip(browserName !== 'chromium', 'WebKit 不能模拟 prefers-reduced-transparency');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await seed(page);
    await expect.poll(() => attr(page, 'data-rt')).toBe('1');
    await showAll(page);
    expect(await frosted(page)).toEqual(all(false));
    await shot(page, info, 'rt-system');
    // 系统改回来：跟着变回磨砂（不用重新打开 App）
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
    await expect.poll(() => attr(page, 'data-rt')).toBeNull();
    expect((await frosted(page)).tabbar).toBe(true);
  });

  test('③ 两者都没有：磨砂', async ({ page }, info) => {
    await seed(page);
    expect(await attr(page, 'data-rt')).toBeNull();
    await showAll(page);
    expect(await frosted(page)).toEqual(all(true));
    await shot(page, info, 'rt-off');
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
