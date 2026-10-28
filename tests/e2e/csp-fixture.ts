// CSP 报错收集（架构 1.3 B0 验收：带 CSP 跑一页，控制台出现任何 CSP 报错就失败）
// 两路同时收：页面的 securitypolicyviolation 事件、浏览器控制台里的 CSP 报错文字
import { test as base, expect, type Page } from '@playwright/test';

export interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

declare global {
  interface Window {
    __csp?: Violation[];
  }
}

const CSP_TEXT = /Content[- ]Security[- ]Policy|Refused to (apply|load|execute|connect|frame)/i;

export interface CspWatch {
  /** 页面事件收到的违规 */
  violations(): Promise<Violation[]>;
  /** 控制台里的 CSP 报错 */
  consoleErrors: string[];
  /** 本用例预期会有违规（对照组），收尾时不判失败 */
  expectViolations(): void;
}

async function readViolations(page: Page): Promise<Violation[]> {
  return page.evaluate(() => window.__csp ?? []);
}

export const test = base.extend<{ csp: CspWatch }>({
  csp: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__csp?.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile });
        });
      });
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (CSP_TEXT.test(m.text())) consoleErrors.push(`[${m.type()}] ${m.text()}`);
      });
      let expected = false;
      await use({
        violations: () => readViolations(page),
        consoleErrors,
        expectViolations: () => {
          expected = true;
        },
      });
      if (!expected) {
        const v = page.isClosed() ? [] : await readViolations(page).catch(() => []);
        expect(v, 'securitypolicyviolation 事件').toEqual([]);
        expect(consoleErrors, '控制台 CSP 报错').toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
