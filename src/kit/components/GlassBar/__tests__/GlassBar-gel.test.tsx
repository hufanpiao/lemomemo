// 液滴果冻（设计动效评审 L1）：在首屏后部分（GlassBarFx.tsx）里放。液滴里层一直是同一个元素（不换 key 重挂，重挂会让形变跳回原样），
// 换页签调副本引擎的 playGel（WAAPI）从当前形变接着放；playGel 做不了（返回 false）时给里层重新加 CSS 动画类 .jelly
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import styles from '../GlassBar.module.css';
import fxStyles from '../GlassBarFx.module.css';

const fx = vi.hoisted(() => ({ ok: true, started: 0, calls: [] as HTMLElement[] }));
vi.mock('../../../../motion/glass-ghost.ts', () => ({
  startGlass: () => {
    fx.started += 1;
    return { stop: () => undefined, poke: () => undefined };
  },
  playGel: (el: HTMLElement) => {
    fx.calls.push(el);
    return fx.ok;
  },
}));
const { GlassBar } = await import('../GlassBar.tsx');

afterEach(() => {
  cleanup();
  fx.calls = [];
  fx.ok = true;
  fx.started = 0;
});
const jelly = (): Element | null => document.querySelector(`.${styles.drop} > span`);
/** 首屏后部分挂上（模糊带出现），而且它再 import() 的副本引擎也到了（startGlass 调过） */
const ready = async (): Promise<void> => {
  await waitFor(() => expect(screen.getByTestId('tabbar-band')).toBeTruthy());
  await waitFor(() => expect(fx.started).toBe(1));
};

describe('GlassBar 果冻（L1）', () => {
  it('首屏后部分到了以前换页签：不放果冻（外壳里没有果冻代码）', () => {
    const view = render(<GlassBar active="today" later={() => undefined} />);
    const first = jelly();
    expect(first?.className).toBe(styles.jellyJs);
    view.rerender(<GlassBar active="todos" later={() => undefined} />);
    expect(fx.calls.length).toBe(0);
    expect(jelly()).toBe(first);
    expect(first?.classList.contains(fxStyles.jelly ?? '')).toBe(false);
  });

  it('到了以后：换页签调 playGel，同一个元素、不重挂；下载到时的位置不放、没换页签不放', async () => {
    const view = render(<GlassBar active="today" />);
    await ready();
    const first = jelly();
    expect(fx.calls.length).toBe(0);
    view.rerender(<GlassBar active="today" />);
    expect(fx.calls.length).toBe(0);
    view.rerender(<GlassBar active="todos" />);
    view.rerender(<GlassBar active="notes" />);
    expect(fx.calls).toEqual([first, first]);
    expect(jelly()).toBe(first);
  });

  it('playGel 做不了（副本引擎没到时同一条路）：里层加上 CSS 动画类 .jelly（每换一次先去掉再加，从头放）', async () => {
    fx.ok = false;
    const view = render(<GlassBar active="today" />);
    await ready();
    const el = jelly() as HTMLElement;
    const seen: string[] = [];
    new MutationObserver((ms) => ms.forEach((m) => seen.push(m.oldValue ?? ''))).observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    view.rerender(<GlassBar active="todos" />);
    await act(async () => undefined);
    expect(el.classList.contains(fxStyles.jelly ?? '')).toBe(true);
    seen.length = 0;
    view.rerender(<GlassBar active="notes" />);
    await act(async () => undefined);
    expect(seen.some((c) => !c.split(' ').includes(fxStyles.jelly ?? ''))).toBe(true); // 中间去掉过一次
    expect(el.classList.contains(fxStyles.jelly ?? '')).toBe(true);
  });
});
