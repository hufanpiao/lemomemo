// 待办勾选完成时间线（负责人 11-17：“现在我的动效太轻了，根本反应不过来，并且完成时的横线是从左到右画上去的”；“这个间距太挤了”；
// 11-18 定稿对照页第 11 版“乙4”，本机资料 设计方案/2026-11-18_完成动效/对照页源文件.html 的 data-v="d"）。
// 不要后端：直接往本机库 planner-v4 写好待办和子任务再重新载入，在待办页勾一条，删除线、方框的动画停住后按 5 ms 一格拨时间取样（不靠帧率，见 record 的注释）：
// • 删除线（kit TodoRow 标题里的 .line，scaleX）勾上当下（--dur-done-strike-at 0）从 0 起、单调长到 1，--dur-strike（90 ms）加一格余量内画满
// • 方框（kit CheckCircle 的 .checkBox）从按下的 0.45 起回弹，峰值约 1.22（不低于 1.2），中间落回 1 以下（约 0.96），最后回到 1
// • 勾上那一刻：14 个小点和一圈细正圆；方框亮柠檬黄（--accent）、勾号 --on-accent；回弹播完拿掉 .pop 和小点
// • 勾上后约 720 ms（--dur-done-pop + --dur-done-rest）才打上 data-out；打上以后这一行在 --dur-collapse（100 ms）加两帧余量内收完、离开原组；
//   收进“已完成”组以后方框照旧暗黄（--check-on-bg），不是亮色
// • 减弱动态效果：方框不缩放、看不到小点和细正圆，删除线直接画满，没有中间值
// • 间距：标题和副行之间、副行和展开后的第一条子任务之间各至少留 3.5 / 13 px（负责人“太挤了”时是 0 / 10 px）
// • 字号：待办行副行（带子任务的“起步 · 1/3”胶囊和普通行的“工作”）和页头“· 0 / 3 完成”同一档（负责人 11-17 17:31“整体在小一圈”）
// • 环境变量 DONE_SHOTS 指一个本机文件夹时（只在 Chromium），截 430×932、DPR 3 的浅色、深色各一张，加勾选特效的关键帧连拍，不进仓库
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const SHOTS = process.env['DONE_SHOTS'];
test.use({ loggedIn: true, timezoneId: TZ, locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, rev: 1, undone: false, short: null };
const T1 = '11111111-1111-4111-8111-111111111111';

/** 没有日期的三条：T1“整理旧照片”带三项子任务（勾了一项），t2“回邮件”（项目“工作”，副行是普通的那种）、t3 没有子任务 */
async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  const td = (id: string, title: string, priority: string, project = '') => ({ ...base, id, title, project, due: null, due_time: null, done: false, important: false, priority });
  const it = (id: string, title: string, sort: number, done: boolean) => ({ ...base, id, todo_id: T1, title, sort, done });
  await idbPut(page, [
    ...[td(T1, '整理旧照片', 'high'), td('t2', '回邮件', 'mid', '工作'), td('t3', '买猫砂', 'low')].map((r) => ['todos', cached(r)] as const),
    ...[it('a', '挑出要冲印的', 1, true), it('b', '备份到硬盘', 2, false), it('c', '删掉重复的', 3, false)].map((r) => ['todo_items', cached(r)] as const),
  ]);
  await page.reload();
  await page.getByTestId(`todos-subs-${T1}`).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30000 });
  await page.waitForTimeout(400);
}

/** [动画自己的时间（毫秒）, 值]：删除线是 scaleX，方框是 scale */
type S = [number, number];
/**
 * 一次勾选记下的：line、box 是删除线、方框的整段动画按 5 ms 一格拨时间取的值；
 * outAt、goneAt 是打上 data-out、离开原组的时刻（距 pointerdown，毫秒）；boxAtOut 是打上 data-out 那一刻方框的缩放
 */
