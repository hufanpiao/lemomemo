// 原生控件跟 App 主题（负责人 11-06 真机截图 6：系统深色、App 选浅色，日期选择器弹出来是深色）。
// 日期、时刻、下拉的弹出面板和滚动条由浏览器按根元素的 color-scheme 画；不设时（normal）iOS 跟着手机系统走。
// 规则：入口页 <meta name="color-scheme"> 和 <html data-theme> 一致；base.css 按 data-theme 给根元素设 color-scheme：
// light → light、dark → dark。跟随系统时 platform/look.ts 按 prefers-color-scheme 算好写成 light / dark，data-theme 不会是 system，
// 所以没有 system 那条（皮肤整块评审 11-14 第 7 条：color-scheme 只留 CSS 一套，look.ts 不再写 meta）。皮肤里有的每一种主题都要有对应的一条。
// jsdom 不算样式，按源码核对
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = readFileSync('src/styles/base.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const EXPECT: Record<string, string> = { light: 'light', dark: 'dark' };

function schemeFor(theme: string): string | undefined {
  const re = new RegExp(`:root\\[data-theme=['"]${theme}['"]\\]\\s*\\{([^}]*)\\}`, 'g');
  let last: string | undefined;
  for (const m of base.matchAll(re)) last = /color-scheme:\s*([^;]+);/.exec(m[1] ?? '')?.[1]?.trim() ?? last;
  return last;
}

describe('原生控件的 color-scheme 跟 App 主题', () => {
  it('base.css：浅色 light、深色 dark；没有 data-theme=system 的死规则', () => {
    for (const [theme, scheme] of Object.entries(EXPECT)) expect(schemeFor(theme), theme).toBe(scheme);
    expect(schemeFor('system')).toBeUndefined();
  });

  it('皮肤里出现的每一种 data-theme 都有对应的 color-scheme', () => {
    const themes = new Set<string>();
    for (const f of readdirSync('src/styles/skins')) {
      for (const m of readFileSync(`src/styles/skins/${f}`, 'utf8').matchAll(/data-theme="(\w+)"/g)) themes.add(m[1] ?? '');
    }
    expect([...themes].sort()).toEqual(['dark', 'light']);
    for (const t of themes) expect(schemeFor(t), t).toBe(EXPECT[t]);
  });

  it('入口页：<meta name="color-scheme"> 和 <html data-theme> 一致（首屏样式到之前原生控件也不跟系统变）', () => {
    for (const f of ['src/index.html', 'src/auth/index.html']) {
      const html = readFileSync(f, 'utf8');
      const theme = /<html[^>]*\bdata-theme="(\w+)"/.exec(html)?.[1];
      const meta = /<meta name="color-scheme" content="([^"]+)"/.exec(html)?.[1];
      expect(theme, f).toBeDefined();
      expect(meta, f).toBe(EXPECT[theme ?? '']);
      // meta 要在样式表之前，第一帧就生效
      expect(html.indexOf('name="color-scheme"'), f).toBeLessThan(html.search(/<link rel="stylesheet"|<script/));
    }
  });
});
