// 用例失败时把现场带进报告（B4b-3 返工第三条：默认组首次运行 18 条白屏没抓到日志；“所有 bug 先看日志”）：
// • 运行日志最后 40 行（localStorage lemo-run-log，platform/run-log.ts；本身不记用户原话）
// • 控制台 error、页面未捕获的报错（pageerror）、失败的请求（只记去掉查询串的地址和原因）
// • 失败那一刻的地址、#root 里有没有东西（白屏时一眼看出是没挂上还是挂上了没内容）
// 只在失败时附件（fail-log）并打到标准输出；通过的用例什么都不留。各 spec 在顶层调一次 logOnFail(test)
import type { Page } from '@playwright/test';
import type { test as base } from './session-fixture.ts';

const TAIL = 40;
const CUT = 300;

export function logOnFail(t: typeof base): void {
  const seen = new WeakMap<Page, string[]>();
  t.beforeEach(({ page }) => {
    const out: string[] = [];
    seen.set(page, out);
    const t0 = Date.now();
    const at = (): string => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
    page.on('console', (m) => {
      if (m.type() === 'error') out.push(`${at()} console.error ${m.text().slice(0, CUT)}`);
    });
    page.on('pageerror', (e) => out.push(`${at()} pageerror ${e.name}: ${e.message.slice(0, CUT)}`));
    page.on('requestfailed', (r) => out.push(`${at()} requestfailed ${r.url().replace(/[?#].*$/, '')} ${r.failure()?.errorText ?? ''}`));
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
    const body = `== 页面状态和运行日志最后 ${TAIL} 行 ==\n${state}\n\n== 控制台错误、页面报错、失败请求（${errs.length} 条）==\n${errs.join('\n') || '（无）'}`;
    await info.attach('fail-log', { body, contentType: 'text/plain' });
    console.log(`[fail-log] ${info.project.name} ${info.title}\n${body}`);
  });
}
