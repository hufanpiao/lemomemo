// 液态玻璃底栏在切页时的样子和点按（B2 FA-7；负责人 11-06 选方案 B，B2-动效审查-切页先出后入.md 第四批）；别的底栏用例见 b2-tabbar.spec.ts。
// • 四个页签之间互切不起 View Transition：新页直接换上，main 做一次 opacity 0→1；底栏、“＋”、液滴一直是真元素、一直实时模糊，液滴连续滑、能被下一次点按打断
// • 进出没有底栏的页（今天 → 编辑页）照旧 View Transition：圆角和阴影画在快照自己身上，组上没有阴影，只有一边有底栏时不剩空阴影壳（代码审查 M5）
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';
import { waitPreloaded } from './page-helpers.ts';

// 失败时带运行日志、控制台错误（B4b-3 返工第三条）
logOnFail(test);


/** 液滴抽查用的进度点（占过渡时长的比例） */
const PROBE_AT = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85] as const;
/** 淡入抽查用的进度点：每 5% 一个，中途哪里先变暗都抓得到（只抽 6 个点时，起点到 10% 之间先暗再亮会漏掉） */
const FADE_AT = Array.from({ length: 19 }, (_, k) => (k + 1) * 0.05);
/** 新页淡入最晚什么时候建（ms，从点按算）：fadeSwap 等新页最多 FADE_WAIT_MS（src/motion/index.ts，1500），再留 300 余量 */
const FADE_LATEST_MS = 1500 + 300;

/**
 * 点页签以后每一帧记一次：有没有 View Transition、页面上几个 main、main 的不透明度、液滴横向位置、底栏和“＋”的 backdrop-filter 计算值，
 * 液滴的过渡这一帧是不是真在跑（running 且 currentTime > 0）。
 * 另外按动画自己的进度抽查（CI 机器慢、帧很稀时逐帧采样会整段漏掉 0.22 秒的淡入，7e197ea CI）：
 * • 新页淡入：包一层 Element.prototype.animate，main 一建淡入动画就先读一次起点（fadeSwap 跳过第一帧后的位置），再暂停、按 FADE_AT 把 currentTime 拨到各点读 opacity，拨回原处接着放。
 *   点完在同一个任务里再从 getAnimations() 取一次（同液滴）；新页分包晚到时 fadeSwap 等到新 main 出来才建淡入，可能晚过逐帧采样的窗口
 *   （11-10 镜像 b2 组 3.3 分钟那一遍：todos 首次进、probe.fade 为 null）：采样完还没取到就接着包着 animate 等，最多等到 FADE_LATEST_MS
 * • 液滴：在点页签的同一个任务里（click() 返回、还没出下一帧）从 getAnimations() 拿到这次过渡，同样按进度读横向位置，再拨回接着放。
 *   页签的点按是同步换路由、同步重画的，getAnimations() 会先把样式算好，这一刻过渡刚建好、还没开始走，帧再稀也不会已经放完
 *   （3f5c210 CI webkit：一帧 250～600 ms 时，等到 transitionrun 或下一帧再取，过渡已经放完、取不到；同 b2-tabbar:186 的做法）。
 *   点完当下没取到的，transitionrun 和逐帧看到在跑时照旧再试
 * 抽查在同一个任务里同步做完（暂停、拨时间读值、拨回原处、接着放），这期间不出帧，看不到拨过去的样子；
 * 动画会被往后推抽查本身花的那一点时间（一般不到 1 ms，慢机器上几毫秒），起止值、曲线、时长都不变
 */
