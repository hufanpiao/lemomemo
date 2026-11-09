// 告知页接线记下同意版本是不是明确过期（B3 前端接 ai-parse 安全审 S1，方案 ①；kit/state/consent-fresh.ts，打字条据此不发 ai-parse）：
// • 关口问到 first、updated 记成过期，none 记成够新；读失败、抛错不动（不知道就不管，由服务器把关）
// • 关口超时放行以后才回来的结果也记
// • 告知页做完（onDone，服务器已记下当前版本）：同意记成可以发，不同意记成不发
// • 退出登录、换账号后当没记过；会话 id 为空（''、null、undefined）一律当没记过（安全复核建议）
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consentStale, setConsentStale } from '../../../kit/state/consent-fresh.ts';
import type * as Session from '../../../platform/session.ts';
import type { ConsentApi, NoticeState, Result } from '../data/consent-api.ts';
import { useConsentHandlers, useNoticeState, type ConsentWiringDeps } from '../hooks/useConsentWiring.ts';

vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));
const SID = 'sid-t';

const api = (r: Result<NoticeState> | 'throw'): ConsentApi => ({
  record: vi.fn(),
  noticeState: vi.fn(() => (r === 'throw' ? Promise.reject(new Error('boom')) : Promise.resolve(r))),
});
const deps: ConsentWiringDeps = { enableAi: vi.fn(async () => undefined), leave: vi.fn(async () => undefined) };

afterEach(() => {
  cleanup();
  setConsentStale(false, null);
});

async function settled(a: ConsentApi): Promise<void> {
  renderHook(() => useNoticeState(a));
  await act(async () => {
    await Promise.resolve();
  });
}

describe('S1：记下同意版本是不是明确过期', () => {
  it('first、updated 记成过期；none 记成够新；读失败、抛错不动', async () => {
    await settled(api({ ok: true, value: 'first' }));
    expect(consentStale(SID)).toBe(true);
    await settled(api({ ok: true, value: 'none' }));
    expect(consentStale(SID)).toBe(false);
    await settled(api({ ok: true, value: 'updated' }));
    expect(consentStale(SID)).toBe(true);
    await settled(api({ ok: false, error: 'network' } as unknown as Result<NoticeState>));
    await settled(api('throw'));
    expect(consentStale(SID)).toBe(true);
  });

  it('关口超时放行以后才回来的 updated 也记下（关口照旧不再弹）', async () => {
    vi.useFakeTimers();
    try {
      let answer!: (r: Result<NoticeState>) => void;
      const a: ConsentApi = { record: vi.fn(), noticeState: vi.fn(() => new Promise<Result<NoticeState>>((r) => (answer = r))) };
      const { result } = renderHook(() => useNoticeState(a, 100));
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(result.current).toBe('error');
      await act(async () => {
        answer({ ok: true, value: 'updated' });
        await Promise.resolve();
      });
      expect(result.current).toBe('error');
      expect(consentStale(SID)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('告知页做完：同意 → 可以发；不同意 → 不发（ai.enabled 同步回本机之前的空档也关上，安全复审）', () => {
    for (const agreed of [true, false]) {
      setConsentStale(!agreed, SID);
      const { result } = renderHook(() => useConsentHandlers(() => undefined, deps));
      result.current.onDone(agreed);
      expect(consentStale(SID)).toBe(!agreed);
    }
  });

  it('跟着登录走：退出登录（没有会话）、换了账号（会话不同）就当没记过，不靠整页重载复位', () => {
    setConsentStale(true, 'sid-1');
    expect(consentStale('sid-1')).toBe(true);
    expect(consentStale(null)).toBe(false);
    expect(consentStale('sid-2')).toBe(false);
  });
});
