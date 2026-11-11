// BUSY-wire（B2 FA-5）：编辑页挂着期间占住升级中心的 busy，离开就释放；还没启动时什么都不做
import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const release = vi.fn();
const holdBusy = vi.fn(() => release);
const boot = { current: null as null | { upgrade: { holdBusy: (reason: string) => () => void } } };
vi.mock('../../../core/boot.ts', () => ({ getBoot: () => boot.current }));

const { EditShell } = await import('../../components/EditShell.tsx');

afterEach(() => {
  cleanup();
  holdBusy.mockClear();
  release.mockClear();
  boot.current = null;
});

const shell = () => (
  <EditShell kind="k" backLabel="b" onBack={() => undefined} rec={{ row: undefined, status: 'idle', readonly: false, deleted: false, setDeleted: () => Promise.resolve('idle') }} own={{ empty: '', rejected: '' }} prefix="x-edit">
    {null}
  </EditShell>
);

describe('编辑页占住 busy', () => {
  it('挂上就 holdBusy("editing")，卸载才释放；重画不重复占', () => {
    boot.current = { upgrade: { holdBusy } };
    const r = render(shell());
    r.rerender(shell());
    expect(holdBusy).toHaveBeenCalledTimes(1);
    expect(holdBusy).toHaveBeenCalledWith('editing');
    expect(release).not.toHaveBeenCalled();
    r.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('StrictMode 双挂载（开发版）：占两次、放一次，最后只剩一个令牌；卸载后为 0（代码审查 FA5-CR）', () => {
    let live = 0;
    const counting = vi.fn(() => {
      live += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        live -= 1;
      };
    });
    boot.current = { upgrade: { holdBusy: counting } };
    const r = render(<StrictMode>{shell()}</StrictMode>);
    expect(counting).toHaveBeenCalledTimes(2);
    expect(live).toBe(1);
    r.rerender(<StrictMode>{shell()}</StrictMode>);
    expect(live).toBe(1);
    r.unmount();
    expect(live).toBe(0);
  });

  it('还没启动（拿不到升级中心）：照常画、不报错', () => {
    const r = render(shell());
    expect(r.getByTestId('edit-status').textContent).toBe('改了就自动保存');
    expect(holdBusy).not.toHaveBeenCalled();
  });
});
