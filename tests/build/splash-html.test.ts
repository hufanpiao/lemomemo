// 启动画面的静态部分（R-251、R-254 方向 B、R-253）：入口页 src/index.html 和 src/styles/splash.css 的构建检查
// - CSP style-src 'self'：入口页不准有内联 <style>，也不准有 style 属性（启动画面在 React 之前画，样式全在外链 CSS）
// - 减少动态效果：三根竖条的起伏在 @media (prefers-reduced-motion: reduce) 和 :root[data-rm="1"] 里都关掉
// - 时长和 hideSplash() 的兜底定时器一致；字色、竖条颜色和令牌、logo 原图一致；引用的图、字库都在
// - 构建产物里启动画面的媒体查询没被压缩改写成旧版 Safari 不认的范围写法（build/check_splash_css.mjs）
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splashCssFiles, splashMediaProblems } from '../../build/check_splash_css.mjs';
import { SPLASH_FADE_MS, SPLASH_FADE_RM_MS, SPLASH_ID } from '../../src/platform/splash.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');
const html = readFileSync(join(SRC, 'index.html'), 'utf8');
const cssPath = join(SRC, 'styles', 'splash.css');
const css = readFileSync(cssPath, 'utf8');
const tokens = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8');
const glass = readFileSync(join(SRC, 'styles', 'skins', 'glass.css'), 'utf8');
const noComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

function ms(v: string | undefined): number {
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(v ?? '');
  if (!m?.[1]) throw new Error(`不是时长：${v}`);
  return m[2] === 'ms' ? Number(m[1]) : Number(m[1]) * 1000;
}
const tokenOf = (name: string) => new RegExp(`${name}:([^;}]+)`).exec(tokens)?.[1];

describe('入口页没有内联样式（CSP style-src \'self\'）', () => {
  const body = noComments(html);
  it('没有 <style> 元素', () => {
    expect(body).not.toMatch(/<style[\s>]/i);
  });
  it('没有 style 属性（含 SVG 里的）', () => {
    expect(body).not.toMatch(/\sstyle\s*=/i);
  });
  it('启动画面的样式外链 splash.css，DOM 在 #root 之后', () => {
    expect(body).toContain('<link rel="stylesheet" href="./styles/splash.css" />');
    expect(body.indexOf(`id="${SPLASH_ID}"`)).toBeGreaterThan(body.indexOf('id="root"'));
  });
});

