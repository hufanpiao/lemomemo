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

// R-349（负责人 11-06 改选 black-translucent，取代 R-278、R-280 的状态栏染色）：页面铺到状态栏下面，启动画面 fixed inset 0 自己盖住状态栏
describe('状态栏（R-349，负责人 11-06）', () => {
  it('两个入口页都写 black-translucent：页面铺到状态栏下面', () => {
    const auth = readFileSync(join(SRC, 'auth', 'index.html'), 'utf8');
    for (const page of [html, auth]) {
      expect(noComments(page)).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
      expect(noComments(page)).toContain('viewport-fit=cover');
    }
  });
  it('R-278 的顶色规则和顶色关键帧删掉（11-11 加的是底部那一层保险，见下一组）', () => {
    expect(cssNoComments).not.toMatch(/html:has\(#lemo-splash/);
    expect(cssNoComments).not.toMatch(/lemo-splash-top-to-dark|#F0EDD3|#232423/);
  });
});

// 负责人 11-11“启动的时候下面那一块灰色去掉不行吗”：主屏幕版冷启动布局视口偏矮（R-371，895 对屏幕 956），启动画面按整屏铺
describe('启动画面整屏铺满（11-11，底部灰条）', () => {
  /** export_splash.py 的 DEVICES 里的 CSS 宽、高（去重） */
  const py = readFileSync(join(ROOT, 'build', 'export_splash.py'), 'utf8');
  const block = /^DEVICES = \[\r?\n([\s\S]*?)^\]/m.exec(py)?.[1] ?? '';
  const devices = [...new Set([...block.matchAll(/^\s*\(\d+, \d+, (\d+), (\d+), \d,/gm)].map((m) => `${m[1]}x${m[2]}`))].sort();
  it('平时 100%（= 原来 inset: 0）；只在主屏幕版取布局视口、100lvh、本机型整屏高里最大的（浏览器里不改 R-254 版式，代码审 11-11）', () => {
    const rule = /\.lemo-splash \{([^}]*)\}/.exec(cssNoComments)?.[1] ?? '';
    expect(rule).toMatch(/top: 0;\s*right: 0;\s*left: 0;\s*height: 100%;/);
    expect(rule).not.toMatch(/inset: 0|lvh|max\(/);
    expect(cssNoComments).toMatch(/@media \(display-mode: standalone\) \{\s*\.lemo-splash \{\s*height: max\(100%, 100lvh, var\(--lemo-screen-h, 0px\)\);\s*\}/);
    expect(cssNoComments.match(/100lvh/g)).toHaveLength(1);
  });
  it('整屏高度的机型表和 iOS 启动图（export_splash.py 的 DEVICES）一条不差，只管竖屏', () => {
    const rows = [...cssNoComments.matchAll(/@media \(display-mode: standalone\) and \(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(orientation: portrait\) \{\s*\.lemo-splash \{\s*--lemo-screen-h: (\d+)px;/g)];
    for (const r of rows) expect(r[3], r[0]).toBe(r[2]);
    // 每段 device-height 都限定主屏幕版
    expect(cssNoComments.match(/device-height/g)?.length).toBe(rows.length);
    expect(devices.length).toBeGreaterThanOrEqual(11);
    expect(rows.map((r) => `${r[1]}x${r[2]}`).sort()).toEqual(devices);
  });
  it('启动期间页面底色 = 启动画面底部的颜色；开始收起就退回；深色主屏幕版跟着一起变深', () => {
    expect(cssNoComments).toMatch(/\n:root:has\(> body > \.lemo-splash:not\(\.is-leaving\)\) \{\s*background-color: #E8E9E8;/);
    expect(cssNoComments).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:has\(> body > \.lemo-splash:not\(\.is-leaving\)\) \{\s*background-color: #161717;/);
    expect(cssNoComments).toMatch(/animation: lemo-splash-bg-to-dark var\(--dur-splash-dark\) var\(--ease-standard\) var\(--dur-splash-still\) forwards;/);
  });
  it('检查器拦得住产物里丢了整屏高度那几段', () => {
    const ok = '@media (orientation:landscape){.lemo-splash{--cw:400px}}@media (display-mode:standalone) and (device-width:440px) and (device-height:956px) and (orientation:portrait){.lemo-splash{--lemo-screen-h:956px}}';
    expect(splashMediaProblems(ok)).toEqual([]);
    // 没限定主屏幕版的也拦
    expect(splashMediaProblems('@media (orientation:landscape){.lemo-splash{--cw:400px}}@media (device-height:956px){.lemo-splash{--lemo-screen-h:956px}}')).toHaveLength(1);
    expect(splashMediaProblems('@media (orientation:landscape){.lemo-splash{--cw:400px}}')).toHaveLength(1);
  });
});

describe('构建产物里的媒体查询（build/check_splash_css.mjs；审查必改 1）', () => {
  it('源码电脑版式用 (orientation: landscape)，不用 aspect-ratio', () => {
    expect(cssNoComments).toContain('@media (orientation: landscape) {');
    expect(cssNoComments).not.toMatch(/aspect-ratio/);
  });
  it('拦得住：压缩改写出的范围写法、缺电脑版式那一段、根本没有启动画面样式', () => {
    const full = '@media (display-mode:standalone) and (device-height:956px){.lemo-splash{--lemo-screen-h:956px}}';
    expect(splashMediaProblems(`@media (orientation:landscape){.lemo-splash{--cw:400px;--cy:42%}}${full}`)).toEqual([]);
    expect(splashMediaProblems(`@media (aspect-ratio>=1){.lemo-splash{--cw:400px;--cy:42%}}${full}`)).toHaveLength(2);
    expect(splashMediaProblems(`.lemo-splash{color:red}@media (width<=600px){.lemo-splash-t{margin:0}}${full}`)).toHaveLength(2);
    expect(splashMediaProblems('.app{color:red}')).toEqual(['产物里没有 .lemo-splash 的样式']);
    // 别人的 @media 不归这里管
    expect(splashMediaProblems(`@media (width>=600px){.app{margin:0}}@media (orientation:landscape){.lemo-splash{--cw:400px}}${full}`)).toEqual([]);
  });
  const appDir = join(ROOT, 'dist', 'web', 'app');
  const files = splashCssFiles(appDir);
  it.skipIf(files.length === 0)('dist/web/app 里现有的产物（构建过才查；build_web.mjs 每次构建都会跑同一个检查）', () => {
    for (const f of files) expect(splashMediaProblems(readFileSync(f, 'utf8')), f).toEqual([]);
  });
});
