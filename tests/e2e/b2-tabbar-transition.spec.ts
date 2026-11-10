// 液态玻璃底栏在切页时的样子和点按（B2 FA-7；负责人 11-06 选方案 B，B2-动效审查-切页先出后入.md 第四批）；别的底栏用例见 b2-tabbar.spec.ts。
// • 四个页签之间互切不起 View Transition：新页直接换上，main 做一次 opacity 0→1；底栏、“＋”、液滴一直是真元素、一直实时模糊，液滴连续滑、能被下一次点按打断
// • 进出没有底栏的页（今天 → 编辑页）照旧 View Transition：圆角和阴影画在快照自己身上，组上没有阴影，只有一边有底栏时不剩空阴影壳（代码审查 M5）
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';


/** 液滴抽查用的进度点（占过渡时长的比例） */
const PROBE_AT = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85] as const;
/** 淡入抽查用的进度点：每 5% 一个，中途哪里先变暗都抓得到（只抽 6 个点时，起点到 10% 之间先暗再亮会漏掉） */
const FADE_AT = Array.from({ length: 19 }, (_, k) => (k + 1) * 0.05);

/**
 * 点页签以后每一帧记一次：有没有 View Transition、页面上几个 main、main 的不透明度、液滴横向位置、底栏和“＋”的 backdrop-filter 计算值，
 * 液滴的过渡这一帧是不是真在跑（running 且 currentTime > 0）。
 * 另外按动画自己的进度抽查（CI 机器慢、帧很稀时逐帧采样会整段漏掉 0.22 秒的淡入，7e197ea CI）：
 * • 新页淡入：包一层 Element.prototype.animate，main 一建淡入动画就先读一次起点（fadeSwap 跳过第一帧后的位置），再暂停、按 FADE_AT 把 currentTime 拨到各点读 opacity，拨回原处接着放
 * • 液滴：transitionrun（translate）时从 getAnimations() 拿到这次过渡，同样按进度读横向位置，再拨回接着放
 * 抽查在同一个任务里同步做完（暂停、拨时间读值、拨回原处、接着放），这期间不出帧，看不到拨过去的样子；
 * 动画会被往后推抽查本身花的那一点时间（一般不到 1 ms，慢机器上几毫秒），起止值、曲线、时长都不变
 */
