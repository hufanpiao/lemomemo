// 第一次设密码时勾了“以后用 Face ID 解锁”、密码设好了但 Face ID 没绑上（审查第 3 条）：
// 原来 SetupPin 丢掉 wa.register 的结果，什么也不提示；现在出一条提示（kit UndoToast，role=alert），引导去“设置 › 隐私记”再绑，点了进 #/settings/vault
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installVaultSession } from '../hooks/useVault.ts';
import VaultPage from '../ui/VaultPage.tsx';
import { make, statusSet } from './session-fakes.ts';

vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
const passkey = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('../../../platform/webauthn.ts', () => ({
  webauthnUsable: async () => true,
  createPasskey: async () => passkey.result,
  getAssertion: async () => null,
}));

const b64 = 'AAAA';
const options = { ok: true, challenge: b64, rp_id: 'localhost', timeout_ms: 60_000, user_id: b64, credential_ids: [] };

beforeEach(() => {
  window.location.hash = '#/vault';
});
afterEach(() => {
  cleanup();
  installVaultSession(null);
  window.location.hash = '';
});

async function setupWithFace(m: ReturnType<typeof make>) {
  installVaultSession(m.s);
  render(<VaultPage />);
  const face = await screen.findByTestId('vault-setup-face');
  fireEvent.click(face);
  for (let round = 0; round < 2; round++) {
    await act(async () => {
      for (const i of [0, 1, 2, 3]) fireEvent.click(screen.getByTestId(`vault-setup-pad-key-${i}`));
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe('审查第 3 条：设密码时 Face ID 绑定失败要提示', () => {
  it('系统弹窗取消（createPasskey 回 null）：密码设好、进列表，出提示，点“去设置”进 设置 › 隐私记', async () => {
    passkey.result = null;
    const m = make({ status: () => ({ ...statusSet, set: false }), setup: () => ({ ok: true, vault_token: 't'.repeat(32), expires_at: 9e12 }), webauthn_options: () => options });
    await setupWithFace(m);
    expect(m.calls.map((c) => c.action)).toContain('setup');
    const tip = await screen.findByTestId('vault-bind-fail');
    expect(tip.getAttribute('role')).toBe('alert');
    expect(tip.textContent).toContain('设置 › 隐私记');
    fireEvent.click(screen.getByTestId('vault-bind-fail-undo'));
    expect(window.location.hash).toBe('#/settings/vault');
  });

  it('服务器拒了绑定（webauthn_register 失败）：同样提示', async () => {
    passkey.result = { id: b64, client_data_json: b64, attestation_object: b64 };
    const m = make({
      status: () => ({ ...statusSet, set: false }),
      setup: () => ({ ok: true, vault_token: 't'.repeat(32), expires_at: 9e12 }),
      webauthn_options: () => options,
      webauthn_register: () => ({ ok: false, code: 'webauthn_failed' }),
    });
    await setupWithFace(m);
    expect(m.calls.map((c) => c.action)).toContain('webauthn_register');
    await screen.findByTestId('vault-bind-fail');
  });
});
