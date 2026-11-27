// 今天页 200 行勾一条待办时 CPU 花在哪（前端-15 定根因用；改之前、改之后各跑一遍对比）：
// • CDP Profiler（采样 100µs、CPU 降速 PERF_CPU 倍，默认 4）从点下到之后 1.5 秒，按文件、按函数汇总自身时间（产物是压缩过的，函数名是短名，看文件名和行列）
// • 往页面里装一个最小的 React DevTools 钩子（__REACT_DEVTOOLS_GLOBAL_HOOK__，只数不改），数这 1.5 秒里有几次提交、每次重画了多少个组件、按组件名前 25
//   （“重画”= 新挂上，或 props、state 和上一次不是同一个对象；跳过重画的组件 React 原样复用 props，不算）
// 勾 3 条，结果写进 PERF_OUT（默认 test-results/today-tap-profile.json），不断言
import { writeFileSync } from 'node:fs';
import { expect, test } from '../e2e/session-fixture.ts';
import { PERF_USE, seedToday, tdId, warmSw } from './today-seed.ts';

const CPU = Number(process.env['PERF_CPU'] ?? '4');
test.use(PERF_USE);

const HOOK = `(() => {
  const C = (window.__commits = []);
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    // 算“这次提交真重画了”的组件：这次的 fiber 对象上一次提交里没见过（没访问到的子树还是同一批对象，它们的 alternate 是上上次的，
    // 只比 props 会把跳过的也算进去），并且 props 或 state 和 alternate 不一样（memo 跳过时克隆出来的 props 是同一个对象）
    seen: new WeakSet(),
    onCommitFiberRoot(_id, root) {
      const prev = this.seen;
      const now = (this.seen = new WeakSet());
      const on = !!window.__countOn;
      const by = {};
      let n = 0;
      const walk = (f) => {
        for (; f; f = f.sibling) {
          now.add(f);
          const a = f.alternate;
          if (on && !prev.has(f) && typeof f.type !== 'string' && f.type && (!a || a.memoizedProps !== f.memoizedProps || a.memoizedState !== f.memoizedState)) {
            n++;
            const t = f.type;
            const nm = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t._context ? 'Ctx' : '?');
            by[nm] = (by[nm] || 0) + 1;
          }
          if (f.child) walk(f.child);
        }
      };
      walk(root.current.child);
      if (on) C.push({ t: Math.round(performance.now()), n, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 25) });
    } };
})();`;

test('今天页 200 行：勾一条的 CPU 剖析和重画组件数', async ({ page }) => {
  await page.addInitScript(HOOK);
  await page.goto('/app/#/today');
  await page.getByTestId('today').waitFor({ timeout: 30_000 });
  await seedToday(page, 100, 100);
  await warmSw(page);
  const cdp = await page.context().newCDPSession(page);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  const out: unknown[] = [];
  for (const j of [0, 1, 2]) {
    const box = page.getByTestId(`today-done-${tdId(j)}`);
    await box.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await cdp.send('Profiler.start');
    await page.evaluate(() => {
      const w = window as unknown as { __countOn: boolean; __commits: unknown[] };
      w.__countOn = true;
      w.__commits.length = 0;
    });
    await box.click();
    await expect(box).toBeChecked();
    await page.waitForTimeout(1500);
    const { profile } = await cdp.send('Profiler.stop');
    const commits = await page.evaluate(() => {
      const w = window as unknown as { __countOn: boolean; __commits: unknown[] };
      w.__countOn = false;
      return w.__commits;
    });
    // 自身时间：第 i 个样本记到 samples[i] 那个节点上，时长是 timeDeltas[i]（微秒）
    const self = new Map<number, number>();
    profile.samples?.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0)));
    const byFn = new Map<string, number>();
    const byFile = new Map<string, number>();
    for (const n of profile.nodes) {
      const ms = (self.get(n.id) ?? 0) / 1000;
      if (!ms) continue;
      const file = n.callFrame.url.split('/').pop() || n.callFrame.functionName || '(native)';
      const fn = `${n.callFrame.functionName || '(anon)'} @${file}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`;
      byFn.set(fn, (byFn.get(fn) ?? 0) + ms);
      byFile.set(file, (byFile.get(file) ?? 0) + ms);
    }
    const top = (m: Map<string, number>, k: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([a, b]) => `${Math.round(b)}ms ${a}`);
    out.push({ tap: j, cpu: CPU, files: top(byFile, 15), fns: top(byFn, 40), commits });
  }
  const path = process.env['PERF_OUT'] ?? test.info().outputPath('today-tap-profile.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`PROFILE ${path}`);
});