/** waitFade：采样完还没取到淡入时接着等（只给要查淡入的用例；“打断”那条要马上点第二下，不能等） */
const sampleAfterClick = (page: Page, name: string, ms: number, minMove = 0, waitFade = false) =>
  page.evaluate(
    async ({ name, ms, at, fadeAt, minMove, fadeLatest }) => {
      const nav = document.querySelector<HTMLElement>('[data-testid="tabbar"]');
      // 液滴每次现查：首屏后部分晚到时（冷启动的头一两遍）液滴元素会换一个，开头查一次会盯着已经摘掉的旧元素
      const dropEl = (): HTMLElement | null | undefined => nav?.querySelector<HTMLElement>('[class*="_drop_"]');
      const add = document.querySelector<HTMLElement>('[data-testid="tabbar-add"]');
      const rows: { t: number; tl: number; vt: number; mains: number; ghosts: number; op: number; x: number; fx: string; addFx: string; dataVt: boolean; run: boolean; pg: number }[] = [];
      // runTl：液滴这次过渡开始（transitionrun）那一刻的动画时钟；之后的帧就是过渡已经在跑的帧（CI 无 GPU 的 WebKit 开着模糊只有个位数帧率，
      // 整段过渡可能落在两次采样之间，逐帧的 run 一帧都抓不到；按事件时刻认，不靠帧率）
      // dropDur：液滴这次过渡的时长（ms），和 runTl 一起算“过渡进行中”那一段
      // mainAt、fadeAt0：新页 main 出现、淡入建好的时刻（ms，从点按算；没出现是 -1），取不到淡入时带进报错
      const probe: { fade: number[] | null; drop: number[] | null; runTl: number | null; dropDur: number; mainAt: number; fadeAt0: number } = {
        fade: null, drop: null, runTl: null, dropDur: 0, mainAt: -1, fadeAt0: -1,
      };
      let tClick = 0;
      // 点之前的 main：只认换上来的新 main（旧页上没放完的淡入不算这次的）
      let before: Element | null = null;
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
        // 刚建好、还没开始走的过渡 currentTime 是 null（不能写回 null）：拨回 0，接着放就是从头开始，和没抽查过一样
        a.currentTime = cur ?? 0;
        if (wasRunning) a.play();
        return out;
      };
      const proto = Element.prototype;
      const origAnimate = proto.animate;
      const patched = function (this: Element, ...args: Parameters<Element['animate']>) {
        const a = origAnimate.apply(this, args);
        const el = (a.effect as KeyframeEffect | null)?.target;
        if (probe.fade === null && el?.tagName === 'MAIN') {
          if (probe.fadeAt0 < 0) probe.fadeAt0 = Math.round(performance.now() - tClick);
          // 等调用方把起点拨好（fadeSwap 跳过第一帧）再抽查
          queueMicrotask(() => {
            if (probe.fade !== null) return; // 点按同一个任务里 scanFade 已经取过
            probe.fade = scan(a, () => Number(getComputedStyle(el).opacity), fadeAt, true);
          });
        }
        return a;
      };
      /** 新页 main 上已经有淡入（点按同一个任务里）就按进度抽查一次；起点已由 fadeSwap 拨好，直接读 */
      const scanFade = (): void => {
        const m = document.querySelector('main');
        const a = m?.getAnimations().find((x) => (x.effect as KeyframeEffect | null)?.target === m && !(x instanceof CSSTransition));
        if (probe.fade === null && m && m !== before && a) {
          if (probe.fadeAt0 < 0) probe.fadeAt0 = Math.round(performance.now() - tClick);
          probe.fade = scan(a, () => Number(getComputedStyle(m).opacity), fadeAt, true);
        }
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
      /** 元素 translate 那一项的 transition-duration（ms）；transition-property 是 all 也算 */
      const cssDur = (el: HTMLElement): number => {
        const cs = getComputedStyle(el);
        const props = cs.transitionProperty.split(',').map((x) => x.trim());
        const durs = cs.transitionDuration.split(',').map((x) => x.trim());
        const k = props.findIndex((x) => x === 'translate' || x === 'all');
        const v = k < 0 ? '' : (durs[k % durs.length] ?? '');
        const n = v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000;
        return Number.isFinite(n) ? n : 0;
      };
      const nowTl = (): number => Number(document.timeline.currentTime ?? performance.now());
      // transitionrun 会冒泡：挂在底栏上，液滴换了元素也收得到
      const onRun = (e: TransitionEvent): void => {
        if (e.propertyName !== 'translate' || e.target !== dropEl()) return;
        probe.runTl ??= nowTl();
        scanDrop();
        // 帧很稀时收到 transitionrun 的回调里 getAnimations() 已经找不到这次过渡（CI 审查员 11-10）：时长退回读液滴算好的 transition-duration
        if (probe.dropDur <= 0) probe.dropDur = cssDur(e.target as HTMLElement);
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
          if (clicked && probe.mainAt < 0) probe.mainAt = Math.round(performance.now() - tClick);
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
          ghosts: document.querySelectorAll('[data-tab-ghost]').length,
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
        before = document.querySelector('main');
        tClick = performance.now();
        nav?.querySelector<HTMLElement>(`a[data-tab="${name}"]`)?.click();
        clicked = true;
        if (document.querySelector('main') !== before) probe.mainAt = 0;
        // 同一个任务里马上抽查液滴和淡入（见文件头）：这时还没出帧，过渡、淡入都不会已经放完
        scanDrop();
        scanFade();
        // minMove：至少采 ms 毫秒，而且液滴离开起点 minMove pt 以后才停（慢机器上液滴晚起步，只采固定时长可能还没动；最多 2 秒）
        const moved = (): boolean => Math.abs((rows.at(-1)?.x ?? 0) - (rows[0]?.x ?? 0)) >= minMove;
        while (performance.now() - t0 < ms || (!moved() && performance.now() - t0 < 2000)) {
          await new Promise((r) => requestAnimationFrame(r));
          take(t0);
        }
        // 新页分包晚到：淡入在新 main 出来时才建，接着包着 animate 等（不再记逐帧行，逐帧断言只看上面那段）
        while (probe.fade === null && performance.now() - tClick < fadeLatest) {
          await new Promise((r) => setTimeout(r, 16));
          if (probe.mainAt < 0 && document.querySelector('main') !== before) probe.mainAt = Math.round(performance.now() - tClick);
          scanFade();
        }
      } finally {
        proto.animate = origAnimate;
        nav?.removeEventListener('transitionrun', onRun);
      }
      return { rows, probe };
    },
    { name, ms, at: [...PROBE_AT], fadeAt: FADE_AT, minMove, fadeLatest: waitFade ? FADE_LATEST_MS : 0 },
  );