const sampleAfterClick = (page: Page, name: string, ms: number, minMove = 0) =>
  page.evaluate(
    async ({ name, ms, at, fadeAt, minMove }) => {
      const nav = document.querySelector<HTMLElement>('[data-testid="tabbar"]');
      // 液滴每次现查：首屏后部分晚到时（冷启动的头一两遍）液滴元素会换一个，开头查一次会盯着已经摘掉的旧元素
      const dropEl = (): HTMLElement | null | undefined => nav?.querySelector<HTMLElement>('[class*="_drop_"]');
      const add = document.querySelector<HTMLElement>('[data-testid="tabbar-add"]');
      const rows: { t: number; tl: number; vt: number; mains: number; op: number; x: number; fx: string; addFx: string; dataVt: boolean; run: boolean; pg: number }[] = [];
      // runTl：液滴这次过渡开始（transitionrun）那一刻的动画时钟；之后的帧就是过渡已经在跑的帧（CI 无 GPU 的 WebKit 开着模糊只有个位数帧率，
      // 整段过渡可能落在两次采样之间，逐帧的 run 一帧都抓不到；按事件时刻认，不靠帧率）
      // dropDur：液滴这次过渡的时长（ms），和 runTl 一起算“过渡进行中”那一段
      const probe: { fade: number[] | null; drop: number[] | null; runTl: number | null; dropDur: number } = { fade: null, drop: null, runTl: null, dropDur: 0 };
      const dropAnim = (): Animation | undefined => dropEl()?.getAnimations().find((a) => (a as CSSTransition).transitionProperty === 'translate');
      /** 暂停 a，按进度拨到 pts 各点读 read()，拨回原处接着放；withStart 时先读一次当前位置，并跳过它之前的点 */
      const scan = (a: Animation, read: () => number, pts: number[], withStart: boolean): number[] => {
        const total = Number(a.effect?.getComputedTiming().duration ?? 0);
        const cur = a.currentTime;
        const wasRunning = a.playState === 'running';
        const r3 = (): number => Math.round(read() * 1000) / 1000;
        const out = withStart ? [r3()] : [];
        a.pause();
        for (const f of pts) {
          if (withStart && f * total <= Number(cur ?? 0)) continue;
          a.currentTime = f * total;
          out.push(r3());
        }
        a.currentTime = cur;
        if (wasRunning) a.play();
        return out;
      };
      const proto = Element.prototype;
      const origAnimate = proto.animate;
      const patched = function (this: Element, ...args: Parameters<Element['animate']>) {
        const a = origAnimate.apply(this, args);
        const el = (a.effect as KeyframeEffect | null)?.target;
        if (probe.fade === null && el?.tagName === 'MAIN') {
          // 等调用方把起点拨好（fadeSwap 跳过第一帧）再抽查
          queueMicrotask(() => {
            probe.fade = scan(a, () => Number(getComputedStyle(el).opacity), fadeAt, true);
          });
        }
        return a;
      };
      /** 液滴的过渡有了就按进度抽查一次（只做一次） */
      const scanDrop = (): void => {
        const a = dropAnim();
        const d = dropEl();
        if (probe.drop === null && a && d) {
          probe.dropDur = Number(a.effect?.getComputedTiming().duration ?? 0);
          probe.drop = scan(a, () => d.getBoundingClientRect().x, at, false);
        }
      };
      const nowTl = (): number => Number(document.timeline.currentTime ?? performance.now());
      // transitionrun 会冒泡：挂在底栏上，液滴换了元素也收得到
      const onRun = (e: TransitionEvent): void => {
        if (e.propertyName !== 'translate' || e.target !== dropEl()) return;
        probe.runTl ??= nowTl();
        scanDrop();
      };
      // 第几个 main 元素（换页时 main 换成新元素）：逐帧看新页自己的不透明度
      // 点下去以后才认“过渡在跑”：点之前上一次切页的液滴可能还在回弹
      let clicked = false;
      let lastMain: Element | null = null;
      let pg = 0;
      const take = (t0: number): void => {
        const main = document.querySelector('main');
        if (main !== lastMain) {
          lastMain = main;
          pg += 1;
        }
        const da = dropAnim();
        // 没收到 transitionrun（WebKit 偶尔不派）、这一帧却看到过渡在跑：从这一帧起算，照样按进度抽查
        if (clicked && da && da.playState === 'running') {
          probe.runTl ??= nowTl() - 0.001;
          scanDrop();
        }
        const drop = dropEl();
        rows.push({
          t: performance.now() - t0,
          // 动画用的时钟（一帧之内不变）：慢机器上两次读数之间隔了几帧要按它算，按 performance.now() 会把上一帧的旧位置当成刚读的
          tl: Number(document.timeline.currentTime ?? performance.now()),
          vt: document.getAnimations().filter((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')).length,
          mains: document.querySelectorAll('main').length,
          op: main ? Number(getComputedStyle(main).opacity) : -1,
          x: drop ? drop.getBoundingClientRect().x : NaN,
          fx: nav ? getComputedStyle(nav).backdropFilter : '',
          addFx: add ? getComputedStyle(add).backdropFilter : 'none-add',
          dataVt: document.documentElement.hasAttribute('data-vt'),
          run: da !== undefined && da.playState === 'running' && Number(da.currentTime ?? 0) > 0,
          pg,
        });
      };
      // 先等一帧再记起点、再点：webkit 主线程忙时动画时钟只在出帧时走，直接读拿到的是好几帧以前的位置，
      // 液滴的新过渡却从屏上真实位置起步，看起来像打断那一下跳了一截（慢机模拟实测）
      await new Promise((r) => requestAnimationFrame(r));
      const t0 = performance.now();
      try {
        // 打补丁、挂监听都放在 try 里：中途出错也会在 finally 里还原（代码审查 11-06）
        proto.animate = patched;
        nav?.addEventListener('transitionrun', onRun);
        take(t0);
        nav?.querySelector<HTMLElement>(`a[data-tab="${name}"]`)?.click();
        clicked = true;
        // minMove：至少采 ms 毫秒，而且液滴离开起点 minMove pt 以后才停（慢机器上液滴晚起步，只采固定时长可能还没动；最多 2 秒）
        const moved = (): boolean => Math.abs((rows.at(-1)?.x ?? 0) - (rows[0]?.x ?? 0)) >= minMove;
        while (performance.now() - t0 < ms || (!moved() && performance.now() - t0 < 2000)) {
          await new Promise((r) => requestAnimationFrame(r));
          take(t0);
        }
      } finally {
        proto.animate = origAnimate;
        nav?.removeEventListener('transitionrun', onRun);
      }
      return { rows, probe };
    },
    { name, ms, at: [...PROBE_AT], fadeAt: FADE_AT, minMove },
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
      const { rows, probe } = await sampleAfterClick(page, name, 700);
      await expect(page.locator(testid === 'cal' ? 'main[data-feature="calendar"]' : `[data-testid="${testid}"]`)).toBeVisible();
      // 逐帧都要满足的（帧再稀也照查）：不起 View Transition、两页不同时在屏上（叠字）、底栏和“＋”一直实时模糊、没有整页透明的一帧、最后不透明
      expect(rows.every((r) => r.vt === 0 && !r.dataVt), `${name}：起了 View Transition`).toBe(true);
      expect(rows.every((r) => r.mains <= 1), `${name}：两页同时在屏上`).toBe(true);
      // 底栏和“＋”一直带 backdrop-filter（不进快照，实时模糊）；随手记没有“＋”
      expect(rows.every((r) => r.fx.includes('blur(')), `${name}：底栏某一帧没有 backdrop-filter ${JSON.stringify(rows.map((r) => r.fx))}`).toBe(true);
      expect(rows.every((r) => r.addFx === 'none-add' || r.addFx.includes('blur(')), `${name}：“＋”某一帧没有 backdrop-filter`).toBe(true);
      const after = rows.slice(1).filter((r) => r.op >= 0);
      // 淡入放完以后整页不透明（慢机器上采样窗口里可能还没放完，所以等动画结束再查，不看采样最后一帧）
      await expect.poll(() => page.evaluate(() => { const m = document.querySelector('main'); return m && m.getAnimations().length === 0 ? Number(getComputedStyle(m).opacity) : -1; }), { timeout: 5000 }).toBe(1);
      // 没有空白帧：淡入跳过 opacity 0 的第一帧（motion FADE_SKIP_MS），点完以后每一帧新页都看得见
      expect(after.every((r) => r.op > 0.1), `${name}：有整页透明的一帧 ${JSON.stringify(after.map((r) => r.op))}`).toBe(true);
      // 逐帧看新页自己（最后那个 main 元素）：只亮不暗——新页先实心露一帧、再从透明淡入（“先实心再透明”）在这里抓
      const pgLast = rows.at(-1)?.pg ?? 0;
      const own = rows.filter((r) => r.pg === pgLast && r.op >= 0).map((r) => r.op);
      expect(own.every((v, k) => k === 0 || v >= (own[k - 1] ?? 0) - 0.001), `${name}：新页逐帧先亮后暗 ${JSON.stringify(own)}`).toBe(true);
      // 新页淡入（按动画进度抽查，不靠帧率）：真有这次淡入；起点和各点都在 0～1 之间、跟着进度只增不减（中途先暗再亮也抓），
      // 一开始明显没到 1（是淡入不是直接换上），中间值够多，后面比前面亮
      const fade = probe.fade;
      expect(fade, `${name}：新页没有淡入动画`).not.toBeNull();
      const fz = fade ?? [];
      expect(fz.every((v, k) => v > 0 && v <= 1 && (k === 0 || v >= (fz[k - 1] ?? 0) - 0.001)), `${name}：淡入不是从透明到不透明 ${JSON.stringify(fz)}`).toBe(true);
      expect(fz.filter((v) => v > 0.05 && v < 0.95).length, `${name}：淡入中间值太少 ${JSON.stringify(fz)}`).toBeGreaterThanOrEqual(3);
      expect(fz[0] ?? 1, `${name}：淡入一开始就几乎不透明 ${JSON.stringify(fz)}`).toBeLessThan(0.95);
      expect((fz.at(-1) ?? 0) - (fz[0] ?? 0), `${name}：淡入前后几乎没变 ${JSON.stringify(fz)}`).toBeGreaterThan(0.1);
      // 液滴连续滑：位置从过渡真正开始（running 且 currentTime > 0）以后的帧算起；每帧走的不超过总路程的一半（没有瞬移）；
      // --ease-drop 带一点回弹，允许冲过终点再回来，但不超过总路程的 15%，也不先往反方向走
      const x0 = rows[0]?.x ?? 0;
      // 过渡在跑的帧：逐帧看到 running 且 currentTime > 0，或者是过渡开始（transitionrun）以后的帧（帧很稀时逐帧可能一帧都抓不到）
      const runTl = probe.runTl;
      expect(runTl, `${name}：没看到液滴的过渡开始`).not.toBeNull();
      const k0 = rows.findIndex((r) => r.run || (runTl !== null && r.tl > runTl));
      expect(k0, `${name}：没看到液滴的过渡在跑`).toBeGreaterThan(0);
      // 至少有一帧落在过渡进行中（R-372 复审建议）：逐帧看到在跑，或者那一帧的时刻在过渡开始到结束之间；
      // 帧稀到整段过渡都落在两次采样之间时，逐帧那几条（没有瞬移、不越界、起步方向）就只看到起点和终点，测不到中段，这里拦下
      const dur = probe.dropDur;
      expect(dur, `${name}：没拿到液滴过渡的时长`).toBeGreaterThan(0);
      const inMid = rows.some((r) => r.run || (runTl !== null && r.tl > runTl && r.tl < runTl + dur));
      expect(inMid, `${name}：没有一帧落在液滴过渡进行中 ${JSON.stringify(rows.map((r) => Math.round(r.tl - (runTl ?? 0))))}（时长 ${dur}）`).toBe(true);
      const moving = rows.slice(k0);
      const xs = [x0, ...moving.map((r) => Math.round(r.x * 10) / 10)];
      const ts = [rows[0]?.tl ?? 0, ...moving.map((r) => r.tl)];
      const x1 = xs.at(-1) ?? 0;
      const total = Math.abs(x1 - x0);
      expect(total, `${name}：液滴没动`).toBeGreaterThan(40);
      const lo = Math.min(x0, x1) - total * 0.15;
      const hi = Math.max(x0, x1) + total * 0.15;
      expect(xs.every((x) => x >= lo && x <= hi), `${name}：液滴跑出了起点到终点之间 ${JSON.stringify(xs)}`).toBe(true);
      // 起步方向看第一个真正挪动的位置（液滴偶尔晚一帧起步，前几帧都还在起点；原来取第 3 帧会判成 0，11-06 偶发、7e197ea CI）
      const first = xs.find((x) => Math.abs(x - x0) > 0.5) ?? x0;
      expect(Math.sign(first - x0) === Math.sign(x1 - x0), `${name}：液滴先往反方向走 ${JSON.stringify(xs)}`).toBe(true);
      // 按每帧实际时长折算成 60Hz 一帧走多少（并发跑、CI 慢机器会丢帧，一次隔 50 ms 以上，不算瞬移）
      const steps = xs.slice(1).map((x, k) => ((x - (xs[k] ?? 0)) * 16.7) / Math.max(16.7, (ts[k + 1] ?? 0) - (ts[k] ?? 0)));
      expect(Math.max(...steps.map(Math.abs)), `${name}：液滴一帧跳了太远 ${JSON.stringify(xs)}`).toBeLessThan(total / 2);
      // 中途位置（按过渡进度抽查 6 个点，不靠帧率）：至少 5 个不同的位置、都在起点到终点之间（含 15% 回弹）、
      // 前半段一路朝终点走（不先往反方向、不原地不动），第一个点离终点还远（没有瞬移）
      const dz = probe.drop;
      expect(dz, `${name}：没抓到液滴的过渡`).not.toBeNull();
      const pz = (dz ?? []).map((x) => Math.round(x * 10) / 10);
      expect(new Set(pz).size, `${name}：液滴中途位置太少 ${JSON.stringify(pz)}`).toBeGreaterThanOrEqual(5);
      expect(pz.every((x) => x >= lo && x <= hi), `${name}：液滴中途跑出了起点到终点之间 ${JSON.stringify(pz)}`).toBe(true);
      const toward = (x: number): number => (x - x0) * Math.sign(x1 - x0);
      expect(toward(pz[0] ?? x0), `${name}：液滴先往反方向走 ${JSON.stringify(pz)}`).toBeGreaterThan(0);
      expect(toward(pz[0] ?? x0), `${name}：液滴一起步就到了终点（瞬移）${JSON.stringify(pz)}`).toBeLessThan(total * 0.9);
      for (let k = 1; k < 3; k += 1) expect(toward(pz[k] ?? 0), `${name}：液滴前半段没有一路朝终点走 ${JSON.stringify(pz)}`).toBeGreaterThan(toward(pz[k - 1] ?? 0));
    }
  });

  test('滑到一半点下一个页签：液滴从当前位置接着滑（被打断，不跳）；上一次的淡入取消，新页照样淡入', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const { rows: first } = await sampleAfterClick(page, 'notes', 120, 10);
    const { rows: second } = await sampleAfterClick(page, 'calendar', 700);
    await expect(page.locator('main[data-feature="calendar"]')).toBeVisible();
    const mid = first.at(-1)?.x ?? 0;
    const start = first[0]?.x ?? 0;
    expect(mid - start, '第一次还没滑到就停了').toBeGreaterThan(5);
    // 第二次从打断那一刻的位置接着走：每一帧（按实际帧时长折算成 60Hz）都不超过 25pt，没有先跳回起点或跳到终点
    // （打断后头一两帧液滴还带着往随手记去的速度，再掉头，是 CSS 过渡从当前值重新起步，正常）
    const jump = Math.max(...second.slice(1).map((r, k) => (Math.abs(r.x - (second[k]?.x ?? 0)) * 16.7) / Math.max(16.7, r.tl - (second[k]?.tl ?? 0))));
    expect(jump, `打断时液滴跳了 ${JSON.stringify(second.slice(0, 6).map((r) => [Math.round(r.tl - (second[0]?.tl ?? 0)), Math.round(r.x)]))}`).toBeLessThan(25);
    expect(second.every((r) => r.vt === 0)).toBe(true);
    await expect.poll(() => page.evaluate(() => { const m = document.querySelector('main'); return m && m.getAnimations().length === 0 ? Number(getComputedStyle(m).opacity) : -1; }), { timeout: 5000 }).toBe(1);
    expect(await page.evaluate(() => document.querySelector('main')?.getAnimations().length ?? -1)).toBe(0);
  });

  test('减少动态效果：页签互切直接换页，main 不做动画', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar')).toBeVisible(); // 底栏在页面画出来以后才挂，没挂上时点不到
    const { rows } = await sampleAfterClick(page, 'todos', 200);
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
    // B3 M4 起“＋”点一下打开打字条，“展开编辑”才换到新建日程页
    await page.getByTestId('tabbar-add').click();
    await expect(page.getByTestId('type-bar')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('type-bar').getByRole('button', { name: '展开编辑' }).click({ noWaitAfter: true });
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
