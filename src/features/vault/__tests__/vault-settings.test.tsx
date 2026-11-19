// 设置 › 隐私记（ui/VaultSettings.tsx）
// • 审查第 18 条：已绑定设备列表读不出来时，错误提示带 role="alert"（读屏马上念）
// • 独立评审 11-19 高 6：磨砂遮罩里的解锁卡，“隐私记已上锁”读屏只念一次（对话框名字），卡片上那行不再算一个标题
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVaultSession } from '../hooks/useVault.ts';
import { UnlockOverlay, UnlockPanel } from '../ui/Unlock.tsx';
import { VaultSettings } from '../ui/VaultSettings.tsx';
import { make, statusSet } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));

afterEach(() => {
  cleanup();
  installVaultSession(null);
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
      <UnlockOverlay open>
        <UnlockPanel onForgot={() => undefined} />
      </UnlockOverlay>,
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
