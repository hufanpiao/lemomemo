// B2 FA-5 列表动效（设计审查 M1、M2 返工，11-04）：在真浏览器里每帧量位置，jsdom 量不出布局
// • M1：打勾后头 --dur-ui（220 ms）里“已完成”组不动（圆圈先在原地填满，列表这一拍什么都不动）
// • M2：撤销恢复时，新行看得见（自身连同祖先的不透明度乘积 > 0.01）的每一帧，它的矩形都不和任何一行、任何组标题重叠；
//   完全透明的帧不算（那时候它还在等周围让位，看不见，也挡不住点按：AppearItem 进场前不接点按不在本条范围）
// • 第二轮 N1、L2：离开的那一项（data-state="leaving"）不透明度乘积 > 0.25 的每一帧，它的字不和任何看得见的行、组标题的字重叠
//   （打勾、删除各一次）。比的是文字的矩形（Range 量每个文字节点），不是整行：离开那一项和下一行本来紧挨着，
//   收拢第一帧整行矩形就会交上几 px，那时压在一起的是行间留白，不是字；“压到字”才是设计审查说的问题
//   今天页“没赶上”最后一条打勾、整组离开时用同一判定（第三轮 P2：整组卡片约 70 px，“今天的安排”就贴在卡片下沿）
//   不透明度取“这一帧往前 LAG_MS（约两帧，34 ms）以内取样里最大的那个”：opacity 动画在合成器上跑，画到屏幕上的值比主线程
//   getComputedStyle 读到的晚一两帧，位置（layout 的 transform）却是当帧的；只看当帧会把残影估淡（第三轮：帧上 0.6、页面里读出 0.19）。
//   按时间窗算、不按“前两次取样”算：webkit 取样间隔不匀，前两次可能隔了 50 ms 以上，会把早已淡掉的值算进来
// • M1 补：220 ms 以后“已完成”组只往上走（top 单调不增），不往回退
// 示例待办和 FA-5 连续帧同一份（docs/02-设计/当前界面截图-1104/动效-*.png）
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const UI_MS = 220;
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 86400000));
const TD = [
  { ...base, id: 't1', title: '交周报', project: 'NEOX', due: day(-2), due_time: null, done: false },
  { ...base, id: 't2', title: '订机票', project: '旅行', due: day(0), due_time: '23:30', done: false },
  { ...base, id: 't3', title: '买牛奶', project: '', due: day(0), due_time: null, done: false },
  { ...base, id: 't4', title: '整理照片', project: '', due: null, due_time: null, done: false },
  { ...base, id: 't5', title: '回邮件', project: '', due: null, due_time: null, done: true, done_at: Date.now() - 3600000 },
];

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await page.evaluate(async (rows) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction(['todos'], 'readwrite');
    for (const r of rows) tx.objectStore('todos').put({ id: r.id, server: r, view: r });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, TD);
  await page.reload();
  await page.getByTestId('todos-row-t1').waitFor({ timeout: 30000 });
  await page.getByTestId('todos-g-done').waitFor();
  await motionReady(page);
}

/**
 * 等动效功能包下载完、装上（B2 FA-6 ②：功能包在首屏画出后才异步下载，src/motion/features.ts）。
 * 这里测的是功能包到了以后的手感；没到之前删掉的行当场移除、没有淡出，那一段不归这些用例管（见 FA-6 执行说明“② 的连续帧对照”）。
 * 下载完以后还要执行模块、各个 LazyMotion 重画一次：再等 300 ms 停稳
 */
async function motionReady(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    performance.getEntriesByType('resource').some((e) => /\/feature-bundle-[^/]*\.js$/.test(new URL(e.name).pathname) && (e as PerformanceResourceTiming).responseEnd > 0),
  );
  await page.waitForTimeout(300);
}