test.describe('底栏：页签互切（FA-7，方案 B）', () => {
  // 手机宽度的底栏：chromium 项目默认 1280 宽，那里是电脑版侧栏（D5，见 b2-sidebar.spec.ts）
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  test('页签互切不起 View Transition；新页淡入、页面上只有一个 main、旧页快照最多一份；底栏一直实时模糊；液滴连续滑', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 }); // 首屏后部分到了（实时模糊接管）
    await waitPreloaded(page); // 冷启动后台预加载三页跑完再量（page-helpers.ts 头注释）
    // 先把三个页签各进一遍，分包都到了再量：头一次进某页时分包晚到，fadeSwap 最多等 FADE_WAIT_MS（1500）就不放淡入、直接换上
    // （产品就是这么设计的；11-10 镜像负载重的一遍，日历的新页点后 1788 ms 才出来），那样这条查不到淡入。这里要查的是淡入本身，不是分包快慢
    for (const [name, testid] of [['todos', 'todos'], ['calendar', 'cal'], ['today', 'today']] as const) {
      await page.getByTestId('tabbar').locator(`a[data-tab="${name}"]`).click();
      await expect(page.locator(testid === 'cal' ? 'main[data-feature="calendar"]' : `[data-testid="${testid}"]`)).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => page.evaluate(() => document.querySelector('main')?.getAnimations().length ?? -1), { timeout: 5000 }).toBe(0);
    }
    await page.waitForTimeout(400);
    for (const [name, testid] of [['todos', 'todos'], ['calendar', 'cal'], ['today', 'today']] as const) {
      const { rows, probe } = await sampleAfterClick(page, name, 700, 0, true);
      await expect(page.locator(testid === 'cal' ? 'main[data-feature="calendar"]' : `[data-testid="${testid}"]`)).toBeVisible();
      // 逐帧都要满足的（帧再稀也照查）：不起 View Transition、页面上只有一个 main（旧页快照不是 main，pick 和 e2e 找得到真页面）、
      // 旧页快照最多一份（负责人 11-18 选切页方案 B：旧页反方向移出时和新页短暂重叠，这是 B 本身的样子）、底栏和“＋”一直实时模糊、没有整页透明的一帧、最后不透明
      expect(rows.every((r) => r.vt === 0 && !r.dataVt), `${name}：起了 View Transition`).toBe(true);
      expect(rows.every((r) => r.mains <= 1), `${name}：页面上有两个 main`).toBe(true);
      expect(rows.every((r) => r.ghosts <= 1), `${name}：旧页快照叠了不止一份`).toBe(true);
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('[data-tab-ghost]').length), { timeout: 5000 }).toBe(0);
      // 底栏和“＋”一直带 backdrop-filter（不进快照，实时模糊）；随手记没有“＋”
      expect(rows.every((r) => r.fx.includes('blur(')), `${name}：底栏某一帧没有 backdrop-filter ${JSON.stringify(rows.map((r) => r.fx))}`).toBe(true);
      expect(rows.every((r) => r.addFx === 'none-add' || r.addFx.includes('blur(')), `${name}：“＋”某一帧没有 backdrop-filter`).toBe(true);
      const after = rows.slice(1).filter((r) => r.op >= 0);
      // 淡入放完以后整页不透明（慢机器上采样窗口里可能还没放完，所以等动画结束再查，不看采样最后一帧）
      await expect.poll(() => page.evaluate(() => { const m = document.querySelector('main'); return m && m.getAnimations().length === 0 ? Number(getComputedStyle(m).opacity) : -1; }), { timeout: 5000 }).toBe(1);
      // 没有空白帧：新页和日历一样从透明起，那几帧旧页快照还盖着（快照前 2/3 才淡没）；新页还几乎透明时必须有快照
      expect(after.every((r) => r.op > 0.1 || r.ghosts >= 1), `${name}：有整页透明、也没有旧页快照的一帧 ${JSON.stringify(after.map((r) => [r.op, r.ghosts]))}`).toBe(true);
      // 逐帧看新页自己（最后那个 main 元素）：只亮不暗——新页先实心露一帧、再从透明淡入（“先实心再透明”）在这里抓
      const pgLast = rows.at(-1)?.pg ?? 0;
      const own = rows.filter((r) => r.pg === pgLast && r.op >= 0).map((r) => r.op);
      expect(own.every((v, k) => k === 0 || v >= (own[k - 1] ?? 0) - 0.001), `${name}：新页逐帧先亮后暗 ${JSON.stringify(own)}`).toBe(true);
      // 新页淡入（按动画进度抽查，不靠帧率）：真有这次淡入；起点和各点都在 0～1 之间、跟着进度只增不减（中途先暗再亮也抓），
      // 一开始明显没到 1（是淡入不是直接换上），中间值够多，后面比前面亮
      const fade = probe.fade;
      expect(fade, `${name}：新页没有淡入动画（新页 main 点后 ${probe.mainAt} ms 出现，淡入 ${probe.fadeAt0} ms 建好；-1 是没有）`).not.toBeNull();
      const fz = fade ?? [];
      expect(fz.every((v, k) => v >= 0 && v <= 1 && (k === 0 || v >= (fz[k - 1] ?? 0) - 0.001)), `${name}：淡入不是从透明到不透明 ${JSON.stringify(fz)}`).toBe(true);
      expect(fz.filter((v) => v > 0.05 && v < 0.95).length, `${name}：淡入中间值太少 ${JSON.stringify(fz)}`).toBeGreaterThanOrEqual(3);
      expect(fz[0] ?? 1, `${name}：淡入一开始就几乎不透明 ${JSON.stringify(fz)}`).toBeLessThan(0.95);
      expect((fz.at(-1) ?? 0) - (fz[0] ?? 0), `${name}：淡入前后几乎没变 ${JSON.stringify(fz)}`).toBeGreaterThan(0.1);
      // 液滴连续滑只按过渡进度抽查（下面 probe.drop，不靠帧率）：原来另有一遍逐帧量（过渡开始以后的帧、落在过渡进行中的帧、每帧走多远），
      // CI 的 WebKit 一帧几百毫秒，整段 0.55 s 落在两帧之间就挂（ci a424c819“没看到液滴的过渡在跑”）；那遍查的方向、越界、瞬移，按进度这遍都查（#129）
      const x0 = rows[0]?.x ?? 0;
      const x1 = rows.at(-1)?.x ?? 0;
      const total = Math.abs(x1 - x0);
      expect(total, `${name}：液滴没动`).toBeGreaterThan(40);
      const lo = Math.min(x0, x1) - total * 0.15;
      const hi = Math.max(x0, x1) + total * 0.15;
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
        // 等过渡开始放宽到 10 秒：cb2bac25 的 CI webkit 诊断“帧 278 | 帧 3379 | … | 调用 3407”——点下去后主线程整卡 3 秒
        // （无 GPU、backdrop-filter 软件合成，见 CI webkit 关模糊名单文件的头注释），startViewTransition 3.4 秒才调到，原来 2 秒等不到。
        // 切页过渡用例按规定不进关模糊名单（e2e-webkit-nofx.test.ts 禁 transition 文件名），所以只放宽等待；一出现过渡照旧当场暂停在 120 ms 读样式，断言不变
        { timeout: 10_000, polling: 4 },
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
    // 11-18 起打字条“展开编辑”直接换页、不起整页过渡（负责人录屏：闪一帧原页面；plus-expand-no-flash.spec.ts）。
    // 这条只测“一边有底栏的整页过渡”，改用地址栏换到新建日程（hashchange 照旧起 View Transition）
    // 诊断（11-16：CI webkit 自 b6832069 起连挂“没等到切页过渡”，本机和 CI 同款镜像都复现不了）：记下 startViewTransition 调没调、
    // ready / finished 什么时候结束（被跳过时 ready 会 reject）、点击后每帧的时间。只在这条没等到过渡时打进失败信息，下次 CI 挂了按它定根因
    await page.evaluate(() => {
      const w = window as unknown as { __vtdiag: string[] };
      const t0 = performance.now();
      const at = () => Math.round(performance.now() - t0);
      w.__vtdiag = [];
      const d = document as unknown as { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } };
      const orig = d.startViewTransition?.bind(document);
      if (!orig) w.__vtdiag.push('没有 startViewTransition');
      else
        d.startViewTransition = (cb) => {
          w.__vtdiag.push(`调用 ${at()}`);
          const vt = orig(cb);
          vt.ready.then(() => w.__vtdiag.push(`ready ${at()}`), (e: unknown) => w.__vtdiag.push(`ready 拒绝 ${at()} ${String(e).slice(0, 80)}`));
          vt.finished.then(() => w.__vtdiag.push(`finished ${at()}`), () => w.__vtdiag.push(`finished 拒绝 ${at()}`));
          return vt;
        };
      let n = 0;
      const tick = () => {
        n++;
        if (n <= 40) {
          w.__vtdiag.push(`帧 ${at()}`);
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
    await page.evaluate(() => {
      window.location.hash = '#/event/new';
    });
    const s = await holdAndRead(page).catch(() => null);
    const diag = s ? '' : await page.evaluate(() => (window as unknown as { __vtdiag?: string[] }).__vtdiag?.join(' | ') ?? '无');
    expect(s, `没等到切页过渡；诊断：${diag}`).not.toBeNull();
    expect(s?.group.shadow, '组上有阴影（只有一边有底栏时会剩空壳）').toBe('none');
    expect(s?.addGroup.shadow).toBe('none');
    expect(s?.old.shadow).not.toBe('none');
    expect(s?.old.overflow).toBe('clip');
    expect(s?.old.radius).not.toBe('0px');
    expect(s?.addOld.radius).toBe('50%');
    await finishAll(page);
    await expect(page).toHaveURL(/#\/event\/new$/);
  });

  test('键盘弹着（根节点 data-kbhide）时底栏不进快照：没有 view-transition-name，不会画出空阴影壳', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-add')).toBeVisible();
    const names = await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>('[data-testid="tabbar"],[data-testid="tabbar-add"]')];
      document.documentElement.setAttribute('data-kbhide', '1');
      const v = els.map((el) => getComputedStyle(el).viewTransitionName);
      document.documentElement.removeAttribute('data-kbhide');
      return { hidden: v, shown: els.map((el) => getComputedStyle(el).viewTransitionName) };
    });
    expect(names.hidden).toEqual(['none', 'none']);
    expect(names.shown).toEqual(['tabbar', 'tabbar-add']);
  });
});

