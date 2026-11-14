// 用例失败时把现场带进报告（B4b-3 返工第三条：默认组首次运行 18 条白屏没抓到日志；“所有 bug 先看日志”）：
// • 运行日志最后 40 行（localStorage lemo-run-log，platform/run-log.ts；本身不记用户原话）
// • 控制台 error、页面未捕获的报错（pageerror）、失败的请求（只记去掉查询串的地址和原因）
// • 失败那一刻还没回来的请求、最慢的几个请求（发出时刻、耗时；冷启动白屏时看卡在哪个文件上）
// • 失败那一刻的地址、#root 里有没有东西（白屏时一眼看出是没挂上还是挂上了没内容）
// 只在失败时附件（fail-log）并打到标准输出；通过的用例什么都不留。各 spec 在顶层调一次 logOnFail(test)
import type { Page, Request } from '@playwright/test';
import type { test as base } from './session-fixture.ts';

const TAIL = 40;
const CUT = 300;
const SLOW = 8;
const path = (u: string): string => u.replace(/[?#].*$/, '');

export function logOnFail(t: typeof base): void {
  const seen = new WeakMap<Page, string[]>();
  const net = new WeakMap<Page, () => string>();
  t.beforeEach(({ page }) => {
    const out: string[] = [];
    seen.set(page, out);
    const t0 = Date.now();
    const sec = (s: number): string => `+${((s - t0) / 1000).toFixed(2)}s`;
    const at = (): string => sec(Date.now());
    page.on('console', (m) => {
      if (m.type() === 'error') out.push(`${at()} console.error ${m.text().slice(0, CUT)}`);
    });
    page.on('pageerror', (e) => out.push(`${at()} pageerror ${e.name}: ${e.message.slice(0, CUT)}`));
    page.on('requestfailed', (r) => out.push(`${at()} requestfailed ${path(r.url())} ${r.failure()?.errorText ?? ''}`));
    // 没回来的请求和最慢的请求（白屏时看是不是卡在某个 chunk 上）
    const open = new Map<Request, number>();
    const done: [string, number][] = [];
    page.on('request', (r) => open.set(r, Date.now()));
    const end = (r: Request): void => {
      const s = open.get(r);
      open.delete(r);
      if (s !== undefined) done.push([`${path(r.url())} 发出 ${sec(s)}`, Date.now() - s]);
    };
    page.on('requestfinished', end);
    page.on('requestfailed', end);
    net.set(page, () => {
      const now = Date.now();
      const pend = [...open].map(([r, s]) => `${path(r.url())} 发出 ${sec(s)} 已等 ${now - s}ms`);
      const slow = [...done]
        .sort((x, y) => y[1] - x[1])
        .slice(0, SLOW)
        .map(([u, ms]) => `${u} 用了 ${ms}ms`);
      return `== 没回来的请求（${pend.length} 条）==\n${pend.join('\n') || '（无）'}\n\n== 最慢的 ${SLOW} 个请求（共 ${done.length} 个）==\n${slow.join('\n') || '（无）'}`;
    });
  });
  t.afterEach(async ({ page }, info) => {
    if (info.status === info.expectedStatus) return;
    const state = await page
      .evaluate((n) => {
        const root = document.getElementById('root');
        const log = (localStorage.getItem('lemo-run-log') ?? '').split('\n').slice(-n).join('\n');
        return `url=${location.pathname}${location.hash} ready=${document.readyState} root=${root ? root.childElementCount : 'none'} bodyText=${document.body.innerText.length}\n${log}`;
      }, TAIL)
      .catch((e: unknown) => `(读不到页面：${String(e).slice(0, CUT)})`);
    const errs = seen.get(page) ?? [];
    const body = `== 页面状态和运行日志最后 ${TAIL} 行 ==\n${state}\n\n== 控制台错误、页面报错、失败请求（${errs.length} 条）==\n${errs.join('\n') || '（无）'}\n\n${net.get(page)?.() ?? ''}`;
    await info.attach('fail-log', { body, contentType: 'text/plain' });
    console.log(`[fail-log] ${info.project.name} ${info.title}\n${body}`);
  });
}
