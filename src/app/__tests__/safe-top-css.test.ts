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
  it('base.css：body::before 固定在顶部，高 var(--safe-top)，背景默认 --bg、页面可用 --safe-top-bg 换，按整屏大小画，不挡点击', () => {
    const b = block(base, 'body::before');
    expect(b).toMatch(/content: '';/);
    expect(b).toMatch(/position: fixed;/);
    expect(b).toMatch(/top: 0;/);
    expect(b).toMatch(/height: var\(--safe-top\);/);
    expect(b).toMatch(/background: var\(--safe-top-bg, var\(--bg\)\);/);
    expect(b).toMatch(/background-size: 100vw 100vh;/);
    expect(b).toMatch(/pointer-events: none;/);
  });

  // 层级（审查必改 1、建议 4）：底色条 1 压住页面内容；弹层遮罩、内容（70）在它上面——position: fixed 而 z-index 为 auto 的元素画在第 0 层，
  // 会被 z-index 1 的底色条盖住，所以弹层必须写正的 z-index；版本横幅 50；整屏提示 100 在所有这些上面
  it('层级：底色条 1 < 版本横幅 50 < 弹层遮罩和内容 70 < 整屏提示 100', () => {
    const z = (src: string, sel: string): number => Number(/z-index: (\d+);/.exec(block(src, sel))?.[1] ?? NaN);
    const dialog = readFileSync('src/kit/components/Dialog.module.css', 'utf8');
    const strip = z(base, 'body::before');
    const banner = z(readFileSync('src/app/UpdateBanner.module.css', 'utf8'), '.banner');
    const scrim = z(dialog, '.scrim');
    const content = z(dialog, '.content');
    const blocked = z(readFileSync('src/app/CacheBlockedScreen.module.css', 'utf8'), '.screen');
    const tooNew = z(readFileSync('src/app/CacheTooNewScreen.module.css', 'utf8'), '.screen');
    expect(strip).toBe(1);
    expect(banner).toBeGreaterThan(strip);
    expect(scrim).toBeGreaterThan(banner);
    expect(content).toBe(scrim);
    expect(blocked).toBe(100);
    expect(tooNew).toBe(100);
    expect(scrim).toBeLessThan(blocked);
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

  it('告知页背景就是纯 --bg：底色条用默认值，不另设 --safe-top-bg', () => {
    const css = readFileSync('src/features/onboarding/ui/ConsentPage.module.css', 'utf8');
    expect(block(css, '.page')).toMatch(/background: var\(--bg\);/);
    expect(css).not.toMatch(/--safe-top-bg/);
  });

  it('有版本横幅时 --safe-top 为 0（底色条跟着变 0 高，由横幅占位）', () => {
    expect(block(base, ':root[data-top-banner]')).toMatch(/--safe-top: 0px;/);
  });

  it('告知页、登录页顶部写 var(--safe-top)', () => {
    for (const f of ['src/features/onboarding/ui/ConsentPage.module.css', 'src/features/auth/ui/AuthPage.module.css']) {
      expect(block(readFileSync(f, 'utf8'), '.page'), f).toMatch(/padding: max\(var\(--safe-top\), 32px\)/);
    }
  });

  it('src 下除了版本横幅，没有 CSS 直接写 env(safe-area-inset-top)', () => {
    const bad = cssFiles('src')
      .filter((f) => !f.replaceAll('\\', '/').endsWith('src/app/UpdateBanner.module.css'))
      .filter((f) => !f.replaceAll('\\', '/').endsWith('src/styles/base.css'))
      .filter((f) => readFileSync(f, 'utf8').includes('env(safe-area-inset-top)'));
    expect(bad).toEqual([]);
  });
});