test.describe('底栏：页签互切按底栏顺序左右滑入（负责人 11-18“底部导航栏的切换动画我想换一个方向滑入，之前的B方案”，取代 R-471 的淡入上移）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  /** 点页签（同一个任务里）读新页 main 里的动画和旧页快照的动画：谁在动、关键帧、时长，动的元素里有没有 position: fixed 的 */
  const clickAndRead = (page: Page, tab: string) =>
    page.evaluate((t) => {
      document.querySelector<HTMLElement>(`[data-testid="tabbar"] a[data-tab="${t}"]`)?.click();
      const m = document.querySelector('main');
      if (!m) return null;
      const hasFixed = (el: Element): boolean => [el, ...el.querySelectorAll('*')].some((x) => getComputedStyle(x).position === 'fixed');
      const read = (a: Animation) => {
        const e = a.effect as KeyframeEffect;
        const el = e.target as Element;
        return {
          main: el === m,
          frames: e.getKeyframes().map((k) => [k['opacity'] ?? null, k['filter'] ?? null, k['transform'] ?? null, k.offset ?? null]),
          easing: String(e.getTiming().easing),
          dur: Number(e.getTiming().duration),
          fixedInside: hasFixed(el),
        };
      };
      const all = document.getAnimations().filter((a) => !(a instanceof CSSTransition) && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element);
      return {
        page: all.filter((a) => m.contains((a.effect as KeyframeEffect).target as Element)).map(read),
        ghost: all.filter((a) => ((a.effect as KeyframeEffect).target as Element).hasAttribute('data-tab-ghost')).map(read),
        ghosts: document.querySelectorAll('[data-tab-ghost]').length,
        w: m.getBoundingClientRect().width,
      };
    }, tab);

  /** 点日历的“›”，读这一次翻月的两段动画（旧的一页副本、新的一页）：底栏切页要和它一模一样 */
  const calFlip = (page: Page) =>
    page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="cal-next"]')?.click();
      const all = document.getAnimations().filter((a) => !(a instanceof CSSTransition) && a.effect instanceof KeyframeEffect);
      const read = (a: Animation) => {
        const e = a.effect as KeyframeEffect;
        return { frames: e.getKeyframes().map((k) => [k['opacity'] ?? null, k['filter'] ?? null, k['transform'] ?? null, k.offset ?? null]), dur: Number(e.getTiming().duration), easing: String(e.getTiming().easing) };
      };
      const ghost = all.find((a) => ((a.effect as KeyframeEffect).target as Element).getAttribute('aria-hidden') === 'true');
      const inn = all.find((a) => a !== ghost);
      return { ghost: ghost ? read(ghost) : null, inn: inn ? read(inn) : null };
    });

  test('页签互切和日历翻月一模一样（负责人 11-18“底部导航切页动画直接套用日历的切页动画”）：新页、旧页快照的关键帧、时长、曲线都和日历的相同；不平移；fixed 元素不被模糊的祖先带偏；减少动态效果时直接换', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    // 分包先都到：头一次进某页时分包晚到，动画会等新页出来才建
    for (const [tab, sel] of [['todos', '[data-testid="todos"]'], ['notes', '[data-testid="notes"]'], ['calendar', 'main[data-feature="calendar"]'], ['today', '[data-testid="today"]']] as const) {
      await page.getByTestId('tabbar').locator(`a[data-tab="${tab}"]`).click();
      await expect(page.locator(sel)).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSTransition)).length), { timeout: 5000 }).toBe(0);
    }
    const idle = () => expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSTransition)).length), { timeout: 5000 }).toBe(0);
    // 先量日历翻月本身（基准）
    await page.getByTestId('tabbar').locator('a[data-tab="calendar"]').click();
    await expect(page.locator('main[data-feature="calendar"]')).toBeVisible();
    await idle();
    const cal = await calFlip(page);
    expect(cal.ghost, `日历翻月没有旧页副本动画 ${JSON.stringify(cal)}`).not.toBeNull();
    expect(cal.inn).not.toBeNull();
    expect(cal.ghost?.dur).toBe(880);
    await idle();
    for (const tab of ['todos', 'notes', 'calendar'] as const) {
      const r = await clickAndRead(page, tab);
      expect(r, `${tab}：点完新页还没出来`).not.toBeNull();
      const list = r?.page ?? [];
      const fade = list.find((a) => a.main && a.frames[0]?.[0] !== null);
      expect(fade, `${tab}：main 上没有淡入 ${JSON.stringify(list)}`).toBeDefined();
      // 新页：透明度和模糊同日历新的一页（随手记有 fixed 贴底行：模糊拆到不含 fixed 的子树上，main 上只剩透明度）
      expect(fade?.frames.map((f) => f[0])).toEqual(cal.inn?.frames.map((f) => f[0]));
      expect(fade?.dur).toBe(cal.inn?.dur);
      expect(fade?.easing).toBe(cal.inn?.easing);
      const blurred = list.filter((a) => a.frames[0]?.[1] !== null);
      expect(blurred.length, `${tab}：新页没有模糊 ${JSON.stringify(list)}`).toBeGreaterThan(0);
      for (const b of blurred) {
        expect(b.frames.map((f) => f[1])).toEqual(cal.inn?.frames.map((f) => f[1]));
        expect(b.dur).toBe(cal.inn?.dur);
        expect(b.fixedInside, `${tab}：加模糊的元素里有 fixed 元素`).toBe(false);
      }
      expect(list.every((a) => a.frames.every((f) => f[2] === null || f[2] === 'none')), `${tab}：新页有平移 ${JSON.stringify(list)}`).toBe(true);
      // 旧页快照：一份，关键帧（透明度、模糊、位移、2/3 处的那一帧）、时长、曲线和日历旧的一页副本完全相同
      expect(r?.ghosts, `${tab}：旧页快照不是一份`).toBe(1);
      expect(r?.ghost, `${tab}：旧页快照没有动画`).toHaveLength(1);
      expect(r?.ghost[0]?.frames).toEqual(cal.ghost?.frames);
      expect(r?.ghost[0]?.dur).toBe(cal.ghost?.dur);
      expect(r?.ghost[0]?.easing).toBe(cal.ghost?.easing);
      await idle();
      expect(await page.evaluate(() => document.querySelectorAll('[data-tab-ghost]').length), `${tab}：放完旧页快照没拿掉`).toBe(0);
      if (tab === 'notes') {
        // 随手记页真有贴底输入行这种 fixed 元素（不然上面“不被带偏”测了个空）
        expect(await page.evaluate(() => [...(document.querySelector('main')?.querySelectorAll('*') ?? [])].some((x) => getComputedStyle(x).position === 'fixed'))).toBe(true);
      }
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-rm', '1'));
    expect(await clickAndRead(page, 'todos')).toMatchObject({ page: [], ghost: [], ghosts: 0 });
    await page.evaluate(() => document.documentElement.removeAttribute('data-rm'));
  });
});
