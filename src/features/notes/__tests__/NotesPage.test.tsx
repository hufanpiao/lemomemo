// 随手记页在 B2 只写“即将推出”（负责人 11-05 ②，中韩文案；底栏点“随手记”进来）
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import NotesPage from '../ui/NotesPage.tsx';

beforeEach(() => act(() => uiStore.getState().setLocale('zh-CN')));
afterEach(cleanup);

describe('随手记页（B2）', () => {
  it('标题是页面名“随手记 / 메모”（设计动效评审 L5）；中文“即将推出”、韩文“메모는 준비 중이에요”，不显示功能名', () => {
    const view = render(<NotesPage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('随手记');
    expect(screen.getByText('即将推出')).toBeTruthy();
    expect(screen.queryByText('notes')).toBeNull();
    view.unmount();
    act(() => uiStore.getState().setLocale('ko-KR'));
    render(<NotesPage />);
    expect(screen.getByText('메모는 준비 중이에요')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('메모');
  });
});