describe('引用的资源都在', () => {
  it('index.html 里的相对路径（预模糊图、字库 preload）', () => {
    const refs = [...noComments(html).matchAll(/(?:href|src)="(\.\/(?:styles)\/[^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThanOrEqual(5);
    for (const r of refs) expect(existsSync(join(SRC, r)), r).toBe(true);
  });
  it('splash.css 里的 url()', () => {
    const refs = [...cssNoComments.matchAll(/url\("(\.\/[^"]+)"\)/g)].map((m) => m[1] ?? '');
    expect(refs).toContain('./fonts/splash/noto-sans-sc-splash-800.woff2');
    expect(refs).toContain('./splash/splash-dark.png');
    for (const r of refs) expect(existsSync(join(dirname(cssPath), r)), r).toBe(true);
  });
  it('两个字重都 font-display: block（首帧不先用苹方画再换字形）', () => {
    const faces = cssNoComments.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(2);
    for (const f of faces) expect(f).toContain('font-display: block');
  });
});

describe('减少动态效果：竖条不起伏', () => {
  const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(cssNoComments)?.[1] ?? '';
  for (const bar of ['.lemo-splash-bar', '.lemo-splash-bar2', '.lemo-splash-bar3']) {
    it(`${bar}：系统设置和 data-rm="1" 两段都写 animation: none`, () => {
      expect(reduce).toMatch(new RegExp(`\\${bar}[,\\s][\\s\\S]*?\\{\\s*animation: none;`));
      expect(cssNoComments).toMatch(new RegExp(`:root\\[data-rm="1"\\] \\${bar}[,\\s][\\s\\S]*?\\{\\s*animation: none;`));
    });
  }
  it('收起的时长：平时 --dur-ui、减少动态效果 --dur-splash-out-rm，和 hideSplash 的定时器一致', () => {
    expect(cssNoComments).toMatch(/\.lemo-splash\.is-leaving \{[^}]*transition: opacity var\(--dur-ui\) var\(--ease-out\);/);
    expect(reduce).toMatch(/\.lemo-splash\.is-leaving \{\s*transition-duration: var\(--dur-splash-out-rm\);/);
    expect(ms(tokenOf('--dur-ui'))).toBe(SPLASH_FADE_MS);
    expect(ms(tokenOf('--dur-splash-out-rm'))).toBe(SPLASH_FADE_RM_MS);
  });
  it('时间线令牌：0.8 秒静止、1.6 秒一轮、依次错开 0.2 秒、变暗 0.6 秒', () => {
    expect(ms(tokenOf('--dur-splash-still'))).toBe(800);
    expect(ms(tokenOf('--dur-splash-bar2'))).toBe(1000);
    expect(ms(tokenOf('--dur-splash-bar3'))).toBe(1200);
    expect(ms(tokenOf('--dur-splash-breathe'))).toBe(1600);
    expect(ms(tokenOf('--dur-splash-dark'))).toBe(600);
  });
});

describe('字色和 glass 深色令牌、logo 原图一致', () => {
  const dark = /\[data-skin="glass"\]\[data-theme="dark"\]\{([^}]*)\}/.exec(glass)?.[1] ?? '';
  const v = (n: string) => new RegExp(`(?:^|;)${n}:([^;]+)`).exec(dark)?.[1];
  it('深色字 --text、--text-2', () => {
    expect(cssNoComments).toMatch(new RegExp(`\\.lemo-splash-d \\{[^}]*color: ${v('--text')};`));
    expect(cssNoComments).toMatch(new RegExp(`\\.lemo-splash-d \\.lemo-splash-foot \\{\\s*color: ${v('--text-2')};`));
  });
  it('浅色字和竖条都是 logo 原图的 #141518', () => {
    expect(cssNoComments).toMatch(/\.lemo-splash \{[^}]*color: #141518;/);
    expect(readFileSync(join(SRC, 'public', 'icons', 'logo-mark.svg'), 'utf8')).toContain('fill="#141518"');
  });
});

describe('竖条的颜色', () => {
  it('三根竖条的 fill 和 logo 原图一样是 #141518', () => {
    const bars = [...noComments(html).matchAll(/<rect class="lemo-splash-bar[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(bars).toHaveLength(3);
    for (const b of bars) expect(b).toContain('fill="#141518"');
  });
});

describe('构建产物里的媒体查询（build/check_splash_css.mjs；审查必改 1）', () => {
  it('源码电脑版式用 (orientation: landscape)，不用 aspect-ratio', () => {
    expect(cssNoComments).toContain('@media (orientation: landscape) {');
    expect(cssNoComments).not.toMatch(/aspect-ratio/);
  });
  it('拦得住：压缩改写出的范围写法、缺电脑版式那一段、根本没有启动画面样式', () => {
    expect(splashMediaProblems('@media (orientation:landscape){.lemo-splash{--cw:400px;--cy:42%}}')).toEqual([]);
    expect(splashMediaProblems('@media (aspect-ratio>=1){.lemo-splash{--cw:400px;--cy:42%}}')).toHaveLength(2);
    expect(splashMediaProblems('.lemo-splash{color:red}@media (width<=600px){.lemo-splash-t{margin:0}}')).toHaveLength(2);
    expect(splashMediaProblems('.app{color:red}')).toEqual(['产物里没有 .lemo-splash 的样式']);
    // 别人的 @media 不归这里管
    expect(splashMediaProblems('@media (width>=600px){.app{margin:0}}@media (orientation:landscape){.lemo-splash{--cw:400px}}')).toEqual([]);
  });
  const appDir = join(ROOT, 'dist', 'web', 'app');
  const files = splashCssFiles(appDir);
  it.skipIf(files.length === 0)('dist/web/app 里现有的产物（构建过才查；build_web.mjs 每次构建都会跑同一个检查）', () => {
    for (const f of files) expect(splashMediaProblems(readFileSync(f, 'utf8')), f).toEqual([]);
  });
});
