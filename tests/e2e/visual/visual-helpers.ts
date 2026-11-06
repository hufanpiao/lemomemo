// 视觉基准组共用（playwright.visual.config.ts）：固定假数据、深浅色、等页面稳定、“把底栏后面的内容藏起来”的对照场景、截图解码和像素统计。
// 像素断言的思路（对照 docs/06-测试/负责人观感要求清单.md）：
//   底栏、“＋”自己有图标、文字、亮边，单看一块区域的亮度方差分不出“后面透出来的字”和“底栏自己的图标”。
//   所以同一帧拍两张：A 照常，B 把 main（和切页快照里的页面）设成 visibility: hidden，只留底栏、实色带、顶部模糊这些固定层。
//   D = A − B 就是“后面的内容在这块区域里留下的痕迹”：底栏透明时 D 有明显起伏（字透出来），实心时 D 处处是 0。
//   对照场景（B 和再拍一次的 B′）的 D 方差是噪声底，阈值从它定，至少高出噪声底一个数量级。
// 截图解码、像素统计在 pixels.ts。
import { test as base, expect, type Page } from '@playwright/test';
import { FAKE_USER_ID, seedFakeSession } from '../session-fixture.ts';

/**
 * 视觉组的 test：只带假会话，不带 csp-fixture 的 CSP 违规判定。
 * 原因：webkit 上 Playwright 每截一次图都往页面插一个 <style>body {}</style> 来同步动画（playwright-core 的
 * inPagePrepareForScreenshots，syncAnimations 只看浏览器、关不掉），页面的 CSP 照常把它拦下、报一条 style-src-elem 违规，
 * 那是测试工具自己的，不是 App 的。CSP 本身照常生效（响应头不变），App 的 CSP 违规由主 e2e 组（playwright.config.ts）判。
 * 也不接 CI webkit 的关模糊名单：视觉组就是要看模糊开着的样子，绝不关 backdrop-filter
 */
export const test = base.extend<{ loggedIn: boolean; fakeSession: void }>({
  loggedIn: [false, { option: true }],
  fakeSession: [
    async ({ loggedIn, context, baseURL }, use) => {
      if (loggedIn) await seedFakeSession(context, baseURL);
      await use();
    },
    { auto: true },
  ],
});
export { expect };

export const TZ = 'Asia/Seoul';
/** 固定“现在”：2026-11-06 上午 10 点（首尔）。日期、问候语、“没赶上”分组都跟着它，截图每次一样 */
export const FIXED_NOW = new Date('2026-11-06T10:00:00+09:00');
const TODAY = '2026-11-06';
const T0 = FIXED_NOW.getTime() - 86_400_000;

/** 20 条待办：全部今天到期，长短不一、有的带项目、有的带时间，今天页和待办页都够长，能滚到底栏后面 */
const TITLES = [
  '交周报给产品组',
  '订下周去釜山的机票',
  '买牛奶和鸡蛋',
  '整理十月的照片',
  '回复房东关于暖气的邮件',
  '预约牙医复诊',
  '给妈妈打电话',
  '把旧衣服送到回收箱',
  '准备周五分享会的提纲',
  '续交健身房月卡',
  '检查信用卡账单',
  '修好阳台的灯',
  '读完《设计心理学》第三章',
  '给猫买猫砂',
  '更新简历里的项目经历',
  '确认周末聚餐的人数',
  '洗车',
  '把发票拍照上传报销',
  '备份手机相册',
  '写下个月的预算',
];
const PROJECTS = ['NEOX', '', '生活', '', '旅行'];

export function todoRows(): Record<string, unknown>[] {
  return TITLES.map((title, i) => ({
    id: `v${String(i + 1).padStart(2, '0')}`,
    user_id: FAKE_USER_ID,
    tz: TZ,
    title,
    project: PROJECTS[i % PROJECTS.length] ?? '',
    due: TODAY,
    due_time: i % 4 === 1 ? `${String(11 + (i % 10)).padStart(2, '0')}:30` : null,
    done: false,
    created_at: T0 + i * 1000,
    updated_at: T0 + i * 1000,
    deleted_at: null,
    undone: false,
    short: null,
  }));
}

