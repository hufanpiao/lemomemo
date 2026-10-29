// 设置页有版本横幅时不多出一截滚动（接手清单 BANNER-safe）：jsdom 不算 CSS 模块的布局，按源码文字核对。
// 横幅（UpdateBanner）出现时根节点有 data-top-banner；这时 .page 不再 min-height: 100dvh（横幅 + 100dvh 会超出一屏），
// 底下露出的是 body 的背景（base.css：同样是 var(--bg)、min-height: 100dvh）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/features/settings/ui/SettingsPage.module.css', 'utf8');
const base = readFileSync('src/styles/base.css', 'utf8');

/** 取某个选择器的声明块 */
function block(src: string, selector: string): string {
  const at = src.indexOf(`${selector} {`);
  if (at < 0) return '';
  return src.slice(at, src.indexOf('}', at));
}

describe('设置页 + 版本横幅（BANNER-safe）', () => {
  it('没有横幅：.page 撑满 100dvh；有横幅（:root[data-top-banner]）：不撑，min-height 归零', () => {
    expect(block(css, '.page')).toMatch(/min-height: 100dvh;/);
    expect(block(css, ':global(:root[data-top-banner]) .page')).toMatch(/min-height: 0;/);
  });

  it('不撑以后底下露出的 body 和页面同一个背景、同样撑满一屏', () => {
    expect(block(css, '.page')).toMatch(/background: var\(--bg\);/);
    const body = block(base, 'body');
    expect(body).toMatch(/background: var\(--bg\);/);
    expect(body).toMatch(/min-height: 100dvh;/);
  });
});
