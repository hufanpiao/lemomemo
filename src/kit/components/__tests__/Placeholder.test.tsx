// 占位页（B0 骨架，各批次换成真页面）：原来的临时“设置”链接（PLACEHOLDER-settings-link）随 B2 底栏上线去掉——
// 设置入口改在今天页右上角头像（负责人 11-05 ①）；随手记页的“即将推出”见 features/notes/__tests__/NotesPage.test.tsx
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uiStore } from '../../state/ui-store.ts';
import { Placeholder } from '../Placeholder.tsx';

beforeEach(() => act(() => uiStore.getState().setLocale('zh-CN')));
afterEach(cleanup);

describe('占位页', () => {
  it('不再有临时的设置链接；没给说明时写功能名，给了写说明', () => {
    render(<Placeholder feature="vault" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('vault')).toBeTruthy();
    cleanup();
    render(<Placeholder feature="vault" note="即将推出" />);
    expect(screen.getByText('即将推出')).toBeTruthy();
    expect(screen.queryByText('vault')).toBeNull();
  });

});