/** 深浅色：入口页 <html> 写死 data-theme="light"（11-06 取消自动深浅），深色项目在页面脚本之前把它改成 dark 并守住 */
export async function applyTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => {
    const apply = (): void => {
      const r = document.documentElement;
      if (r && r.dataset['theme'] !== t) r.dataset['theme'] = t;
    };
    apply();
    new MutationObserver(apply).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }, theme);
}

/**
 * 负责人 iPhone（440×956）竖屏的顶部安全区 62pt。Playwright 的 webkit 没有安全区，env(safe-area-inset-top) 是 0，
 * 顶部模糊带就只剩 --top-fade 那 12px，G5 量的不是真机的样子。所以把 --inset-top（base.css 里 = env(safe-area-inset-top)）改成 62px。
 * 底部安全区（34pt）模拟不了：GlassBar、实色带直接写 env(safe-area-inset-bottom)，没有变量可改；G2 量到的“底栏底边以下”只有 8px 高，
 * 真机是 8 + 34px，带子同样从底栏顶边往下铺到屏幕底，判据不变
 */
export const SAFE_TOP = 62;

/** 关掉会让截图每次不一样的东西：固定时钟、关光标闪烁；顺带模拟顶部安全区（SAFE_TOP） */
export async function freeze(page: Page): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript((safeTop) => {
    const sheet = new CSSStyleSheet();
    sheet.insertRule('*, *::before, *::after { caret-color: transparent !important; }');
    sheet.insertRule(`:root { --inset-top: ${safeTop}px !important; }`);
    const add = (): void => {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add, { once: true });
    else add();
  }, SAFE_TOP);
}

/** 写入 20 条待办（IndexedDB planner-v4，和 b2-motion-list 同一个写法），再重新打开 route */
export async function seedTodos(page: Page, route: string): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30_000 });
  await page.evaluate(async (rows) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction(['todos'], 'readwrite');
    for (const r of rows) tx.objectStore('todos').put({ id: r['id'], server: r, view: r });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    // 月历页的日清单行字短，压不到“＋”后面（G1 的“＋”量不到东西）：月历场景把标题加长，一直排到行尾
  }, route === 'calendar' ? todoRows().map((r): Record<string, unknown> => ({ ...r, title: `${String(r['title'])} 加长到行尾压在“＋”后面的标题文字` })) : todoRows());
  await page.goto(`/app/#/${route}`);
  await page.reload();
}

/** 等到能截图：页面画出来、首屏后部分到了（实色带/模糊带挂上）、动效包装好、字体好了，再等几帧 */
export async function settle(page: Page, testid: string): Promise<void> {
  await page.locator(testid === 'cal' ? 'main[data-feature="calendar"]' : `[data-testid="${testid}"]`).waitFor({ timeout: 30_000 });
  await page.getByTestId('tabbar-band').waitFor({ state: 'attached', timeout: 15_000 });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await frames(page, 3);
  await page.waitForTimeout(400);
}

/** 把还在跑的有限动画、过渡直接放到结尾（代替 toHaveScreenshot 的 animations: 'disabled'，那个会插 <style>） */
export async function still(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      const t = a.effect?.getComputedTiming();
      if (t && Number.isFinite(Number(t.endTime))) a.finish();
    }
  });
  await frames(page, 3);
}

