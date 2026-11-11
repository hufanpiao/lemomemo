// 触屏上可输入控件的实际字号 ≥ 16px（负责人 11-11“收起键盘后底栏升上去”排查）：iOS 聚焦计算字号小于 16px 的 input / textarea / select
// 会自动放大整页，收起键盘也不缩回。src/app/__tests__/input-font-size.test.ts 按源码查类名；这里在浏览器里按触屏（hasTouch、isMobile，
// any-pointer: coarse 生效）逐页读 getComputedStyle(el).fontSize，继承、覆盖、媒体查询都算进去。
// 页面：今天、待办、日历（各自点“＋”打开打字条）、随手记（底部输入行）、随手记编辑、待办编辑、日程编辑、设置的注销、免打扰。
import type { Page } from '@playwright/test';
import { expect, FAKE_USER_ID, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const NOW = new Date('2026-11-06T10:00:00+09:00');
const MIN = 16;
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };
const TODO = { ...base, id: 't1', title: '交周报给产品组', project: '', due: '2026-11-06', due_time: '11:30', done: false };
const EVENT = { ...base, id: 'e1', title: '客户周会', project: 'NEOX', date: '2026-11-06', time: '14:00', duration_min: 60 };

test.use({ loggedIn: true, locale: 'zh-CN', timezoneId: TZ, hasTouch: true, isMobile: true, viewport: { width: 440, height: 956 } });

async function seed(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30_000 });
  await page.evaluate(
    async ([t, e]) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('planner-v4');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(['todos', 'events'], 'readwrite');
      tx.objectStore('todos').put({ id: t['id'], server: t, view: t });
      tx.objectStore('events').put({ id: e['id'], server: e, view: e });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    [TODO, EVENT] as [Record<string, unknown>, Record<string, unknown>],
  );
}

/** 页面上所有会弹键盘的控件：“标签[type] 读屏名或 testid 字号” */
function fonts(page: Page): Promise<{ id: string; px: number }[]> {
  return page.evaluate(() => {
    const NON_TEXT = new Set(['checkbox', 'radio', 'range', 'hidden', 'color', 'file', 'button', 'submit', 'reset', 'image']);
    return [...document.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable=""], [contenteditable="true"]')]
      .filter((el) => !(el instanceof HTMLInputElement && NON_TEXT.has(el.type)))
      .map((el) => {
        const type = el instanceof HTMLInputElement ? `[${el.type}]` : '';
        const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.id ?? '';
        return { id: `${el.tagName.toLowerCase()}${type} ${name}`.trim(), px: parseFloat(getComputedStyle(el).fontSize) };
      });
  });
}

const PAGES: [route: string, ready: string, plus: boolean][] = [
  ['today', 'main', true],
  ['todos', '[data-testid="todos-row-t1"]', true],
  ['calendar', '[data-testid="cal-day-list"]', true],
  ['notes', 'main[data-feature="notes"]', false],
  ['note/new', 'main', false],
  ['todo/t1', 'main', false],
  ['event/e1', 'main', false],
  ['settings/delete', 'main[data-feature="settings"]', false],
  ['settings/remind/dnd', 'main[data-feature="settings"]', false],
];

test('触屏上每个可输入控件计算字号 ≥ 16px（iOS 聚焦不自动放大）', async ({ page }) => {
  test.setTimeout(120_000);
  await seed(page);
  const seen: Record<string, string[]> = {};
  const bad: string[] = [];
  for (const [route, ready, plus] of PAGES) {
    await page.goto(`/app/#/${route}`);
    await page.reload();
    await page.locator(ready).first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
    if (plus) {
      await page.getByTestId('tabbar-add').click();
      await page.getByTestId('type-input').waitFor({ timeout: 10_000 });
    }
    const list = await fonts(page);
    seen[route] = list.map((c) => `${c.id} ${c.px}px`);
    for (const c of list) if (!(c.px >= MIN)) bad.push(`${route}: ${c.id} ${c.px}px`);
  }
  console.log(JSON.stringify(seen, null, 1));
  // 防扫描失灵：几个关键页面都量到了控件
  for (const r of ['today', 'todos', 'notes', 'todo/t1', 'event/e1']) expect(seen[r]?.length ?? 0, r).toBeGreaterThan(0);
  expect(bad, '这些控件在触屏上字号小于 16px，iOS 聚焦会放大整页').toEqual([]);
});

// 禁整页缩放只在 App 页（kb-zoom 代码审 M1）：同一份 base.css，登录页的 <html> 没有 data-app，touch-action 还是 auto、viewport 不禁缩放
test('App 页 html 的 touch-action 是 pan-x pan-y；登录页是 auto、viewport 不禁缩放', async ({ page }) => {
  await page.goto('/app/#/today');
  await page.locator('main[data-feature]').first().waitFor({ timeout: 30_000 });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('pan-x pan-y');
  const baseURL = test.info().project.use.baseURL;
  const ctx = await page.context().browser()?.newContext({ hasTouch: true, isMobile: true, ...(baseURL ? { baseURL } : {}) });
  if (!ctx) throw new Error('no context');
  try {
    const auth = await ctx.newPage();
    await auth.goto('/app/auth/');
    await auth.locator('main').first().waitFor({ timeout: 30_000 });
    expect(await auth.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('auto');
    expect(await auth.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '')).not.toMatch(/maximum-scale|user-scalable/);
  } finally {
    await ctx.close();
  }
});
