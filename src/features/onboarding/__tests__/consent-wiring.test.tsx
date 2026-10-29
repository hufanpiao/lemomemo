// 告知页接线（接手清单 CONSENT-wire ①～④；TC-B1-11 的单元一侧）：
// • 启动关口 ConsentGate：first 先显示告知页、做完才放行；updated、none、读失败都直接放行；回答之前什么也不画；
//   超过关口自己的上限（CONSENT-sugg ①）按读失败放行，之后才回来的结果不管。App 由调用方在 onPass 之后画（src/app/root.tsx）
// • 四个回调：同意 → 写 ai.enabled = true 后进 App；不同意 → 不写、进 App；会话不认 → 按“被移除”离开；停用 → 按“已停用”离开；
//   R-239 跳过 → 进 App
// • 路由 #/onboarding（ConsentRoute）：做完回今天页；关口做完时地址还在 #/onboarding 也换到今天页
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { CONSENT_SLOW_MS, type ConsentApi, type NoticeState, type Result } from '../data/consent-api.ts';
import { CONSENT_GATE_MS, type ConsentWiringDeps } from '../hooks/useConsentWiring.ts';
import { zh } from '../i18n/zh.ts';
import ConsentGate from '../ui/ConsentGate.tsx';
import ConsentRoute from '../ui/ConsentRoute.tsx';

function fakeApi(notice: Result<NoticeState> | 'hang' | 'throw', record: Result = { ok: true, value: undefined }): ConsentApi {
  return {
    record: vi.fn(async () => record),
    noticeState: vi.fn(() => {
      if (notice === 'hang') return new Promise<Result<NoticeState>>(() => undefined);
      if (notice === 'throw') return Promise.reject(new Error('boom'));
      return Promise.resolve(notice);
    }),
  };
}

function wiring() {
  const enableAi = vi.fn(async (): Promise<unknown> => undefined);
  const leave = vi.fn(async (_code: 'session_revoked' | 'account_disabled'): Promise<void> => undefined);
  const deps: ConsentWiringDeps = { enableAi, leave };
  return { deps, enableAi, leave };
}

const APP = <p data-testid="the-app">app</p>;
const first: Result<NoticeState> = { ok: true, value: 'first' };
const consentShown = (): boolean => document.querySelector('[data-step="consent"]') !== null;

/** 调用方的样子（同 src/app/root.tsx 的 GatedApp）：关口放行以后画 App */
function Gated({ api, deps, limitMs, onPass }: { api: ConsentApi; deps: ConsentWiringDeps; limitMs?: number; onPass?: () => void }) {
  const [passed, setPassed] = useState(false);
  if (passed) return APP;
  const pass = () => {
    onPass?.();
    setPassed(true);
  };
  return <ConsentGate api={api} wiring={deps} onPass={pass} {...(limitMs === undefined ? {} : { limitMs })} />;
}

async function renderGate(api: ConsentApi, deps: ConsentWiringDeps = wiring().deps, limitMs?: number, onPass?: () => void) {
  await act(async () => {
    render(<Gated api={api} deps={deps} {...(limitMs === undefined ? {} : { limitMs })} {...(onPass ? { onPass } : {})} />);
  });
}

async function agree() {
  fireEvent.click(screen.getByRole('checkbox', { name: zh['consent.check'] }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: zh['consent.agree'] }));
  });
}

async function decline() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: zh['consent.decline'] }));
  });
}

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  window.history.replaceState(null, '', '#/today');
});
afterEach(cleanup);

