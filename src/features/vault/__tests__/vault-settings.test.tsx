// 设置 › 隐私记（ui/VaultSettings.tsx）
// • 审查第 18 条：已绑定设备列表读不出来时，错误提示带 role="alert"（读屏马上念）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVaultSession } from '../hooks/useVault.ts';
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