export async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((ok) => {
        let k = 0;
        const step = (): void => {
          k += 1;
          if (k >= n) ok();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

export async function scrollTo(page: Page, y: number): Promise<number> {
  const got = await page.evaluate((y) => {
    window.scrollTo(0, y);
    return window.scrollY;
  }, y);
  await frames(page, 3);
  await page.waitForTimeout(150);
  return got;
}

/**
 * 对照场景开关：把底栏后面的“内容”藏起来（main 和切页快照里的页面），底栏、“＋”、实色带、顶部模糊照旧。
 * 用构造样式表挂（不受 CSP style-src 限制）；visibility 不改布局，滚动位置、底栏位置都不变。
 * 切页快照里只放过 tabbar、tabbar-add 两组（具名伪元素的优先级高于 (*)）
 */
export async function hideContent(page: Page, on: boolean): Promise<void> {
  await page.evaluate((on) => {
    const w = window as unknown as { __vhide?: CSSStyleSheet };
    if (!w.__vhide) {
      const s = new CSSStyleSheet();
      s.replaceSync(
        [
          'main, main * { visibility: hidden !important; }',
          '::view-transition-old(*), ::view-transition-new(*) { visibility: hidden !important; }',
          '::view-transition-old(tabbar), ::view-transition-new(tabbar), ::view-transition-old(tabbar-add), ::view-transition-new(tabbar-add) { visibility: visible !important; }',
        ].join('\n'),
      );
      w.__vhide = s;
    }
    const s = w.__vhide;
    const rest = document.adoptedStyleSheets.filter((x) => x !== s);
    document.adoptedStyleSheets = on ? [...rest, s] : rest;
  }, on);
  await frames(page, 3);
}

/** 只藏底栏和“＋”（G3、G4 量实色带自己的渐变用），带子照旧 */
export async function hideBar(page: Page, on: boolean): Promise<void> {
  await page.evaluate((on) => {
    const w = window as unknown as { __vbar?: CSSStyleSheet };
    if (!w.__vbar) {
      const s = new CSSStyleSheet();
      s.replaceSync('[data-testid="tabbar"], [data-testid="tabbar-add"] { visibility: hidden !important; }');
      w.__vbar = s;
    }
    const s = w.__vbar;
    const rest = document.adoptedStyleSheets.filter((x) => x !== s);
    document.adoptedStyleSheets = on ? [...rest, s] : rest;
  }, on);
  await frames(page, 3);
}

/** G3、G4 的“实心内容”：一整屏纯色块（浅色用黑、深色用白），放在 main 那一层（z-index 1，带子是 9） */
export async function solidBackdrop(page: Page, color: string | null): Promise<void> {
  await page.evaluate((color) => {
    const w = window as unknown as { __vsolid?: CSSStyleSheet };
    document.getElementById('v-solid')?.remove();
    if (w.__vsolid) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== w.__vsolid);
    if (color === null) return;
    const s = new CSSStyleSheet();
    s.replaceSync(`#v-solid { position: fixed; inset: 0; z-index: 1; background: ${color}; pointer-events: none; }`);
    w.__vsolid = s;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
    const d = document.createElement('div');
    d.id = 'v-solid';
    document.body.appendChild(d);
  }, color);
  await frames(page, 3);
}

/**
 * 找一个滚动位置，让页面里的字（文字行、图标）尽量盖满视口里 [top, bottom) 这一段（CSS px），滚过去，返回 scrollY。
 * 固定滚 260px 不可靠：行距 48px、底栏 62px，滚到哪一格碰巧是行间空白、组标题留白，底栏后面就没字，G1、G2 量不出东西（9d40848 待办页实测）。
 * 同一份假数据、同一份代码，选出来的位置每次一样
 */
export async function scrollToCover(page: Page, top: number, bottom: number): Promise<{ scrollY: number; cover: number }> {
  const best = await page.evaluate(
    ({ top, bottom }) => {
      const main = document.querySelector('main');
      if (!main) return { y: 0, cover: 0 };
      const sy = window.scrollY;
      const spans: [number, number][] = [];
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const b of r.getClientRects()) if (b.height > 4) spans.push([b.top + sy, b.bottom + sy]);
      }
      for (const el of main.querySelectorAll('svg')) {
        const b = el.getBoundingClientRect();
        if (b.height > 4) spans.push([b.top + sy, b.bottom + sy]);
      }
      const max = document.documentElement.scrollHeight - window.innerHeight;
      let bestY = 0;
      let bestCover = -1;
      for (let y = 0; y <= max; y += 2) {
        // 这一段每一行（1px）有没有字盖着，数盖着的行数
        let cover = 0;
        for (let row = top; row < bottom; row += 1) {
          const at = row + y;
          if (spans.some(([a, b]) => a <= at && at < b)) cover += 1;
        }
        if (cover > bestCover) {
          bestCover = cover;
          bestY = y;
        }
      }
      return { y: bestY, cover: bestCover / Math.max(1, bottom - top) };
    },
    { top, bottom },
  );
  const scrollY = await scrollTo(page, best.y);
  return { scrollY, cover: best.cover };
}
