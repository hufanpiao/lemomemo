// 顶部安全区底色条（负责人 10-30 13:56 在 iPhone 主屏幕版发现：告知页往上滚，标题滚到透明状态栏底下、和时间信号叠在一起）：
// base.css 全局一条固定在顶部的底色条，高 var(--safe-top)、页面背景色令牌（深色皮肤跟着 --bg 变）；有版本横幅时 --safe-top 为 0，由横幅占位。
// 页面顶部只写 var(--safe-top)，不直接写 env(safe-area-inset-top)（base.css 第 15 行的约定）；只有横幅自己可以写。jsdom 不算布局，按源码文字核对
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const base = readFileSync('src/styles/base.css', 'utf8');

function block(src: string, selector: string): string {
  const at = src.indexOf(`${selector} {`);
  if (at < 0) return '';
  return src.slice(at, src.indexOf('}', at));
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith('.css') ? [p] : [];
  });
}

describe('顶部安全区底色条', () => {
  it('base.css：body::before 固定在顶部，高 var(--inset-top)（安全区本身，有没有横幅都在），背景默认 --bg、页面可用 --safe-top-bg 换，按整屏大小画，不挡点击', () => {
    const b = block(base, 'body::before');
    expect(b).toMatch(/content: '';/);
    expect(b).toMatch(/position: fixed;/);
    expect(b).toMatch(/top: 0;/);
    expect(b).toMatch(/height: var\(--top-band\);/); // 负责人 11-24“直接把模糊拉短”：只盖状态栏文字
    expect(block(base, ':root')).toMatch(/--top-band: calc\(var\(--inset-top\) \* 0\.8\);/);
    expect(block(base, ':root')).toMatch(/--inset-top: env\(safe-area-inset-top\);\s*\/\*[^*]*\*\/\s*--safe-top: calc\(var\(--inset-top\) \+ var\(--top-fade\) \+ var\(--edge-clear\)\);/);
    // 负责人 11-24“字和兔子要清楚”、选“日期往下挪”：只在主屏幕 App、手机宽度把内容往下让 28px，躲开 iOS 26 顶部系统模糊；平时为 0
    expect(block(base, ':root')).toMatch(/--edge-clear: 0px;/);
    expect(base).toMatch(/@media \(display-mode: standalone\) and \(width < 900px\) \{\s*:root \{\s*--edge-clear: 15px;/);
    // 对照版：顶端登记色条平时不显示，主屏幕 App 手机宽度里固定贴顶、全宽、background-clip: text 不画出来、压在所有层上面、不挡点按；整屏外框缩成顶部一条
    expect(base).toMatch(/\n\.lemo-edge \{\s*display: none;\s*\}/);
    const edge = base.slice(base.indexOf('  .lemo-edge {'));
    expect(edge).toMatch(/^ {2}\.lemo-edge \{\s*position: fixed;\s*top: 0;\s*right: 0;\s*left: 0;\s*z-index: var\(--z-edge\);\s*display: block;\s*height: max\(var\(--inset-top\), 11px\);\s*background: var\(--bg\);\s*background-clip: text;\s*pointer-events: none;/);
    expect(base).toMatch(/--z-edge: 101;/);
    expect(base).toMatch(/\(width < 900px\) \{[\s\S]*?\.lemo-top \{\s*bottom: auto;\s*height: var\(--top-band\);/);
    expect(readFileSync('src/index.html', 'utf8')).toMatch(/<div class="lemo-edge" aria-hidden="true"><\/div>/);
    expect(b).toMatch(/background: var\(--safe-top-bg, var\(--scr-bg, var\(--bg\)\)\);/); // R-439：默认跟页面底色（磨砂玻璃是渐变 --scr-bg）
    expect(b).toMatch(/background-size: 100vw 100vh;/);
    expect(b).toMatch(/pointer-events: none;/);
  });

  // 层级（审查必改 1、建议 4）：底色条 1 压住页面内容；弹层遮罩、内容（70）在它上面——position: fixed 而 z-index 为 auto 的元素画在第 0 层，
  // 会被 z-index 1 的底色条盖住，所以弹层必须写正的 z-index；版本横幅 50；整屏提示 100 在所有这些上面
  it('层级：底色条 1 < 版本横幅 50 < 弹层遮罩和内容 70 < 整屏提示 100', () => {
    // 层级写成 base.css 的 --z-* 变量（架构 10.1）：先查变量的值
    const zVar = (name: string): string | undefined => new RegExp(`${name}: (\\d+);`).exec(base)?.[1];
    const z = (src: string, sel: string): number => {
      const m = /z-index: (?:var\((--z-[\w-]+)\)|(\d+));/.exec(block(src, sel));
      return Number((m?.[1] ? zVar(m[1]) : m?.[2]) ?? NaN);
    };
    const dialog = readFileSync('src/kit/components/Dialog.module.css', 'utf8');
    const strip = z(base, 'body::before');
    const banner = z(readFileSync('src/app/UpdateBanner.module.css', 'utf8'), '.banner');
    const scrim = z(dialog, '.scrim');
    const content = z(dialog, '.dock'); // B2（UI-4 L-2）：定位和层级挪到滑动的那一层 .dock，.content 只管外观
    // 被挡住、版本太新等整屏提示共用 CacheTooNewScreen.module.css（被挡住那一屏真的引它，换了样式文件这里要跟着改）
    const blocked = z(readFileSync('src/app/CacheTooNewScreen.module.css', 'utf8'), '.screen');
    expect(readFileSync('src/app/CacheBlockedScreen.tsx', 'utf8')).toMatch(/from '\.\/CacheTooNewScreen\.module\.css'/);
    expect(strip).toBe(1);
    expect(banner).toBeGreaterThan(strip);
    expect(scrim).toBeGreaterThan(banner);
    expect(content).toBe(scrim);
    expect(blocked).toBe(100);
    expect(scrim).toBeLessThan(blocked);
    // SAFETOP-sugg ①：kit Popover（日历年月选择器）经 Portal 挂到 body，在弹层之上、整屏提示之下
    const popover = z(readFileSync('src/kit/components/Popover.module.css', 'utf8'), '.content');
    expect(popover).toBeGreaterThan(scrim);
    expect(popover).toBeLessThan(blocked);
  });

  it('登录页（背景是 --login-bg 渐变，页面能滚）：渐变固定在屏幕上，底色条用同一张（审查必改 2）', () => {
    const css = readFileSync('src/features/auth/ui/AuthPage.module.css', 'utf8');
    expect(block(css, '.page')).not.toMatch(/background/);
    const bg = block(css, '.page::before');
    expect(bg).toMatch(/position: fixed;/);
    expect(bg).toMatch(/top: 0;/);
    expect(bg).toMatch(/z-index: -1;/);
    expect(bg).toMatch(/background: var\(--login-bg, var\(--bg\)\);/);
    expect(block(css, ':global(:root):has(.page)')).toMatch(/--safe-top-bg: var\(--login-bg, var\(--bg\)\);/);
  });

  it('告知页不自己画底色（R-439：露出 body::after 的页面底色），底色条用默认值，不另设 --safe-top-bg', () => {
    const css = readFileSync('src/features/onboarding/ui/ConsentPage.module.css', 'utf8');
    expect(block(css, '.page')).not.toMatch(/background/);
    expect(css).not.toMatch(/--safe-top-bg/);
  });

  it('有版本横幅时页面的 --safe-top 为 0，#root 让出安全区加横幅高度（R-281：横幅固定在安全区下沿）', () => {
    expect(block(base, ':root[data-top-banner]')).toMatch(/--safe-top: 0px;/);
    expect(block(base, ':root[data-top-banner] #root')).toMatch(/padding-top: calc\(var\(--inset-top\) \+ var\(--banner-h, 0px\)\);/);
  });

  it('版本横幅固定在顶部、紧贴安全区下沿，底色是页面底色（状态栏取它的颜色，R-281）', () => {
    const b = block(readFileSync('src/app/UpdateBanner.module.css', 'utf8'), '.banner');
    expect(b).toMatch(/position: fixed;/);
    expect(b).toMatch(/top: var\(--inset-top\);/);
    expect(b).toMatch(/right: 0;\s*left: 0;/);
    expect(b).toMatch(/background: var\(--bg\);/);
    expect(b).toMatch(/padding: 10px max\(16px, env\(safe-area-inset-right\)\) 10px max\(16px, env\(safe-area-inset-left\)\);/);
    expect(b).not.toMatch(/sticky|safe-area-inset-top/);
  });

  it('告知页、登录页顶部写 var(--safe-top)', () => {
    for (const f of ['src/features/onboarding/ui/ConsentPage.module.css', 'src/features/auth/ui/AuthPage.module.css']) {
      expect(block(readFileSync(f, 'utf8'), '.page'), f).toMatch(/padding: max\(var\(--safe-top\), 32px\)/);
    }
  });

  it('顶部渐变模糊带（11-06）：两层模糊 .lemo-top-8 8px、.lemo-top-2 2px，从 y=0 起高 --top-band（只盖状态栏文字），不挡点按；减少透明效果两种都藏模糊、只留底色渐变；宽屏不加', () => {
    const both = block(base, ['.lemo-top-8,', '.lemo-top-2'].join('\n'));
    // 11-06 起两层在铺满整屏的 fixed 外框 .lemo-top 里绝对定位（真机录屏-顶部带：回弹拉深时 iOS 停画顶部 fixed 层）；层级 1 写在外框上
    expect(both).toMatch(/position: absolute;/);
    expect(both).toMatch(/top: 0;/);
    const frame = block(base, '\n.lemo-top'); // 换行开头：主屏幕 App 那段里另有一处缩进的 .lemo-top
    expect(frame).toMatch(/position: fixed;\s*inset: 0;\s*z-index: var\(--z-strip\);\s*pointer-events: none;/);
    expect(base).toMatch(/--z-strip: 1;/);
    // 外框不能成为背景根（不然里面两层取不到外面的页面）：不写这些属性
    expect(frame).not.toMatch(/filter|opacity|mask|clip-path|mix-blend-mode|will-change|isolation|contain|view-transition-name/);
    expect(both).toMatch(/height: var\(--top-band\);/);
    expect(both).toMatch(/pointer-events: none;/);
    expect(block(base, '.lemo-top-8')).toMatch(/backdrop-filter: blur\(8px\);/);
    expect(base).toMatch(/\n\.lemo-top-2 \{\s*background: var\(--status-tint\);\s*backdrop-filter: blur\(2px\);/);
    expect(block(base, 'body::before')).toMatch(/mask: linear-gradient\(to bottom, var\(--bg\), transparent\);/); // 整段渐变不留实色
    expect(base).toMatch(/:root:is\(\[data-rt='1'\], \[data-solid='1'\]\) \.lemo-top-8,\s*:root:is\(\[data-rt='1'\], \[data-solid='1'\]\) \.lemo-top-2 \{\s*display: none;/);
    expect(base).toMatch(/@media \(width >= 900px\) \{\s*\.lemo-top-8,\s*\.lemo-top-2 \{\s*display: none;/);
    expect(base.match(/backdrop-filter: (?!none)/g)?.length).toBe(2); // 只两层（主持人：控制层数）；切页快照组上的 none 不算
    // 诊断色条（.lemo-probe、.lemo-top-probe）负责人 11-25 弹窗同意删掉：入口页和样式里都不再有
    expect(base).not.toMatch(/lemo-(top-)?probe|data-diag/);
    expect(readFileSync('src/index.html', 'utf8')).not.toMatch(/lemo-(top-)?probe/);
    // 只剩主屏幕 App 里的顶端登记色条 .lemo-edge 一处 display: block（11-24 对照版，不画东西）
    expect(base.match(/\n\s*display: block;/g)?.length, '只有顶端登记色条一处').toBe(1);
  });

  // 动效复审 M5（11-06）：伪元素属于整页快照，切页时跟着旧页淡掉、顶部闪一下；两层改成入口页里的真元素。
  // 11-20 起切页不用 View Transition（motion/page-swap.ts 只动 #root 里的页面）：两层在 #root 外面，切页时原地不动、一直画着，不再起 view-transition-name
  it('两层模糊是入口页 #root 外面的真元素，切页时原地不动；没有灰色衬底 html::after，备用底色 --status-tint 默认透明', () => {
    for (const f of ['src/index.html', 'src/auth/index.html']) {
      const h = readFileSync(f, 'utf8');
      expect(h, f).toMatch(/<div class="lemo-top" aria-hidden="true">\s*<div class="lemo-top-8"><\/div>\s*<div class="lemo-top-2"><\/div>/);
      expect(h.indexOf('<div class="lemo-top"'), f).toBeLessThan(h.indexOf('<div id="root">'));
    }
    expect(base.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('view-transition');
    expect(base).not.toMatch(/html::after|status-scrim/);
    for (const n of ['glass', 'simple']) {
      const skin = readFileSync(`src/styles/skins/${n}.css`, 'utf8');
      expect(skin.match(/--status-tint:rgba\(20,21,24,0\)/g)?.length, n).toBe(2);
    }
  });

  it('src 下除了 base.css，没有 CSS 直接写 env(safe-area-inset-top)', () => {
    const bad = cssFiles('src')
      .filter((f) => !f.replaceAll('\\', '/').endsWith('src/styles/base.css'))
      .filter((f) => readFileSync(f, 'utf8').includes('env(safe-area-inset-top)'));
    expect(bad).toEqual([]);
  });
});
