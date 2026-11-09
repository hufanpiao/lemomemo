// 首屏预算按页面时钟量（FA-6 ③ 审查 M3 第三轮，主持人 11-05 定）：冷启动打开今天页，**今天页出现之前开始下载的 JS** 合计（gzip）≤ 150 KB，
// 里面没有 zod。chromium、webkit 都跑。口径和审查员的测量一致（scratchpad 的 cr-r3-measure.mjs）：
//   • 不用 Service Worker（serviceWorkers: 'block'），全部走网络，资源记录才完整；
//   • 今天页出现的时刻：页面里 MutationObserver 第一次看到 [data-testid="today"]；
//   • 资源记录（performance resource timing）里 /app/ 下的 .js，startTime ≤ 出现时刻的算“出现之前”；
//   • 每个文件的大小 = 服务端返回的原文按 gzip level 9 压缩后的字节数（和 check_size、审查员一致）；
//   • zod：内容里有 zod 的特征字符串（$ZodType、ZodError；build/check_first_paint_chunks.mjs 同一组）。
// 构建产物里的名单检查（check_first_paint_chunks.mjs）是第一道、跑得快但靠手写名单；这里是兜底：首屏期间实际下载了什么就算什么，
// 新的懒加载块（例如提醒的错过列表 MissedReminders，审查员变异 R3b 把 rows.ts 引进它，首屏 203.5 KB）不用登记也逃不掉。
// 11-05 经过：前端 B 的错过列表带进来一批块，首屏实测 177.1 KB 超线；前端 B 拆弹层、压提醒块到 153.5 KB；前端 A 把推送认领、
// 断开推送（push.ts）、月历手势、版本横幅、整屏提示改成按需下载（主持人定），合起来 149.9 KB（chromium、webkit 各 3 次一致），test.fail 已去掉。
// 当时余量只有约 0.1 KB。11-05 再拆清单快照（首屏建本机仓只读 core/manifest-sync.gen.ts，完整快照随入队校验按需加载，省约 2.5 KB），
// 同时推送断开按安全审查补了总上限和不依赖 push.ts 的兜底（约 +0.4 KB），合起来 148.0 KB（两个浏览器各 3 次一致），余量约 2 KB，留给 FA-7 底栏外壳。
// 11-07 动画库移出首屏（R-354，前端 A 量）：Motion 的实现和功能包合成 motion-impl 一块（gzip 约 45.3 KB），main.tsx 在 appPainted() 之后才下载；
// 首屏 148.8 KB → 132.9 KB（本 spec 的口径，chromium、webkit 各 3 次都是 132.9 KB；构建时 check_size 的静态口径 110.2 KB）。
// build/check_first_paint_chunks.mjs 同时加了 MOTION_MARKS（transformPerspective、whileInView），首屏闭包里出现就挂。
// 审查变异 R3b 在独立副本里重做过（11-05）：zod 那条两个浏览器都挂（首屏下载了 zod-jitless），体积 154.1 → 180.5 KB。
import { gzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const BUDGET = 150 * 1024;
const ZOD_MARKS = ['$ZodType', 'ZodError'];

type Row = { file: string; start: number; gz: number; zod: boolean };

/** 冷启动打开今天页，量“出现之前开始下载”的每个 JS */
async function measure(page: Page): Promise<{ at: number; before: Row[]; after: Row[] }> {
  await page.addInitScript(() => {
    new MutationObserver((_, o) => {
      if (document.querySelector('[data-testid="today"]')) {
        (window as unknown as { __todayAt?: number }).__todayAt = performance.now();
        o.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  const pc = await page.evaluate(() => ({
    at: (window as unknown as { __todayAt?: number }).__todayAt ?? null,
    rs: performance.getEntriesByType('resource').map((e) => [e.name, e.startTime] as [string, number]),
  }));
  expect(pc.at, '记下了今天页出现的时刻').not.toBeNull();
  const at = pc.at ?? 0;
  const before: Row[] = [];
  const after: Row[] = [];
  const seen = new Set<string>();
  for (const [url, start] of pc.rs) {
    const path = new URL(url).pathname;
    if (!path.startsWith('/app/') || !path.endsWith('.js') || seen.has(path)) continue;
    seen.add(path);
    const res = await page.request.get(url);
    expect(res.ok(), `取不到 ${path}`).toBe(true);
    const body = await res.body();
    const text = body.toString('utf8');
    const row = { file: path.slice('/app/'.length), start, gz: gzipSync(body, { level: 9 }).length, zod: ZOD_MARKS.some((m) => text.includes(m)) };
    (start <= at ? before : after).push(row);
  }
  return { at, before, after };
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const table = (rows: Row[]): string => rows.map((r) => `${r.start.toFixed(0)}\t${kb(r.gz)}\t${r.file}${r.zod ? '  [zod]' : ''}`).join('\n');

test.describe('首屏预算（页面时钟口径，FA-6 ③ M3）', () => {
  test.use({ loggedIn: true, serviceWorkers: 'block', locale: 'zh-CN', timezoneId: 'Asia/Seoul' });

  test('今天页出现之前开始下载的 JS 里没有 zod', async ({ page }, info) => {
    const m = await measure(page);
    await info.attach('首屏明细', { body: `今天页出现 ${m.at.toFixed(0)} ms\n${table(m.before)}`, contentType: 'text/plain' });
    expect(m.before.filter((r) => r.zod).map((r) => r.file), '首屏下载了带 zod 的块').toEqual([]);
  });

  test('今天页出现之前开始下载的 JS 合计 ≤ 150 KB（gzip）', async ({ page }, info) => {
    const m = await measure(page);
    const total = m.before.reduce((s, r) => s + r.gz, 0);
    // 合计另打一行到输出，跑完不用开附件就能看到数（原来标 test.fail 时附件不留）
    console.log(`首屏预算 ${test.info().project.name}：今天页出现 ${m.at.toFixed(0)} ms，出现之前开始下载 ${kb(total)}`);
    await info.attach('首屏明细', { body: `今天页出现 ${m.at.toFixed(0)} ms；出现之前 ${kb(total)}\n${table(m.before)}`, contentType: 'text/plain' });
    expect(total, `今天页出现之前开始下载 ${kb(total)}，超过 150 KB：\n${table(m.before)}`).toBeLessThanOrEqual(BUDGET);
  });
});
