// EditShell：待办、日程编辑页的外框。顶栏返回按钮的读屏名；只读、已删除两种顶部提示；删除按钮什么时候出
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditStatus } from '../../hooks/useEditRecord.ts';
import { uiStore } from '../../state/ui-store.ts';
import { EditShell } from '../EditShell.tsx';

beforeEach(() => uiStore.setState({ locale: 'zh-CN' }));
afterEach(cleanup);

const shell = (over: { status?: EditStatus; readonly?: boolean; deleted?: boolean; row?: Record<string, unknown> }, setDeleted = vi.fn(() => Promise.resolve('idle' as const))) =>
  render(
    <EditShell
      kind="待办"
      backLabel="返回"
      onBack={() => undefined}
      rec={{ row: over.row, status: over.status ?? 'idle', readonly: over.readonly ?? false, deleted: over.deleted ?? false, setDeleted }}
      own={{ empty: '写上标题才会保存', rejected: '格式不对' }}
      prefix="todo-edit"
    >
      {null}
    </EditShell>,
  );

describe('EditShell', () => {
  it('返回按钮写“‹ 返回”，读屏名只读“返回”', () => {
    shell({});
    const back = screen.getByTestId('edit-back');
    expect(back.textContent).toBe('‹ 返回');
    expect(screen.getByRole('button', { name: '返回' })).toBe(back);
  });

  it('只读：顶部浅灰条“这条要新版本才能修改 · 更新”（role=alert）；不写“改了就自动保存”，不出删除', () => {
    shell({ readonly: true, row: { id: 'a' } });
    const notice = screen.getByTestId('edit-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toBe('这条要新版本才能修改更新');
    expect(screen.getByTestId('todo-edit-update').textContent).toBe('更新');
    expect(screen.getByTestId('edit-status').textContent).toBe('');
    expect(screen.queryByTestId('todo-edit-delete')).toBeNull();
  });

  it('已删除：顶部红条带“撤销”，点了 setDeleted(false)；不出删除', () => {
    const setDeleted = vi.fn(() => Promise.resolve('idle' as const));
    shell({ deleted: true, row: { id: 'a' } }, setDeleted);
    expect(screen.getByTestId('edit-notice').textContent).toContain('已删除');
    fireEvent.click(screen.getByTestId('todo-edit-undo'));
    expect(setDeleted).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('todo-edit-delete')).toBeNull();
  });

  it('有这一行、没删、不只读：出删除；没写标题是灰字提示、不标红', () => {
    shell({ status: 'empty_title', row: { id: 'a' } });
    expect(screen.getByTestId('todo-edit-delete')).toBeTruthy();
    expect(screen.queryByTestId('edit-notice')).toBeNull();
    const st = screen.getByTestId('edit-status');
    expect(st.textContent).toBe('写上标题才会保存');
    expect(st.className).not.toMatch(/statusBad/);
  });
});
