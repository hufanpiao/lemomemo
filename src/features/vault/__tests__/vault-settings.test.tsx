// 设置 › 隐私记（ui/VaultSettings.tsx）
// • 审查第 18 条：已绑定设备列表读不出来时，错误提示带 role="alert"（读屏马上念）
// • 独立评审 11-19 高 6：磨砂遮罩里的解锁卡，“隐私记已上锁”读屏只念一次（对话框名字），卡片上那行不再算一个标题
// • 隐私记整块收拾 11-20 中 10：子页跟着地址走（#/settings/vault/reset ↔ #/settings/vault）；低 19：设新密码这一步也有“取消”
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVaultSession, useFailText } from '../hooks/useVault.ts';
import type * as Auth from '../hooks/useVaultAuth.ts';
import { ResetFlow } from '../ui/ResetFlow.tsx';
import { LockLayer, UnlockPanel } from '../ui/Unlock.tsx';
import { VaultSettings } from '../ui/VaultSettings.tsx';
import { make, statusSet } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
// 重设流程：用例可把 useVaultReset 换成固定的一步（不走发码、验码）；null = 用真的
const resetAs = vi.hoisted(() => ({ v: null as null | Record<string, unknown> }));
vi.mock('../hooks/useVaultAuth.ts', async (orig) => {
  const real = await orig<typeof Auth>();
  return { ...real, useVaultReset: () => (resetAs.v ?? real.useVaultReset()) as ReturnType<typeof real.useVaultReset> };
});

afterEach(() => {
  cleanup();
  installVaultSession(null);
  resetAs.v = null;
  window.location.hash = '';
});

const resetAt = (step: string) => ({ email: 'a@b.c', step, busy: false, error: null, send: vi.fn(), verify: vi.fn(), setPin: vi.fn() });

describe('子页跟着地址走', () => {
  it('#/settings/vault/reset 打开重设；地址换回 #/settings/vault 回到首页；再换到 /reset 又打开', async () => {
    resetAs.v = resetAt('intro');
    const m = make({ status: () => statusSet });
    installVaultSession(m.s);
    window.location.hash = '#/settings/vault/reset';
    render(<VaultSettings />);
    await act(async () => {
      await m.s.refreshStatus();
    });
    expect(screen.getByTestId('vault-reset-intro')).toBeTruthy();
    act(() => {
      window.location.hash = '#/settings/vault';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(screen.getByTestId('vault-settings')).toBeTruthy());
    expect(screen.queryByTestId('vault-reset-intro')).toBeNull();
    act(() => {
      window.location.hash = '#/settings/vault/reset';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(screen.getByTestId('vault-reset-intro')).toBeTruthy());
  });
});

describe('useFailText（隐私记整块收拾 11-20 高 2：Unlock、SetupPin、改密码三处过滤错误码合成一处）', () => {
  it('成功、没结果、上锁类（vault_locked、vault_relock，由锁层接手）不写；输错写还能试几次；别的码照 errText', () => {
    const { result } = renderHook(() => useFailText());
    const f = result.current;
    expect(f(null)).toBe('');
    expect(f({ ok: true, value: true })).toBe('');
    expect(f({ ok: false, code: 'vault_locked' })).toBe('');
    expect(f({ ok: false, code: 'vault_relock' })).toBe('');
    expect(f({ ok: false, code: 'pin_wrong', left: 2 })).toContain('2');
    expect(f({ ok: false, code: 'try_later' })).not.toBe('');
  });
});

describe('重设：设新密码这一步', () => {
  it('键盘下面有“取消”，点了回去（onDone）；页面里只有一层 .pin（NewPinSteps 不再套一层）', () => {
    resetAs.v = resetAt('pin');
    const done = vi.fn();
    const m = make({ status: () => statusSet });
    installVaultSession(m.s);
    const { container } = render(<ResetFlow onDone={done} />);
    const cancel = screen.getByTestId('vault-reset-cancel');
    expect(cancel.textContent).toBe('取消');
    fireEvent.click(cancel);
    expect(done).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[class~="pin"] [class~="pin"]')).toHaveLength(0);
  });
});

describe('设置 › 隐私记 › 已绑定的设备', () => {
  it('列表读不出来（服务忙）：错误提示 role="alert"', async () => {
    const m = make({ status: () => ({ ...statusSet, webauthn: 1 }), list_credentials: () => ({ ok: false, code: 'try_later' }) });
    installVaultSession(m.s);
    render(<VaultSettings />);
    await act(async () => {
      await m.s.refreshStatus();
    });
    fireEvent.click(await screen.findByTestId('vault-set-devices'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toBe('');
    expect(screen.getByTestId('vault-devices').contains(alert)).toBe(true);
  });
});

describe('磨砂遮罩里的解锁卡', () => {
  it('“隐私记已上锁”读屏只念一次：对话框用它当名字，卡片上那行对读屏藏起来', async () => {
    const m = make({ status: () => statusSet });
    installVaultSession(m.s);
    render(
      <LockLayer variant="overlay" open>
        <UnlockPanel onForgot={() => undefined} />
      </LockLayer>,
    );
    await act(async () => {
      await m.s.refreshStatus();
    });
    expect(screen.getByRole('dialog', { name: '隐私记已上锁' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: '隐私记已上锁' })).toHaveLength(1);
    // 看得见的那行字还在（只是读屏不再念第二遍）
    expect(screen.getAllByText('隐私记已上锁')).toHaveLength(2);
  });
});
