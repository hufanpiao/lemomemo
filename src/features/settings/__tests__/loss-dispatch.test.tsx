// 会话没了、账号停用时按错误码分发（账号退出链路收口，2026-11-20 现状表第二节）：换头像、改语言两处原来各写一份 if/else，
// 这里钉住它们交给哪个出口、带哪个 sid，自己的失败提示照旧显示；改成同一个分发以后同一批用例照跑
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../platform/doc-locale.ts', () => ({ applyUiLocale: (ui: string, s: { setLocale(l: string): void }) => s.setLocale(ui), loadSharedDict: vi.fn(() => null) }));
vi.mock('../data/local.ts', async (orig) => ({ ...(await orig()), writeLocalLocale: vi.fn(), updateCachedLocale: vi.fn(async () => undefined) }));

import { uiStore } from '../../../kit/state/ui-store.ts';
import type { SettingsErr } from '../data/settings-api.ts';
import { useLocaleSwitch } from '../hooks/useLocaleSwitch.ts';
import { useMeAvatarEdit } from '../hooks/useMeAvatarEdit.ts';
import { fail, fakeApi } from './fakes.tsx';

afterEach(() => {
  cleanup();
  uiStore.getState().setLocale('zh-CN');
});

const exits = () => ({ onRevoked: vi.fn(), onSignedOut: vi.fn(), onDisabled: vi.fn() });

describe('去掉头像失败', () => {
  for (const [error, which] of [['revoked', 'onRevoked'], ['signed_out', 'onSignedOut'], ['account_disabled', 'onDisabled']] as const) {
    it(`${error} → ${which}(被拒那次的 sid)，其余出口不调；状态照样显示写入失败`, async () => {
      const api = fakeApi({ saveAvatar: vi.fn(async () => fail(error as SettingsErr, 's9')) });
      const ex = exits();
      const { result } = renderHook(() => useMeAvatarEdit(api, ex));
      await act(() => result.current.remove());
      expect(ex[which]).toHaveBeenCalledWith('s9');
      for (const k of ['onRevoked', 'onSignedOut', 'onDisabled'] as const) if (k !== which) expect(ex[k]).not.toHaveBeenCalled();
      expect(result.current.state).toBe('write_failed');
    });
  }

  it('别的错误（断网）：哪个出口都不调', async () => {
    const api = fakeApi({ saveAvatar: vi.fn(async () => fail('offline')) });
    const ex = exits();
    const { result } = renderHook(() => useMeAvatarEdit(api, ex));
    await act(() => result.current.remove());
    expect(ex.onRevoked).not.toHaveBeenCalled();
    expect(ex.onSignedOut).not.toHaveBeenCalled();
    expect(ex.onDisabled).not.toHaveBeenCalled();
    expect(result.current.state).toBe('offline');
  });
});

describe('11-18 评审加密组第 6 条：被移除的原始码和状态一路带到出口', () => {
  const why = { code: 'session_not_found', status: 403 };
  it('换头像、改语言：onRevoked 收到 why', async () => {
    const withWhy = { ...fail('revoked', 's9'), why };
    const ex = exits();
    const a = renderHook(() => useMeAvatarEdit(fakeApi({ saveAvatar: vi.fn(async () => withWhy) }), ex));
    await act(() => a.result.current.remove());
    expect(ex.onRevoked).toHaveBeenCalledWith('s9', why);
    const ex2 = exits();
    const b = renderHook(() => useLocaleSwitch(fakeApi({ saveLocale: vi.fn(async () => withWhy) }), ex2.onRevoked, ex2.onSignedOut));
    await act(() => b.result.current.choose('ko'));
    expect(ex2.onRevoked).toHaveBeenCalledWith('s9', why);
  });
});

describe('改语言写账号失败', () => {
  for (const [error, which] of [['revoked', 'onRevoked'], ['signed_out', 'onSignedOut'], ['account_disabled', 'onDisabled']] as const) {
    it(`${error} → ${which}(被拒那次的 sid)；提示没保存上`, async () => {
      const api = fakeApi({ saveLocale: vi.fn(async () => fail(error as SettingsErr, 's9')) });
      const ex = exits();
      const { result } = renderHook(() => useLocaleSwitch(api, ex.onRevoked, ex.onSignedOut, ex.onDisabled));
      await act(() => result.current.choose('ko'));
      expect(ex[which]).toHaveBeenCalledWith('s9');
      for (const k of ['onRevoked', 'onSignedOut', 'onDisabled'] as const) if (k !== which) expect(ex[k]).not.toHaveBeenCalled();
      expect(result.current.sync).toBe('failed');
    });
  }

  it('没给 onDisabled：account_disabled 只提示没保存上', async () => {
    const api = fakeApi({ saveLocale: vi.fn(async () => fail('account_disabled', 's9')) });
    const ex = exits();
    const { result } = renderHook(() => useLocaleSwitch(api, ex.onRevoked, ex.onSignedOut));
    await act(() => result.current.choose('ko'));
    expect(ex.onRevoked).not.toHaveBeenCalled();
    expect(result.current.sync).toBe('failed');
  });
});
