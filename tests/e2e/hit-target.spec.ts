// B2-UI-a V5（A6、A7、A8）：本批涉及的页面上，每个可点的元素点击区都不小于 44 × 44。逐页列出小于 44 的，报 0 个才算过。
// • 可点的元素：a[href]、button、[role="button"]、select、input（checkbox、radio 量包着它的 label——CheckCircle 那种
//   “看得见 22 的圆圈、label 用 ::after 外扩到 44”的写法，点的是 label）、[tabindex]（不含 -1）。看不见的（display:none、
//   visibility:hidden、宽高为 0、aria-hidden 里的）不算。
// • 有效点击区 = 元素自己的框和它 ::after 的框（kit 的 ::after 外扩写法，同 Settings.module.css 的 .segBtn::after）取较大的那个；
//   ::after 不是绝对定位、没内容的不算。只量大小，不量相邻元素有没有互相盖住。
// • 不量：正文段落里的行内链接（WCAG 2.5.8 的“行内”例外；本批页面目前没有）。
// • 页面：今天、待办、最近删除、日历（月视图 + 当天列表）、设置首页和各级子页、随手记、待办编辑、日程编辑；灌一份固定数据，让列表行、
//   行尾 ×、打勾圆圈、“没赶上”都出来。宽屏（≥ 900）侧栏另开一个用例。
import type { Page } from '@playwright/test';
import { expect, FAKE_USER_ID, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const NOW = new Date('2026-11-06T10:00:00+09:00');
const DAY = 86_400_000;
const HIT = 44;
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null as number | null, undone: false, short: null };
const TODOS = [
  ['t1', '交周报给产品组', '2026-11-06', '11:30', false],
  ['t2', '买牛奶和鸡蛋', '2026-11-06', null, true],
  ['t3', '预约牙医复诊', '2026-11-05', null, false],
  ['t4', '已删掉的一条待办', '2026-11-06', null, false],
].map(([id, title, due, due_time, done]) => ({ ...base, id, title, project: '', due, due_time, done, deleted_at: id === 't4' ? NOW.getTime() - 2 * DAY : null }));
const EVENTS = [
  ['e1', '客户周会', '2026-11-06', '14:00', 60],
  ['e2', '已删掉的日程', '2026-11-06', '09:00', 30],
].map(([id, title, date, time, dur]) => ({ ...base, id, title, project: 'NEOX', date, time, duration_min: dur, deleted_at: id === 'e2' ? NOW.getTime() - DAY : null }));

// 按触屏量（主持人 11-07）：44 只要求触屏。编辑页输入框、下拉框只在 @media (any-pointer: coarse) 下提到 44，鼠标下 36 是允许的
test.use({ loggedIn: true, locale: 'zh-CN', timezoneId: TZ, hasTouch: true, isMobile: true });

async function seed(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30_000 });
  await page.evaluate(
    async ([ts, es]) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('planner-v4');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(['todos', 'events'], 'readwrite');
      for (const r of ts) tx.objectStore('todos').put({ id: r['id'], server: r, view: r });
      for (const r of es) tx.objectStore('events').put({ id: r['id'], server: r, view: r });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    [TODOS, EVENTS] as [Record<string, unknown>[], Record<string, unknown>[]],
  );
}

/** 页面上点击区小于 44 的可点元素：“标签 文字/读屏名 宽×高” */
function smallTargets(page: Page, hit: number): Promise<string[]> {
  return page.evaluate((min) => {
    const SEL = 'a[href], button, [role="button"], select, input:not([type="hidden"]), [tabindex]:not([tabindex="-1"])';
    const shown = (el: Element): boolean => {
      if (el.closest('[aria-hidden="true"], [inert]')) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const box = (el: Element): { w: number; h: number } => {
      const r = el.getBoundingClientRect();
      let w = r.width;
      let h = r.height;
      const a = getComputedStyle(el, '::after');
      if (a.content !== 'none' && a.content !== 'normal' && a.position === 'absolute') {
        w = Math.max(w, parseFloat(a.width) || 0);
        h = Math.max(h, parseFloat(a.height) || 0);
      }
      return { w, h };
    };
    const seen = new Set<Element>();
    const out: string[] = [];
    for (const raw of document.querySelectorAll(SEL)) {
      // checkbox、radio：点的是包着它的 label
      const el = raw instanceof HTMLInputElement && (raw.type === 'checkbox' || raw.type === 'radio') ? (raw.closest('label') ?? raw) : raw;
      if (seen.has(el) || !shown(el)) continue;
      seen.add(el);
      // 包在另一个可点元素里面的（按钮里的链接图标等）按外面那个算
      if (el.parentElement?.closest(SEL) && !(el instanceof HTMLLabelElement)) continue;
      const { w, h } = box(el);
      if (w + 0.5 < min || h + 0.5 < min) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 20);
        const tid = el.getAttribute('data-testid');
        out.push(`${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ''} “${name}” ${Math.round(w)}×${Math.round(h)}`);
      }
    }
    return out;
  }, hit);
}

const PAGES: [route: string, ready: string][] = [
  ['today', '[data-testid="today-list"]'],
  ['todos', '[data-testid="todos-row-t1"]'],
  ['trash', '[data-testid="trash-row-t4"]'],
  ['calendar', '[data-testid="cal-day-list"]'],
  ['settings', 'main[data-feature="settings"]'],
  // 设置的二级、三级页（主持人 11-07：点进去的页都量）：账号（含设备列表）、注销、日历、提醒和它的三个子页、数据（导出）、电脑版、关于
  ...(['account', 'delete', 'calendar', 'remind', 'remind/upcoming', 'remind/show-title', 'remind/dnd', 'data', 'desktop', 'about'] as const).map(
    (sub): [string, string] => [`settings/${sub}`, 'main[data-feature="settings"]'],
  ),
  ['notes', 'main[data-feature="notes"]'],
  // 两个编辑页都有 <select>，放在同一条用例里：csp-fixture 的 webkit“新建 select”误报计数 11-07 起整条用例累计，
  // 和控制台报错同一口径（原来每载入一次文档从 0 重数，进第二个带 select 的页就误报，曾为此拆成单独用例）
  ['todo/t1', 'main'],
  ['event/e1', 'main'],
];

async function measure(page: Page, pages: [string, string][]): Promise<Record<string, string[]>> {
  const bad: Record<string, string[]> = {};
  for (const [route, ready] of pages) {
    await page.goto(`/app/#/${route}`);
    await page.reload();
    await page.locator(ready).first().waitFor({ timeout: 30_000 });
    // 子页：首页的分卡（settings-card-*）不在了才算到了那一页，没被退回首页
    if (route.startsWith('settings/')) await expect(page.locator('[data-testid^="settings-card-"]')).toHaveCount(0);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
    await page.waitForTimeout(500);
    const small = await smallTargets(page, HIT);
    if (small.length) bad[route] = small;
  }
  return bad;
}

const MSG = '这些可点元素的点击区小于 44 × 44（不够的用 ::after 外扩，同 Settings.module.css 的 .segBtn::after）';

for (const [w, h, label] of [
  [440, 956, '手机'],
  [1280, 800, '电脑宽屏'],
] as const) {
  test(`点击区不小于 44 × 44（${label} ${w}×${h}）：逐页列出不够的，0 个才过`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: w, height: h });
    await seed(page);
    expect(await measure(page, PAGES), MSG).toEqual({});
  });
}
