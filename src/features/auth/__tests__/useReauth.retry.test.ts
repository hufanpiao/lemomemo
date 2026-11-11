// 登录页查 session_fate 限流、5xx 时的退避重查（R-382 安全审建议 1）：30 秒起每次翻倍、最长 5 分钟、最多 5 次；
// 到点离线就等联网；查回 revoked 照旧清库；回 null（查不了、不该重试）不再查；卸载后不再查
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReauthDeps } from '../data/reauth.ts';
import { FATE_RETRY_BASE_MS, FATE_RETRY_CAP_MS, FATE_RETRY_MAX, useReauth } from '../hooks/useReauth.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';

type Fate = Awaited<ReturnType<ReauthDeps['fate']>>;

function deps(fates: Fate[], o: Partial<ReauthDeps> = {}) {
  // 排好的回完以后一直回 retry
  const fate = vi.fn(async (): Promise<Fate> => (fates.length > 0 ? (fates.shift() as Fate) : 'retry'));
  const wipe = vi.fn(async () => undefined);
  const d: ReauthDeps = {
    read: () => ({ v: 1, user_id: A, session_id: S, at: 1 }),
    count: async () => 0,
    online: () => true,
    onOnline: () => () => undefined,
    fate,
    wipe,
    clearAuthLoss: () => undefined,
    ...o,
  };
  return { d, fate, wipe };
}

/** 让已排队的 promise 回调跑完 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('登录页 session_fate 退避重查', () => {
  it('回 retry：30 秒后再查，再回 retry 等 60 秒；第三次回 revoked 清库、改提示被移除', async () => {
    const { d, fate, wipe } = deps(['retry', 'retry', 'revoked']);
    const { result } = renderHook(() => useReauth(d));
    await settle();
    expect(fate).toHaveBeenCalledTimes(1);
    await advance(FATE_RETRY_BASE_MS - 1);
    expect(fate).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fate).toHaveBeenCalledTimes(2);
    await advance(FATE_RETRY_BASE_MS * 2 - 1);
    expect(fate).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fate).toHaveBeenCalledTimes(3);
    await settle();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(result.current.view.kind).toBe('removed');
  });

  it('一直 retry：间隔 30、60、120、240、300 秒（封顶 5 分钟），重查满 5 次后不再查', async () => {
    const { d, fate } = deps([]);
    renderHook(() => useReauth(d));
    await settle();
    const waits = [30_000, 60_000, 120_000, 240_000, 300_000];
    expect(waits).toHaveLength(FATE_RETRY_MAX);
    expect(Math.max(...waits)).toBe(FATE_RETRY_CAP_MS);
    for (const [i, w] of waits.entries()) {
      await advance(w - 1);
      expect(fate).toHaveBeenCalledTimes(i + 1);
      await advance(1);
      expect(fate).toHaveBeenCalledTimes(i + 2);
    }
    await advance(FATE_RETRY_CAP_MS * 3);
    expect(fate).toHaveBeenCalledTimes(FATE_RETRY_MAX + 1);
  });

  it('回 null（离线、超时、404 这类查不了）或 unknown：不重查', async () => {
    for (const f of [null, 'unknown'] as const) {
      const { d, fate } = deps([f]);
      const { unmount } = renderHook(() => useReauth(d));
      await settle();
      await advance(FATE_RETRY_CAP_MS * 5);
      expect(fate).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('到点时离线：先不查，等联网再查', async () => {
    let online = true;
    let fire: (() => void) | null = null;
    const { d, fate } = deps(['retry', 'unknown'], {
      online: () => online,
      onOnline: (fn) => {
        fire = fn;
        return () => {
          fire = null;
        };
      },
    });
    renderHook(() => useReauth(d));
    await settle();
    online = false;
    await advance(FATE_RETRY_BASE_MS);
    expect(fate).toHaveBeenCalledTimes(1);
    expect(fire).not.toBeNull();
    online = true;
    await act(async () => {
      fire?.();
      await Promise.resolve();
    });
    expect(fate).toHaveBeenCalledTimes(2);
  });

  it('卸载后不再重查', async () => {
    const { d, fate } = deps(['retry']);
    const { unmount } = renderHook(() => useReauth(d));
    await settle();
    unmount();
    await advance(FATE_RETRY_CAP_MS * 5);
    expect(fate).toHaveBeenCalledTimes(1);
  });
});
