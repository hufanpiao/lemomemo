// MeLink：顶栏右上角的设置入口头像（R-381，今天、待办、日历、随手记四页共用）
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../../app/router.ts', () => ({
  hrefOf: (name: string) => `#/${name}`,
  navigateTab: (name: string) => nav.calls.push(name),
  // 和真的一样：左键、没按修饰键才算“页内跳”
  plainClick: (e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
    e.preventDefault();
    return true;
  },
}));
vi.mock('../../hooks/useMeInitial.ts', () => ({ useMeInitial: () => '柠' }));

const { MeLink } = await import('../MeLink.tsx');
const css = readFileSync('src/kit/components/MeLink.module.css', 'utf8');

afterEach(() => {
  nav.calls = [];
  cleanup();
});

describe('MeLink', () => {
  it('是指向 #/settings 的链接，读屏名“设置”，里面是头像（名字第一个字）；testId 按页传', () => {
    render(<MeLink testId="cal-settings" />);
    const a = screen.getByTestId('cal-settings');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('#/settings');
    expect(a.getAttribute('aria-label')).toBe('设置');
    expect(a.textContent).toBe('柠');
  });

  it('点一下交给 navigateTab("settings")（R-372 历史）；Ctrl 点（新标签页打开）不拦', () => {
    render(<MeLink testId="todos-settings" />);
    const a = screen.getByTestId('todos-settings');
    fireEvent.click(a);
    expect(nav.calls).toEqual(['settings']);
    fireEvent.click(a, { ctrlKey: true });
    expect(nav.calls).toEqual(['settings']);
  });

  it('样式：触控区 44（var(--hit)）见方的圆；电脑宽屏（≥ 900px）藏掉，设置入口在侧栏', () => {
    expect(css).toMatch(/\.me \{[^}]*width: var\(--hit\);[^}]*height: var\(--hit\);[^}]*border-radius: 50%;/);
    expect(css).toMatch(/@media \(width >= 900px\) \{\s*\.me \{\s*display: none;/);
  });

  it('四页都用它（R-381 负责人“不然不和谐”）：testId 各是 today-settings、todos-settings、cal-settings、notes-settings，页面里不再自己写设置链接', () => {
    for (const [file, id] of [
      ['src/features/today/ui/TodayPage.tsx', 'today-settings'],
      ['src/features/todos/ui/TodosPage.tsx', 'todos-settings'],
      ['src/features/calendar/ui/CalendarPage.tsx', 'cal-settings'],
      ['src/features/notes/ui/NotesPage.tsx', 'notes-settings'],
    ] as const) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain(`<MeLink testId="${id}" />`);
      expect(src, file).not.toMatch(/hrefOf\('settings'\)|navigateTab\('settings'\)/);
    }
  });
});