interface Rec {
  line: S[] | null;
  box: S[] | null;
  outAt: number | null;
  goneAt: number | null;
  boxAtOut: number | null;
  /** 打上 .pop 那一刻：小点几个、有没有细正圆，填充块、勾号的颜色和 --accent、--on-accent 是否一样 */
  pop: { dots: number; ring: boolean; burstShown: boolean; fillAccent: boolean; tickOnAccent: boolean } | null;
  /** 拿掉 .pop 的时刻（距 pointerdown，毫秒） */
  popEndAt: number | null;
}

/**
 * 点 id 那一行的方框并记下整条时间线。不按 rAF 逐帧取样：CI 的 WebKit 在 430×932、DPR 3 下一帧要 150～400 ms
 * （11-17 CI 跑 5dd426c4 的记录：22、185、336、459 ms 各一帧），130 ms 的删除线整个落在两帧之间，量不到中间值。
 * 改成删除线、方框的 CSS 动画一出现（MutationObserver 看到 data-done、.pop，强制算一次样式让过渡建起来）就先停住，
 * 用 currentTime 从 0 拨到 END_MS、每 5 ms 读一次计算后的 transform（同步做完，中间不出帧、计时器不插进来），再拨回原处接着播：
 * 读到的是浏览器真正在播的那段动画（时长、延迟、曲线、关键帧都是它自己的），和机器快慢无关。
 * 收起（data-out → 离开原组）是 useDoneFlow 的计时器，不是动画：用 MutationObserver 记时刻，也不靠帧
 */
async function record(page: Page, id: string): Promise<Rec> {
  await page.evaluate((id) => {
    const END_MS = 800;
    const STEP_MS = 5;
    const rec: Rec = { line: null, box: null, outAt: null, goneAt: null, boxAtOut: null, pop: null, popEndAt: null };
    /** 一个颜色令牌算出来的 rgb（拿一个临时元素套上再读，和计算后的颜色同一种写法） */
    const colorOf = (v: string): string => {
      const probe = document.createElement('i');
      probe.style.color = `var(${v})`;
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    };
    (window as Window & { __rec?: Rec }).__rec = rec;
    const scaleOf = (el: Element): number => {
      const t = getComputedStyle(el).transform;
      if (t === 'none') return 1;
      const m = /matrix\(([^,]+),\s*([^,]+)/.exec(t);
      return m ? Math.hypot(Number(m[1]), Number(m[2])) : Number.NaN;
    };
    /** 停住 el 自己的动画（不带子元素），拨时间取样，再拨回原处接着播；没有动画就只取当前值一格 */
    const sample = (el: Element): S[] => {
      scaleOf(el); // 先算一次样式：data-done、.pop 刚打上，过渡和动画在这一步才建起来
      const anims = el.getAnimations();
      if (anims.length === 0) return [[0, scaleOf(el)]];
      const saved = anims.map((a) => [a, a.currentTime] as const);
      for (const a of anims) a.pause();
      // 拨到动画结束前 1 ms 为止：拨过结束点，动画不再起作用，读到的是拨时间造出来的底值（WebKit 上方框会读成按下时的 0.8），不是用户看到的
      const end = Math.min(END_MS, Math.max(...anims.map((a) => Number(a.effect?.getComputedTiming().endTime ?? 0))) - 1);
      const out: S[] = [];
      for (let t = 0; t < end + STEP_MS; t += STEP_MS) {
        const at = Math.min(t, end);
        for (const a of anims) a.currentTime = at;
        out.push([at, scaleOf(el)]);
      }
      for (const [a, c] of saved) {
        a.currentTime = c;
        a.play();
      }
      return out;
    };
    let t0 = 0;
    let seen = false;
    const look = (): void => {
      if (!t0) return;
      const row = document.querySelector(`[data-row-id="${id}"]:not([data-state="leaving"])`);
      if (row) seen = true;
      const line = row?.querySelector('[class*="line"][aria-hidden]');
      const box = row?.querySelector('label[class*="checkBox"]');
      if (!rec.line && line?.hasAttribute('data-done')) rec.line = sample(line);
      if (!rec.box && box && /pop/.test(box.className)) {
        const fill = box.querySelector('[class*="fill"]');
        const tick = box.querySelector('[class*="tick"]');
        rec.pop = {
          dots: box.querySelectorAll('i').length,
          ring: Boolean(box.querySelector('b')),
          burstShown: [...box.querySelectorAll('span[aria-hidden]')].some((s) => s.querySelector('i') && getComputedStyle(s).display !== 'none'),
          fillAccent: fill ? getComputedStyle(fill).backgroundColor === colorOf('--accent') : false,
          tickOnAccent: tick ? getComputedStyle(tick).borderRightColor === colorOf('--on-accent') : false,
        };
        rec.box = sample(box);
      }
      if (rec.box && rec.popEndAt === null && box && !/pop/.test(box.className)) rec.popEndAt = performance.now() - t0;
      if (rec.outAt === null && row?.hasAttribute('data-out')) {
        rec.outAt = performance.now() - t0;
        rec.boxAtOut = box ? scaleOf(box) : null;
      }
      if (rec.goneAt === null && seen && !row) rec.goneAt = performance.now() - t0;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
    document.addEventListener(
      'pointerdown',
      () => {
        t0 = performance.now();
        look();
      },
      { once: true, capture: true },
    );
  }, id);
  await page.getByTestId(`todos-done-${id}`).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __rec?: Rec }).__rec?.goneAt ?? null), { timeout: 5000 }).not.toBeNull();
  return (await page.evaluate(() => (window as Window & { __rec?: Rec }).__rec)) as Rec;
}