describe('启动关口 ConsentGate（CONSENT-wire ②）', () => {
  it('noticeState 回答之前什么也不画（不先闪一下 App）', async () => {
    await renderGate(fakeApi('hang'));
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(consentShown()).toBe(false);
  });

  it('first：先显示告知页、不画 App；只问一次 noticeState', async () => {
    const api = fakeApi(first);
    await renderGate(api);
    expect(consentShown()).toBe(true);
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(api.noticeState).toHaveBeenCalledOnce();
  });

  const pass: [string, Result<NoticeState>][] = [
    ['updated（“隐私说明更新了”那一屏还没做）', { ok: true, value: 'updated' }],
    ['none', { ok: true, value: 'none' }],
    ['读失败（断网）', { ok: false, error: 'offline' }],
  ];
  it.each(pass)('%s：直接进 App，不显示告知页', async (_name, r) => {
    await renderGate(fakeApi(r));
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(consentShown()).toBe(false);
  });

  it('noticeState 抛错：也不挡进 App', async () => {
    await renderGate(fakeApi('throw'));
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });

  it('慢网（CONSENT-sugg ①）：noticeState 一直不回，到关口上限按读失败放行；放行只一次', async () => {
    vi.useFakeTimers();
    try {
      const onPass = vi.fn();
      await renderGate(fakeApi('hang'), wiring().deps, 3000, onPass);
      expect(screen.queryByTestId('the-app')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(2999);
      });
      expect(screen.queryByTestId('the-app')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByTestId('the-app')).toBeTruthy();
      expect(onPass).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('上限以后才回来的 first：不管（已经进 App，不再弹告知页）', async () => {
    vi.useFakeTimers();
    try {
      let answer: (r: Result<NoticeState>) => void = () => undefined;
      const api: ConsentApi = { record: vi.fn(), noticeState: vi.fn(() => new Promise<Result<NoticeState>>((r) => (answer = r))) };
      await renderGate(api, wiring().deps, 3000);
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await act(async () => {
        answer(first);
      });
      expect(screen.getByTestId('the-app')).toBeTruthy();
      expect(consentShown()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('默认上限是 CONSENT_GATE_MS（3 秒，比 noticeState 自己的 8 秒短）', () => {
    expect(CONSENT_GATE_MS).toBe(3000);
    expect(CONSENT_GATE_MS).toBeLessThan(CONSENT_SLOW_MS);
  });

  it('同意（③）：record(true) 后写 ai.enabled = true，再进 App', async () => {
    const api = fakeApi(first);
    const w = wiring();
    await renderGate(api, w.deps);
    await agree();
    expect(api.record).toHaveBeenCalledWith(true, expect.any(Function));
    expect(w.enableAi).toHaveBeenCalledOnce();
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(w.leave).not.toHaveBeenCalled();
  });

  it('不同意：不写 ai.enabled（服务器撤回分支自己写 false），进 App', async () => {
    const w = wiring();
    await renderGate(fakeApi(first), w.deps);
    await decline();
    expect(w.enableAi).not.toHaveBeenCalled();
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });

  it('写 ai.enabled 失败（本机库不可用等）：照样进 App，不抛', async () => {
    const w = wiring();
    w.enableAi.mockRejectedValueOnce(new Error('x'));
    await renderGate(fakeApi(first), w.deps);
    await agree();
    expect(screen.getByTestId('the-app')).toBeTruthy();
  });

  it('会话不认（④ onRevoked）：按“被移除”离开（session_revoked），不进 App', async () => {
    const w = wiring();
    await renderGate(fakeApi(first, { ok: false, error: 'revoked' }), w.deps);
    await decline();
    expect(w.leave).toHaveBeenCalledWith('session_revoked');
    expect(screen.queryByTestId('the-app')).toBeNull();
  });

  it('账号停用（④ onDisabled）：按“已停用”离开（account_disabled → 登录页 auth.exit.disabled），不进 App', async () => {
    const w = wiring();
    await renderGate(fakeApi(first, { ok: false, error: 'disabled' }), w.deps);
    await agree();
    expect(w.leave).toHaveBeenCalledWith('account_disabled');
    expect(w.enableAi).not.toHaveBeenCalled();
    expect(screen.queryByTestId('the-app')).toBeNull();
  });

  it('R-239 没法保存选择（④ onSkip）：点“继续使用”直接进 App，不写 ai.enabled', async () => {
    const w = wiring();
    await renderGate(fakeApi(first, { ok: false, error: 'no_policy' }), w.deps);
    await decline();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['consent.continue'] }));
    });
    expect(screen.getByTestId('the-app')).toBeTruthy();
    expect(w.enableAi).not.toHaveBeenCalled();
  });

  it('做完时地址还在 #/onboarding：换到今天页，免得进 App 后再显示一遍告知页', async () => {
    window.history.replaceState(null, '', '#/onboarding');
    await renderGate(fakeApi(first));
    await decline();
    expect(window.location.hash).toBe('#/today');
  });
});

describe('路由 #/onboarding：ConsentRoute（CONSENT-wire ①）', () => {
  it('显示告知页；做完回今天页，同意时写 ai.enabled', async () => {
    window.history.replaceState(null, '', '#/onboarding');
    const w = wiring();
    await act(async () => {
      render(<ConsentRoute api={fakeApi(first)} wiring={w.deps} />);
    });
    expect(consentShown()).toBe(true);
    await agree();
    expect(w.enableAi).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe('#/today');
  });

  it('停用：离开设备，不回今天页', async () => {
    window.history.replaceState(null, '', '#/onboarding');
    const w = wiring();
    await act(async () => {
      render(<ConsentRoute api={fakeApi(first, { ok: false, error: 'disabled' })} wiring={w.deps} />);
    });
    await decline();
    expect(w.leave).toHaveBeenCalledWith('account_disabled');
    expect(window.location.hash).toBe('#/onboarding');
  });
});
