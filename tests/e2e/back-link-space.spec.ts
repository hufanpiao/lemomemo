// 返回按钮“‹ 文字”中间的空格（界面去重返修，主持人 11-11 定：保留空格）：真浏览器里量“‹”右边到文字第一个字左边的距离。
// kit 的 BackLink 是 inline-flex，“‹”和文字直接放进去时中间的空格被丢掉（两个字贴在一起），jsdom 的 textContent 看不出来，只能在这里量。
// 量的页：待办、日程编辑页（EditShell）、最近删除、设置二级页、注销页（都用 BackLink）；随手记编辑页、设置首页“‹ 今天”是一整段文字，一起量
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true, locale: 'zh-CN', viewport: { width: 440, height: 956 } });

const PAGES: [route: string, button: string][] = [
  ['todo/new', '[data-testid="edit-back"]'],
  ['event/new', '[data-testid="edit-back"]'],
  ['trash', '[data-testid="trash-back"]'],
  ['settings/remind', '[data-testid="settings-remind-back"]'],
  ['settings/delete', '[data-testid="settings-delete-back"]'],
  ['note/new', '[data-testid="edit-back"]'],
  ['settings', 'main[data-feature="settings"] header a[href="#/today"]'],
];

/** “‹”右边到后面第一个不是空白的字左边，单位 px（找不到返回 null） */
function gapAfterChevron(page: Page, sel: string): Promise<number | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const chars: { node: Text; i: number }[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      for (let i = 0; i < text.data.length; i++) chars.push({ node: text, i });
    }
    const rect = (c: { node: Text; i: number }): DOMRect => {
      const r = document.createRange();
      r.setStart(c.node, c.i);
      r.setEnd(c.node, c.i + 1);
      return r.getBoundingClientRect();
    };
    const k = chars.findIndex((c) => c.node.data[c.i] === '‹');
    const next = chars.slice(k + 1).find((c) => (c.node.data[c.i] ?? '').trim() !== '');
    if (k < 0 || !next) return null;
    const chevron = chars[k];
    return chevron ? rect(next).left - rect(chevron).right : null;
  }, sel);
}

test('返回按钮“‹”和文字之间留着一个空格的宽度（≥ 3px，贴在一起是 0）', async ({ page }) => {
  test.setTimeout(90_000);
  const gaps: Record<string, number | null> = {};
  for (const [route, sel] of PAGES) {
    await page.goto(`/app/#/${route}`);
    await page.reload();
    await page.locator(sel).first().waitFor({ timeout: 30_000 });
    gaps[route] = await gapAfterChevron(page, sel);
  }
  for (const [route, gap] of Object.entries(gaps)) {
    expect(gap, `${route} 的返回按钮：“‹”和文字的距离 ${String(gap)}px`).not.toBeNull();
    expect(gap ?? 0, `${route} 的返回按钮：“‹”和文字贴在一起了（空格被 inline-flex 丢掉）`).toBeGreaterThanOrEqual(3);
  }
});