/** 在页面里每帧取样 ms 毫秒；时间从下一次 pointerup（点下去松手）算起。返回 [距松手毫秒, 取样结果] */
/** root：取样范围（页面根元素的 data-testid），ghost 用；待办页 todos、今天页 today */
async function startSampler(page: Page, kind: 'done-group' | 'overlap' | 'ghost', id: string, ms: number, root = 'todos'): Promise<void> {
  await page.evaluate(
    ({ kind, id, ms, root }) => {
      type W = Window & { __samples?: unknown[]; __t0?: number };
      const w = window as W;
      w.__samples = [];
      delete w.__t0;
      document.addEventListener('pointerup', () => (w.__t0 = performance.now()), { capture: true, once: true });
      const alpha = (el: Element | null): number => {
        let a = 1;
        for (let e = el; e; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
        return a;
      };
      /** 元素里每个文字节点的矩形（空白不算） */
      const textRects = (el: Element): DOMRect[] => {
        const out: DOMRect[] = [];
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const b of r.getClientRects()) if (b.width > 0 && b.height > 0) out.push(b);
        }
        return out;
      };
      const cross = (a: DOMRect, b: DOMRect) =>
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5;
      const tick = (now: number): void => {
        const t0 = w.__t0;
        if (t0 === undefined) {
          requestAnimationFrame(tick);
          return;
        }
        const dt = now - t0;
        if (kind === 'ghost') {
          // 正在离开、还没淡完的行或整组，逐个和别的看得见的行、组标题比字（门槛在 Node 这边按前两帧取最大后再判）
          const r0 = `[data-testid="${root}"]`;
          const ghosts = [...document.querySelectorAll(`${r0} [data-state="leaving"]`)].filter((g) => alpha(g) > 0.01);
          // 行都是 li（两页的 AppearItem 默认画成 li），组标题都是 h2
          const others = [...document.querySelectorAll(`${r0} li, ${r0} h2`)].filter(
            (o) => !o.closest('[data-state="leaving"]') && alpha(o) > 0.01,
          );
          const info: [string, number, string[]][] = [];
          for (const g of ghosts) {
            const gt = textRects(g);
            const hits: string[] = [];
            for (const o of others) {
              if (o.contains(g)) continue;
              const ot = textRects(o);
              if (gt.some((a) => ot.some((b) => cross(a, b)))) hits.push(o.getAttribute('data-testid') ?? o.textContent ?? '');
            }
            info.push([g.getAttribute('data-testid') ?? g.textContent?.slice(0, 6) ?? '', alpha(g), hits]);
          }
          w.__samples?.push([dt, info]);
        } else if (kind === 'done-group') {
          const g = document.querySelector('[data-testid="todos-g-done"]');
          w.__samples?.push([dt, g ? g.getBoundingClientRect().top : null]);
        } else {
          const me = document.querySelector(`[data-testid="todos-row-${id}"]:not([data-state="leaving"])`);
          if (me) {
            const r = me.getBoundingClientRect();
            const a = alpha(me);
            const hits: string[] = [];
            if (a > 0.01) {
              const others = document.querySelectorAll('[data-testid="todos"] [data-testid^="todos-row-"], [data-testid="todos"] h2');
              for (const o of others) {
                if (o === me || me.contains(o) || o.closest('[data-state="leaving"]') || alpha(o) <= 0.01) continue;
                const b = o.getBoundingClientRect();
                const ov = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
                if (ov > 0.5) hits.push(`${o.getAttribute('data-testid') ?? o.textContent}:${ov.toFixed(1)}`);
              }
            }
            w.__samples?.push([dt, a, hits]);
          }
        }
        if (dt < ms) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { kind, id, ms, root },
  );
}

async function samples<T>(page: Page, ms: number): Promise<T[]> {
  await expect.poll(async () => page.evaluate(() => {
    const w = window as Window & { __samples?: [number][] };
    const s = w.__samples ?? [];
    return s.length ? s[s.length - 1]?.[0] ?? 0 : 0;
  })).toBeGreaterThanOrEqual(ms);
  return page.evaluate(() => (window as Window & { __samples?: unknown[] }).__samples ?? []) as Promise<T[]>;
}

type GhostFrame = [number, [string, number, string[]][]];
/** 合成器上的不透明度比主线程读到的晚多少（约两帧） */
const LAG_MS = 34;
/** 每一帧：离开的那一项“往前 LAG_MS 以内最大的不透明度”> 0.25 时，它的字压到别人的字就记一条（见文件头） */
function ghostHits(s: GhostFrame[]): { seen: number; bad: string[]; trace: string } {
  const hist = new Map<string, [number, number][]>();
  let seen = 0;
  const bad: string[] = [];
  for (const [dt, info] of s) {
    for (const [id, a, hits] of info) {
      const h = [...(hist.get(id) ?? []), [dt, a] as [number, number]].filter(([t]) => t >= dt - LAG_MS);
      hist.set(id, h);
      const eff = Math.max(...h.map(([, x]) => x));
      if (eff <= 0.25) continue;
      seen += 1;
      if (hits.length) bad.push(`松手后 ${dt.toFixed(0)} ms，${id} 不透明度按 ${eff.toFixed(2)} 算（当帧 ${a.toFixed(2)}），压到 ${hits.join('、')}`);
    }
  }
  const trace = s.map(([dt, info]) => `${dt.toFixed(0)}${info.length ? ':' + info.map(([, a]) => a.toFixed(2)).join('/') : ''}`).join(' ');
  return { seen, bad, trace };
}

test.describe('待办列表动效（B2 FA-5 设计审查 M1、M2，第二轮 N1、L2）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: TZ, locale: 'zh-CN' });

  test('M1 打勾后头 220 ms 里“已完成”组不动，之后只往上走、不回退', async ({ page }) => {
    await seed(page);
    const before = await page.getByTestId('todos-g-done').evaluate((g) => g.getBoundingClientRect().top);
    await startSampler(page, 'done-group', 't4', 900);
    await page.getByTestId('todos-done-t4').click();
    const s = await samples<[number, number | null]>(page, 900);
    const head = s.filter(([dt]) => dt < UI_MS - 20);
    expect(head.length).toBeGreaterThan(3);
    for (const [dt, top] of head) expect(top, `松手后 ${dt.toFixed(0)} ms`).toBeCloseTo(before, 0);
    // 之后只往上走一次、不往回退（第二轮 L2）
    const tail = s.filter(([dt, top]) => dt >= UI_MS && top !== null) as [number, number][];
    for (let i = 1; i < tail.length; i += 1) {
      const [dt, top] = tail[i] as [number, number];
      expect(top, `松手后 ${dt.toFixed(0)} ms“已完成”组往回退了`).toBeLessThanOrEqual((tail[i - 1] as [number, number])[1] + 0.5);
    }
    // 收尾：t4 进了“已完成”组（确认这一下确实挪了，不是什么都没发生）
    await expect(page.getByTestId('todos-g-done').getByTestId('todos-row-t4')).toBeVisible();
  });

  for (const [name, testId] of [
    ['打勾', 'todos-done-t4'],
    ['删除', 'todos-del-t3'],
  ] as const) {
    test(`N1 ${name}：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字`, async ({ page }) => {
      await seed(page);
      await startSampler(page, 'ghost', '', 900);
      await page.getByTestId(testId).click();
      const { seen, bad, trace } = ghostHits(await samples<GhostFrame>(page, 900));
      expect(seen, `要取到离开那一项看得清的帧（否则这条什么都没测）。取样：${trace}`).toBeGreaterThan(0);
      expect(bad).toEqual([]);
    });
  }

  test('N1 今天页“没赶上”最后一条打勾：整组离开，不透明度 > 0.25 的每一帧，它的字不压“今天的安排”等别的字（第三轮 P2）', async ({ page }) => {
    await seed(page);
    await page.goto('/app/#/today');
    await page.getByTestId('today-late').waitFor({ timeout: 30000 });
    // 今天页的数据是进页面后才到的：“没赶上”整组可能是进场中（entering，透明、不接点按），等它和里面的行都进场完、页面停稳再取样
    await expect(page.locator('[data-testid="today"] [data-state="entering"]')).toHaveCount(0);
    await page.waitForTimeout(500);
    await startSampler(page, 'ghost', '', 900, 'today');
    // 只点没在离开中的那一份（代码审查 FA5-CR A4：打勾后退场和进场会短暂同时有两个 today-done-<id>）
    await page.locator('[data-testid="today-done-t1"]:not([data-state="leaving"] *)').click();
    const { seen, bad, trace } = ghostHits(await samples<GhostFrame>(page, 900));
    expect(seen, `要取到离开那一组看得清的帧（否则这条什么都没测）。取样：${trace}`).toBeGreaterThan(0);
    expect(bad).toEqual([]);
    await expect(page.getByTestId('today-late')).toHaveCount(0);
  });

  test('M2 撤销恢复：新行看得见的每一帧都不和别的行、组标题重叠', async ({ page }) => {
    await seed(page);
    await page.getByTestId('todos-del-t3').click();
    await expect(page.getByTestId('todos-row-t3')).toHaveCount(0);
    await startSampler(page, 'overlap', 't3', 900);
    await page.getByTestId('todos-toast').getByRole('button').first().click();
    const s = await samples<[number, number, string[]]>(page, 900);
    const seen = s.filter(([, a]) => a > 0.01);
    expect(seen.length, '新行最后要看得见').toBeGreaterThan(0);
    for (const [dt, a, hits] of seen) expect(hits, `松手后 ${dt.toFixed(0)} ms，不透明度 ${a.toFixed(2)}`).toEqual([]);
    await expect(page.getByTestId('todos-row-t3')).toBeVisible();
  });
});
