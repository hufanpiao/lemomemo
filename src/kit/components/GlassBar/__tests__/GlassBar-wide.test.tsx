// 电脑版侧栏（D5，(width >= 900px)）的 DOM 顺序（设计复审三 S2）：侧栏里“＋”画在最上面，DOM 也在 nav 前面，
// Tab 顺序是“＋”→ 四个页签 → 设置，和画面上下一致；窄屏“＋”在 nav 后面。窗口宽窄变了跟着换
// 首屏后部分下不来时宽屏也有设置入口（S1）：设置入口在外壳 nav 里，不等 GlassBarFx
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlassBar } from '../GlassBar.tsx';

vi.mock('../../../../motion/glass-ghost.ts', () => ({ startGlass: () => ({ stop: () => undefined, poke: () => undefined }), playGel: () => true }));

/** 假的 matchMedia：只认 (width >= 900px)，可以中途改宽窄并发 change */
function fakeWide(initial: boolean) {
  const subs = new Set<() => void>();
  const mq = {
    matches: initial,
    media: '(width >= 900px)',
    addEventListener: (_: string, f: () => void) => subs.add(f),
    removeEventListener: (_: string, f: () => void) => subs.delete(f),
  };
  vi.stubGlobal('matchMedia', (q: string) => (q === '(width >= 900px)' ? mq : { ...mq, matches: false }));
  return {
    set(v: boolean) {
      mq.matches = v;
      for (const f of subs) f();
    },
  };
}

/** 文档里能 Tab 到的底栏控件，按 DOM 顺序 */
const order = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="tabbar-add"], a[data-tab], [data-testid="tabbar-settings"]')].map(
    (el) => el.dataset['tab'] ?? el.dataset['testid'] ?? '',
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GlassBar 电脑版侧栏的 DOM 顺序', () => {
  it('宽屏：“＋”在 nav 前面（Tab 顺序“＋”→ 页签 → 设置）；变窄以后“＋”回到 nav 后面', () => {
    const w = fakeWide(true);
    render(<GlassBar active="today" later={() => undefined} add={{ label: '新建日程', onClick: () => undefined }} />);
    expect(order()).toEqual(['tabbar-add', 'today', 'calendar', 'todos', 'notes', 'tabbar-settings']);
    expect(screen.getByRole('navigation').previousElementSibling).toBe(screen.getByTestId('tabbar-add'));
    act(() => w.set(false));
    expect(order()).toEqual(['today', 'calendar', 'todos', 'notes', 'tabbar-settings', 'tabbar-add']);
    expect(screen.getByRole('navigation').nextElementSibling).toBe(screen.getByTestId('tabbar-add'));
  });

  it('首屏后部分一直没下载（later 不回调）：宽屏照样有设置入口', () => {
    fakeWide(true);
    render(<GlassBar active="todos" later={() => undefined} />);
    expect(screen.queryByTestId('tabbar-band')).toBeNull();
    expect(screen.getByRole('link', { name: '设置' }).getAttribute('data-testid')).toBe('tabbar-settings');
  });
});
