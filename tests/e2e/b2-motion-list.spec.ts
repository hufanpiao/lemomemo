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
// • 负责人 11-17 勾选特效分镜（替换 11-15“撤销条开着的约 3 秒里留在原组”）：刚勾的那一条在原组停 720 ms（负责人 11-18 定稿乙4，--dur-done-pop + --dur-done-rest，kit useDoneFlow 的 HOLD_MS），再原地收起 100 ms（--dur-collapse）、同时页底升起撤销条，
//   收完进默认收起的“已完成 N”。收起时这一行已经原地淡到 0（kit List 的 .foldBody），离开的那一份看不见，N1 那套量不到东西；
//   打勾单独量收起那一段（主持人 11-17 复审必改 A）：这一行高度单调降到约 0、下一行 top 单调上移、卸载前后下一行跳动 ≤ 1px、离开的那一份不透明度从不超过 0.25
// • N1 补帧（MOTION-n1-load-flaky）：离开那一项一挂上 leaving 就当场补量一帧（退场进度 0）。补帧只用来垫不透明度的历史（让之后 LAG_MS 窗口里的
//   rAF 帧按它算），不计入“取到看得清的帧”（seen 只数 rAF 帧）：补帧拿的是上一帧别的行的位置，只认得出“离开那一项自己跳位”，
//   认不出“别的行不走 FLIP、直接跳上来压住残影”（首屏判断放宽与推送认领核对审查 M1）。一次都没取到看得清的 rAF 帧（机器忙、帧落不进淡出那一百来毫秒）
//   就重做那一下，最多 GHOST_TRIES 次，还取不到就挂“没测到”，不放过去；每一次里出现的压字都算
// • MOTION-②-low（FA-6 ② 审查 L5，并入 M1、M2 高负载偶发）：
//   - 每帧取样的时间用读样式那一刻的 performance.now()，不用 rAF 回调的 now（帧开始的时间；忙的时候回调晚几十毫秒，会把晚的样子记早）；
//   - M1 头 200 ms 里取不到 2 帧就重做，最多 GHOST_TRIES 次，还不够就挂“没测到”；
//   - motionReady 等 <html data-motion="ready"> 再等三帧，不靠资源记录加固定 300 ms（CPU 降速 4、6 倍时 300 ms 不够，
//     功能包没装齐就开始测，M2 会把“组标题没走 FLIP、直接到位”的样子当成压字）
// 示例待办和 FA-5 连续帧同一份（docs/02-设计/当前界面截图-1104/动效-*.png）
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { swipeRow } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const UI_MS = 220;
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 86400000));
const TD = [
  { ...base, id: 't1', title: '交周报', project: 'NEOX', due: day(-2), due_time: null, done: false },
  { ...base, id: 't2', title: '订机票', project: '旅行', due: day(0), due_time: null, done: false }, // 不带时刻：原来的 23:30 一过，它也进“没赶上”，P2 那条整组不离开（CI 11-11 首尔 23:42 挂过）
  { ...base, id: 't3', title: '买牛奶', project: '', due: day(0), due_time: null, done: false },
  { ...base, id: 't4', title: '整理照片', project: '', due: null, due_time: null, done: false },
  { ...base, id: 't5', title: '回邮件', project: '', due: null, due_time: null, done: true, done_at: Date.now() - 3600000 },
];

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await idbPut(page, TD.map((r) => ['todos', cached(r)] as const));
  await page.reload();
  await page.getByTestId('todos-row-t1').waitFor({ timeout: 30000 });
  await page.getByTestId('todos-g-done').waitFor();
  await motionReady(page);
}

/**
 * 等动效功能包下载完、装上（B2 FA-6 ②：功能包在首屏画出后才异步下载，src/motion/features.ts）。
 * 这里测的是功能包到了以后的手感；没到之前删掉的行当场移除、没有淡出，那一段不归这些用例管（见 FA-6 执行说明“② 的连续帧对照”）。
 * 等的是 features.ts 在包到了时打的 <html data-motion="ready">（FA-6 ② 审查 L5，不再靠资源加载记录加固定 300 ms）：
 * 标记打在包到的那一轮，各个 LazyMotion 在之后那轮 then 里装上、React 再提交一次，所以看到标记以后再等三帧
 */