const curve = (s: S[] | null): string => (s ?? []).filter(([t], i, all) => t % 20 === 0 || i === all.length - 1).map(([t, v]) => `${t.toFixed(0)}:${v.toFixed(2)}`).join(' ');
const show = (r: Rec): string =>
  `删除线 ${curve(r.line)} ｜ 方框 ${curve(r.box)} ｜ data-out ${r.outAt?.toFixed(0) ?? '-'} ms（方框 ${r.boxAtOut?.toFixed(2) ?? '-'}）、离开 ${r.goneAt?.toFixed(0) ?? '-'} ms`;

test.describe('待办勾选完成时间线', () => {
  test('删除线勾上当下起画、90 ms 内画满；方框 0.45 起回弹到约 1.22 再落回 1；14 个小点、亮柠檬黄；约 720 ms 后收起、收进“已完成”是暗黄', async ({ page }) => {
    await seed(page);
    const r = await record(page, 't2');
    const trace = show(r);
    console.log(`勾选时间线 ${test.info().project.name}：${trace}`);
    const line = r.line ?? [];
    const lines = line.map(([, v]) => v);
    expect(lines.length, `删除线没有过渡（取样不够）：${trace}`).toBeGreaterThan(5);
    // ① 删除线：从 0 起（勾上当下，--dur-done-strike-at 0）、单调不减、有中间帧，--dur-strike（90 ms）加一格取样内画满
    expect(lines[0]!, `删除线不是从 0 起画：${trace}`).toBeLessThan(0.05);
    for (let k = 1; k < lines.length; k += 1) expect(lines[k]!, `删除线往回缩：${trace}`).toBeGreaterThanOrEqual(lines[k - 1]! - 0.01);
    expect(lines.at(-1)!, `删除线没画满：${trace}`).toBeGreaterThan(0.99);
    const late = line.filter(([t, v]) => t >= 95 && v < 0.99);
    expect(late, `删除线 95 ms 还没画满（定稿 90 ms，勾上当下就画）：${trace}`).toEqual([]);
    const mid = lines.filter((x) => x > 0.05 && x < 0.95);
    expect(mid.length, `删除线没有中间帧（一下子画满，不是从左往右画）：${trace}`).toBeGreaterThan(0);
    // ② 方框：从按下的 0.45 起，峰值约 1.22（38% 处），落回 1 以下（64% 处约 0.96），最后回到 1
    const box = r.box ?? [];
    const boxes = box.map(([, v]) => v);
    expect(boxes[0]!, `方框回弹不是从 0.45 起：${trace}`).toBeLessThan(0.5);
    expect(Math.max(...boxes), `方框回弹峰值不够：${trace}`).toBeGreaterThanOrEqual(1.2);
    expect(Math.max(...boxes), `方框回弹冲过头太多：${trace}`).toBeLessThan(1.25);
    expect(Math.min(...box.filter(([t]) => t > 200).map(([, v]) => v)), `方框峰值以后没落回 1 以下再弹：${trace}`).toBeLessThan(0.98);
    expect(boxes.at(-1)!, `方框最后没回到 1：${trace}`).toBeLessThan(1.02);
    // ③ 勾上那一刻：14 个小点、一圈细正圆；这一行还在原位，方框亮柠檬黄、勾号 --on-accent；回弹播完才拿掉
    expect(r.pop, `没播勾选特效：${trace}`).toEqual({ dots: 14, ring: true, burstShown: true, fillAccent: true, tickOnAccent: true });
    expect(r.popEndAt, `.pop 一直没拿掉：${trace}`).not.toBeNull();
    expect(r.popEndAt!, `.pop 回弹没播完就拿掉了：${trace}`).toBeGreaterThanOrEqual(400);
    // ④ 勾上后约 720 ms 才打上 data-out；打上以后 100 ms（--dur-collapse）加 3 帧余量内离开原组；打上 data-out 那一刻方框已经回到 1
    expect(r.outAt, `没开始收起：${trace}`).not.toBeNull();
    expect(r.outAt!, `收起开始得太早（定稿 720 ms）：${trace}`).toBeGreaterThanOrEqual(700);
    expect(r.goneAt, `没收完：${trace}`).not.toBeNull();
    expect(r.goneAt! - r.outAt!, `收起太慢：${trace}`).toBeLessThanOrEqual(100 + 3 * 34);
    expect(r.boxAtOut!, `收起前方框没回到 1：${trace}`).toBeLessThan(1.02);
    // ⑤ 收进“已完成”组（展开看）以后照旧暗黄：填充块是 --check-on-bg，不是亮色、没有 data-fresh
    await page.getByTestId('todos-done-fold').click();
    const done = page.getByTestId('todos-g-done').locator('[data-row-id="t2"]');
    await expect(done).toBeVisible();
    const dark = await done.evaluate((row) => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--check-on-bg)';
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      const label = row.querySelector('label');
      const fill = label?.querySelector('[class*="fill"]');
      return { fresh: label?.hasAttribute('data-fresh') ?? null, fill: fill ? getComputedStyle(fill).backgroundColor === want : null };
    });
    expect(dark, `收进“已完成”以后方框不是暗黄：${trace}`).toEqual({ fresh: false, fill: true });
  });

  test('减弱动态效果：方框不缩放、删除线直接画满（没有中间帧）', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seed(page);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-rm') === '1', undefined, { timeout: 10000 });
    const r = await record(page, 't2');
    const trace = show(r);
    const boxes = (r.box ?? []).map(([, v]) => v);
    expect(Math.max(1, ...boxes), `减弱动态效果时方框还在放大：${trace}`).toBeLessThan(1.01);
    // 小点和细正圆看不见（.burst display: none）
    expect(r.pop?.burstShown ?? false, `减弱动态效果时还在画小点：${trace}`).toBe(false);
    expect(r.line, `删除线没打上 data-done：${trace}`).not.toBeNull();
    const mid = (r.line ?? []).map(([, v]) => v).filter((x) => x > 0.05 && x < 0.95);
    expect(mid, `减弱动态效果时删除线还在过渡：${trace}`).toEqual([]);
    expect(r.line!.at(-1)![1], `减弱动态效果时删除线没直接画满：${trace}`).toBeGreaterThan(0.99);
  });

  test('间距：标题和副行之间、副行和展开后的第一条子任务之间都留出空', async ({ page, browserName }) => {
    await seed(page);
    const g = await page.evaluate((id) => {
      const row = document.querySelector(`[data-row-id="${id}"]`);
      const title = row?.querySelector('[class*="title"]')?.getBoundingClientRect();
      const stage = document.querySelector(`[data-testid="todos-stage-${id}"]`)?.getBoundingClientRect();
      const first = document.querySelector('[data-testid="todos-sub-a"]')?.closest('li');
      const box = first?.querySelector('label')?.getBoundingClientRect();
      return title && stage && box ? { titleToMeta: stage.top - title.bottom, metaToSub: box.top - stage.bottom } : null;
    }, T1);
    expect(g).not.toBeNull();
    console.log(`间距 ${browserName}：标题→副行 ${g!.titleToMeta.toFixed(1)}px，副行→第一条子任务方框 ${g!.metaToSub.toFixed(1)}px`);
    expect(g!.titleToMeta).toBeGreaterThanOrEqual(3.5);
    expect(g!.metaToSub).toBeGreaterThanOrEqual(13);
    // 字号：页头那一行、带子任务的副行（胶囊里的字、“1/3”）、普通行的副行一样大
    const fs = await page.evaluate((id) => {
      const px = (el: Element | null | undefined): string => (el ? getComputedStyle(el).fontSize : '-');
      const stage = document.querySelector(`[data-testid="todos-stage-${id}"]`);
      return { head: px(document.querySelector('[data-testid="todos-sub"]')), pill: px(stage?.querySelector('[data-stage]')), frac: px(stage?.lastElementChild), plain: px(document.querySelector('[data-testid="todos-tag-t2"]')) };
    }, T1);
    console.log(`字号 ${browserName}：${JSON.stringify(fs)}`);
    expect(fs).toEqual({ head: '11px', pill: '11px', frac: '11px', plain: '11px' });
    if (!SHOTS || browserName !== 'chromium') return;
    const clip = await page.getByTestId(`todos-row-${T1}`).boundingBox();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/间距_${scheme === 'light' ? '浅色' : '深色'}.png` });
      if (clip) await page.screenshot({ path: `${SHOTS}/间距_${scheme === 'light' ? '浅色' : '深色'}_行放大.png`, clip: { x: 0, y: Math.max(0, clip.y - 24), width: 430, height: clip.height + 40 } });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  test('关键帧连拍（只在 DONE_SHOTS 设了、Chromium 时截图）', async ({ page, browserName }) => {
    test.skip(!SHOTS || browserName !== 'chromium', '只在要截图时跑');
    await seed(page);
    const row = page.getByTestId('todos-row-t2');
    const box = (await row.boundingBox())!;
    const clip = { x: 0, y: box.y - 12, width: 430, height: box.height + 24 };
    // 连拍要几秒：把 HOLD_MS（--dur-done-pop + --dur-done-rest）那一下的计时（≥ 700 ms 的 setTimeout）推到很久以后，免得拍到一半这一行就收起来了
    await page.evaluate(() => {
      const raw = window.setTimeout.bind(window);
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => raw(fn, (ms ?? 0) >= 700 ? 1e9 : ms, ...rest)) as typeof window.setTimeout;
    });
    await page.getByTestId('todos-done-t2').click();
    // 停在勾上那一刻，按参考视频的帧（30fps）把所有 CSS 动画、过渡拨到同一时刻再截
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.pause();
    });
    for (const [n, ms] of [[1, 33], [2, 67], [3, 100], [4, 133], [5, 167], [6, 200], [7, 233], [9, 300], [11, 367], [13, 433]] as const) {
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) a.currentTime = ms;
      }, ms);
      await page.waitForTimeout(60);
      await page.screenshot({ path: `${SHOTS}/关键帧_f${String(n).padStart(2, '0')}_${ms}ms.png`, clip });
    }
  });
});