async function motionReady(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30000 });
  await page.evaluate(
    () =>
      new Promise<void>((ok) => {
        let n = 0;
        const step = (): void => {
          n += 1;
          if (n >= 3) ok();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
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
      const r0 = `[data-testid="${root}"]`;
      const label = (e: Element): string => e.getAttribute('data-testid') ?? e.textContent?.slice(0, 6) ?? '';
      type Other = { el: Element; rects: DOMRect[] };
      /** 别的看得见的行、组标题（行都是 li——两页的 AppearItem 默认画成 li；组标题都是 h2）和它们此刻的文字矩形 */
      const othersNow = (): Other[] =>
        [...document.querySelectorAll(`${r0} li, ${r0} h2`)]
          .filter((o) => !o.closest('[data-state="leaving"]') && alpha(o) > 0.01)
          .map((el) => ({ el, rects: textRects(el) }));
      const hitsOf = (g: Element, others: Other[]): string[] => {
        const gt = textRects(g);
        return others.filter((o) => !o.el.contains(g) && !g.contains(o.el) && o.el !== g && gt.some((a) => o.rects.some((b) => cross(a, b)))).map((o) => label(o.el));
      };
      /** 上一帧（画到屏幕上的那一帧）别的行、组标题的文字位置，补“退场进度 0”那一帧时用 */
      let lastOthers: Other[] = [];
      /** 正在离开、还没淡完的行或整组，逐个和别的看得见的行、组标题比字（门槛在 Node 这边按 LAG_MS 窗口取最大后再判） */
      const ghostSample = (dt: number): void => {
        const ghosts = [...document.querySelectorAll(`${r0} [data-state="leaving"]`)].filter((g) => alpha(g) > 0.01);
        const others = othersNow();
        lastOthers = others;
        w.__samples?.push([dt, ghosts.map((g) => [label(g), alpha(g), hitsOf(g, others)])]);
      };
      // MOTION-n1-load-flaky：按动画进度、不按墙钟补一帧。webkit 忙的时候 rAF 间隔会拉到 50～90 ms，离开那一项“看得清”（> 0.25）
      // 的几十毫秒可能一帧都落不进去，原来就会报“没取到看得清的帧”。所以离开那一项一挂上 data-state="leaving"（退场进度 0、最不透明），
      // 就当场补量一次：离开那一项此刻的字（popLayout 让它原地不动）对上一帧画出来的别的行、组标题的字。
      // 不能拿别的行“此刻”的位置比——DOM 刚变时它们已经排到新位置、Motion 的 FLIP 反向位移还没套上，这个样子不会画到屏幕上；
      // 退场进度 0 那一帧屏幕上的别的行还在原位，正是上一帧的位置。之后的帧照旧每帧取（Node 那边按时间排序后再判）
      if (kind === 'ghost') {
        const seenLeaving = new WeakSet<Element>();
        const mo = new MutationObserver(() => {
          const t0 = w.__t0;
          if (t0 === undefined) return;
          const fresh = [...document.querySelectorAll(`${r0} [data-state="leaving"]`)].filter((g) => !seenLeaving.has(g));
          if (!fresh.length) return;
          for (const g of fresh) seenLeaving.add(g);
          const dt = performance.now() - t0;
          if (dt >= ms) {
            mo.disconnect();
            return;
          }
          // 第三项标成补帧：Node 那边不计入 seen（见文件头）
          w.__samples?.push([dt, fresh.map((g) => [label(g), alpha(g), hitsOf(g, lastOthers)]), 'patch']);
        });
        const host = document.querySelector(r0);
        if (host) mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
        setTimeout(() => mo.disconnect(), ms + 2000);
      }
      const tick = (): void => {
        const t0 = w.__t0;
        if (t0 === undefined) {
          if (kind === 'ghost') lastOthers = othersNow();
          requestAnimationFrame(tick);
          return;
        }
        // 用读样式这一刻的时间，不用 rAF 回调给的 now（MOTION-②-low，并入的 M1 偶发）：now 是这一帧开始的时间，
        // 机器忙时回调要晚几十毫秒才轮到，读到的其实是更晚的样子，按 now 记会把“250 ms 时的样子”记成 150 ms
        const dt = performance.now() - t0;
        if (kind === 'ghost') {
          ghostSample(dt);
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

/** [距松手毫秒, 每个离开中的元素 [名字, 当帧不透明度, 压到的], 'patch' 表示补帧（不计入 seen）] */
type GhostFrame = [number, [string, number, string[]][], 'patch'?];
/** 合成器上的不透明度比主线程读到的晚多少（约两帧） */
const LAG_MS = 34;
/** 每一帧：离开的那一项“往前 LAG_MS 以内最大的不透明度”> 0.25 时，它的字压到别人的字就记一条（见文件头） */
function ghostHits(raw: GhostFrame[]): { seen: number; bad: string[]; trace: string } {
  // rAF 的帧和 MutationObserver 补的那一帧混在一起，按时间排好再算窗口
  const s = [...raw].sort((x, y) => x[0] - y[0]);
  const hist = new Map<string, [number, number][]>();
  let seen = 0;
  const bad: string[] = [];
  for (const [dt, info, src] of s) {
    for (const [id, a, hits] of info) {
      const h = [...(hist.get(id) ?? []), [dt, a] as [number, number]].filter(([t]) => t >= dt - LAG_MS);
      hist.set(id, h);
      const eff = Math.max(...h.map(([, x]) => x));
      if (eff <= 0.25) continue;
      if (src !== 'patch') seen += 1;
      if (hits.length) bad.push(`松手后 ${dt.toFixed(0)} ms，${id} 不透明度按 ${eff.toFixed(2)} 算（当帧 ${a.toFixed(2)}），压到 ${hits.join('、')}`);
    }
  }
  const trace = s.map(([dt, info, src]) => `${src === 'patch' ? '补' : ''}${dt.toFixed(0)}${info.length ? ':' + info.map(([, a]) => a.toFixed(2)).join('/') : ''}`).join(' ');
  return { seen, bad, trace };
}

/** N1 一次都没取到看得清的 rAF 帧时最多重做几次（见文件头） */
const GHOST_TRIES = 3;

/**
 * 做一次 N1：prepare（回到起点）→ 开始取样 → act（打勾、删除）→ 判。seen 为 0 就从 prepare 重来，最多 GHOST_TRIES 次。
 * 返回各次的压字（带第几次）、最后一次的 seen 和每次的取样
 */
/** ms：从动手起取样多久（打勾要等停留、收起完才离开，比删除晚：kit useDoneFlow 的 HOLD_MS + OUT_MS） */
async function ghostRun(page: Page, root: string, prepare: () => Promise<void>, act: () => Promise<void>, ms = 900): Promise<{ seen: number; bad: string[]; traces: string[] }> {
  const bad: string[] = [];
  const traces: string[] = [];
  let seen = 0;
  for (let i = 1; i <= GHOST_TRIES && seen === 0; i += 1) {
    await prepare();
    await startSampler(page, 'ghost', '', ms, root);
    await act();
    const r = ghostHits(await samples<GhostFrame>(page, ms));
    seen = r.seen;
    bad.push(...r.bad.map((b) => `第 ${i} 次：${b}`));
    traces.push(`第 ${i} 次：${r.trace}`);
  }
  return { seen, bad, traces };
}

test.describe('待办列表动效（B2 FA-5 设计审查 M1、M2，第二轮 N1、L2）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: TZ, locale: 'zh-CN' });

  test('M1 打勾后头 220 ms 里“已完成”组不动，之后只往上走、不回退', async ({ page }) => {
    // 头 200 ms 里要至少取到 2 帧才算测到；机器忙、松手后第一帧就晚过 200 ms 时从头重做（MOTION-②-low：
    // 取样时间改成读样式那一刻以后，忙的时候早段可能一帧都没有，原来按 rAF 的 now 记会把晚到的帧记早、误报“组动了”）
    let before = 0;
    let s: [number, number | null][] = [];
    let head: [number, number | null][] = [];
    const counts: number[] = [];
    for (let i = 0; i < GHOST_TRIES && head.length < 2; i += 1) {
      await seed(page);
      before = await page.getByTestId('todos-g-done').evaluate((g) => g.getBoundingClientRect().top);
      await startSampler(page, 'done-group', 't4', 900);
      await page.getByTestId('todos-done-t4').click();
      s = await samples<[number, number | null]>(page, 900);
      head = s.filter(([dt]) => dt < UI_MS - 20);
      counts.push(head.length);
    }
    // 门槛为什么是 2 帧（原来是“> 3 帧”，审查 L-7 要求写明）：要证明的是“头 UI_MS - 20 ms 里组一直没动”，1 帧只是一个点，
    // 碰巧取在动之前也会过；2 帧起才算看过一段时间。再往上要求，高负载时这段里本来就只出得来两三帧，会误报“没测到”。
    // 取不够 2 帧不算过：整段重做（最多 GHOST_TRIES 次），还不够就判失败，不会把“没测到”当成“没动”
    expect(head.length, `做了 ${counts.length} 次，头 ${UI_MS - 20} ms 里取到的帧数 ${counts.join('、')}：没测到`).toBeGreaterThanOrEqual(2);
    for (const [dt, top] of head) expect(top, `松手后 ${dt.toFixed(0)} ms`).toBeCloseTo(before, 0);
    // 之后只往上走一次、不往回退（第二轮 L2）
    const tail = s.filter(([dt, top]) => dt >= UI_MS && top !== null) as [number, number][];
    for (let i = 1; i < tail.length; i += 1) {
      const [dt, top] = tail[i] as [number, number];
      expect(top, `松手后 ${dt.toFixed(0)} ms“已完成”组往回退了`).toBeLessThanOrEqual((tail[i - 1] as [number, number])[1] + 0.5);
    }
    // 收尾（负责人 11-17 分镜）：停留、收起以后 t4 进了“已完成”组（组默认收起，点开才看得到）；撤销条照旧开着（5 秒倒计时，R-460）
    await expect(page.getByTestId('todos-done-toast')).toBeVisible();
    await expect(page.getByTestId('todos-g-nodate').getByTestId('todos-row-t4')).toHaveCount(0);
    await expect(page.getByTestId('todos-done-fold')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 2');
    await expect(page.getByTestId('todos-row-t4')).toHaveCount(0);
    await page.getByTestId('todos-done-fold').click();
    await expect(page.getByTestId('todos-g-done').getByTestId('todos-row-t4')).toBeVisible();
  });

  // 删除：左滑一口气拉过大半行（负责人 11-15 去掉 ×，SwipeRow full），松手即删、即起点
  test('N1 删除：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字', async ({ page }) => {
    const { seen, bad, traces } = await ghostRun(page, 'todos', () => seed(page), () => swipeRow(page, 'todos-row-t3'));
    expect(bad).toEqual([]);
    expect(seen, `做了 ${GHOST_TRIES} 次都没取到离开那一项看得清的 rAF 帧（补帧不算，否则这条什么都没测）。取样：${traces.join(' ｜ ')}`).toBeGreaterThan(0);
  });

  // 打勾（负责人 11-17 分镜；主持人 11-17 复审必改 A）：勾上后停 720 ms，再原地收起 100 ms（data-out；负责人 11-17 参考视频“整行快速收起”），收完离开原组。
  // 离开的那一份在收起时已经淡到 0，N1 那套“离开那一项看得清的帧”量不到东西，所以打勾单独量收起这一段：
  // 从打上 data-out 起逐帧记 [距 data-out 毫秒, 这一行的高（还在原组时）, 下一行的 top（含 layout 的 transform）, 离开那一份行面的不透明度（自身连同祖先）]
  test('N1 打勾：收起时这一行高度单调降到约 0、下一行单调上移，卸载前后下一行不跳；离开的那一份看不见', async ({ page, browserName }) => {
    // CI 的 webkit 跳过（chromium、本机 webkit 照跑）：收起只有 --dur-collapse 100 ms，CI 的 Linux webkit 没有 GPU，在关模糊名单里也一样
    // 两帧之间仍隔 120～170 ms，三次重做都只取到 2 帧（11-18 run 44168443536：0:56.0 13:40.9 180:-），这条量不出东西
    test.skip(browserName === 'webkit' && process.env.CI === 'true', 'CI webkit 两帧间隔比 100 ms 收起还长，逐帧断言量不到');
    type F = [number, number | null, number | null, number | null];
    let frames: F[] = [];
    for (let i = 0; i < GHOST_TRIES && frames.filter((f) => f[1] !== null).length < 3; i += 1) {
      await seed(page);
      const g = page.getByTestId('todos-g-today');
      const ids = await g.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id') ?? ''));
      expect(ids.length).toBeGreaterThanOrEqual(2);
      const [me, next] = ids as [string, string];
      await page.evaluate(
        ({ me, next }) => {
          type W = Window & { __col?: unknown[] };
          const w = window as W;
          w.__col = [];
          const host = document.querySelector('[data-testid="todos-g-today"]');
          const alpha = (el: Element | null): number => {
            let a = 1;
            for (let e = el; e; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
            return a;
          };
          let t0 = -1;
          const tick = (): void => {
            const dt = performance.now() - t0;
            const row = host?.querySelector(`[data-row-id="${me}"]:not([data-state="leaving"])`);
            const ghost = document.querySelector(`[data-row-id="${me}"][data-state="leaving"]`);
            const nx = host?.querySelector(`[data-row-id="${next}"]:not([data-state="leaving"])`);
            // 淡出写在行面（li 里唯一的 .foldBody）上，所以从它往上乘
            w.__col?.push([dt, row ? row.getBoundingClientRect().height : null, nx ? nx.getBoundingClientRect().top : null, ghost ? alpha(ghost.firstElementChild ?? ghost) : null]);
            if (dt < 900) requestAnimationFrame(tick);
          };
          const mo = new MutationObserver(() => {
            if (!host?.querySelector(`[data-row-id="${me}"][data-out]`)) return;
            mo.disconnect();
            t0 = performance.now();
            tick();
          });
          if (host) mo.observe(host, { subtree: true, attributes: true, attributeFilter: ['data-out'] });
        },
        { me, next },
      );
      await page.getByTestId(`todos-done-${me}`).click();
      await expect.poll(() => page.evaluate(() => {
        const c = (window as Window & { __col?: [number][] }).__col ?? [];
        return c.length ? (c[c.length - 1]?.[0] ?? 0) : 0;
      }), { timeout: 5000 }).toBeGreaterThanOrEqual(900);
      frames = (await page.evaluate(() => (window as Window & { __col?: unknown[] }).__col ?? [])) as F[];
    }
    const trace = frames.map(([t, h, y, a]) => `${t.toFixed(0)}:${h?.toFixed(1) ?? '-'}/${y?.toFixed(1) ?? '-'}/${a?.toFixed(2) ?? '-'}`).join(' ');
    const present = frames.filter((f) => f[1] !== null);
    expect(present.length, `收起期间取到的帧不够：${trace}`).toBeGreaterThanOrEqual(3);
    // ① 高度单调下降，最后一帧降到约 0（li 只剩 1px 透明下边线）
    for (let k = 1; k < present.length; k += 1) expect(present[k]![1]!, `高度回升：${trace}`).toBeLessThanOrEqual(present[k - 1]![1]! + 0.5);
    expect(present[present.length - 1]![1]!, `没降到约 0：${trace}`).toBeLessThanOrEqual(2);
    expect(present[0]![1]!, `一开始就没有高度，什么都没量到：${trace}`).toBeGreaterThan(20);
    // ② 下一行的 top 单调往上
    const ys = frames.map((f) => f[2]).filter((y): y is number => y !== null);
    for (let k = 1; k < ys.length; k += 1) expect(ys[k]!, `下一行往回退：${trace}`).toBeLessThanOrEqual(ys[k - 1]! + 0.5);
    // ③ 这一行卸载（离开原组）前后，下一行跳动不超过 1px
    const cut = frames.findIndex((f) => f[1] === null);
    expect(cut, `900 ms 里这一行没离开原组：${trace}`).toBeGreaterThan(0);
    const before = frames[cut - 1]![2];
    const after = frames.slice(cut).find((f) => f[2] !== null)?.[2];
    expect(before).not.toBeNull();
    expect(after).toBeDefined();
    expect(Math.abs(after! - before!), `卸载前后下一行跳了：${trace}`).toBeLessThanOrEqual(1);
    // ④ 离开的那一份看不见：不透明度从来不超过 0.25（seen === 0）
    const seen = frames.filter((f) => f[3] !== null && f[3] > 0.25).length;
    expect(seen, `离开的那一份看得见：${trace}`).toBe(0);
  });

  test('N1 今天页“没赶上”最后一条打勾：整组离开，不透明度 > 0.25 的每一帧，它的字不压“今天的安排”等别的字（第三轮 P2）', async ({ page }) => {
    const prepare = async (): Promise<void> => {
      await seed(page);
      await page.goto('/app/#/today');
      await page.getByTestId('today-late').waitFor({ timeout: 30000 });
      // 今天页的数据是进页面后才到的：“没赶上”整组可能是进场中（entering，透明、不接点按），等它和里面的行都进场完、页面停稳再取样
      await expect(page.locator('[data-testid="today"] [data-state="entering"]')).toHaveCount(0);
      await page.waitForTimeout(500);
    };
    // 只点没在离开中的那一份（代码审查 FA5-CR A4：打勾后退场和进场会短暂同时有两个 today-done-<id>）。
    // 11-17 起今天页的待办行是 kit TodoRow：先停 720 ms、原地收起 100 ms 才整组离开，取样拉到 1600 ms
    const { seen, bad, traces } = await ghostRun(page, 'today', prepare, () => page.locator('[data-testid="today-done-t1"]:not([data-state="leaving"] *)').click(), 1600);
    expect(bad).toEqual([]);
    expect(seen, `做了 ${GHOST_TRIES} 次都没取到离开那一组看得清的 rAF 帧（补帧不算，否则这条什么都没测）。取样：${traces.join(' ｜ ')}`).toBeGreaterThan(0);
    await expect(page.getByTestId('today-late')).toHaveCount(0);
  });

  test('M2 撤销恢复：新行看得见的每一帧都不和别的行、组标题重叠', async ({ page }) => {
    await seed(page);
    await swipeRow(page, 'todos-row-t3');
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
