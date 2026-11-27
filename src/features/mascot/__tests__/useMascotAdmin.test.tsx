// 管理员身份整个 App 一份（hooks/useMascotAdmin.ts）：
// • 负责人 11-24 录屏“进入二级页还是吉祥物还是会消失一下”：退回今天页重新挂上时不再从“不知道”起
// • 冷启动 2 秒没答先按普通账号；之后读到是管理员，所有用到的地方一起变；读不到过一会儿再问
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetMascotSession } from '../hooks/mascot-session.ts';
import { ADMIN_RETRY_MS, ADMIN_WAIT_MS, useMascotAdmin } from '../hooks/useMascotAdmin.ts';

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../platform/ai-usage.ts', () => ({ readAiUsage: h.read }));
vi.mock('../data/mascot-private.ts', () => ({ readPrivateCredit: vi.fn() }));

const answer = (unlimited: boolean) => ({ ok: true, value: { used: 0, limit: 50, unlimited } });
const offline = { ok: false, err: 'offline' };
/** 手动放行的回答 */
const later = () => {
  let give: (v: unknown) => void = () => undefined;
  const p = new Promise((r) => {
    give = r;
  });
  return { p, give: (v: unknown) => give(v) };
};
const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  resetMascotSession();
  h.read.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('第一次等服务器；卸掉再挂上第一帧就是上次的答案；读不到不推翻；服务器改了跟着改', async () => {
  const mountOnce = async (reply: unknown): Promise<{ first: boolean | null; settled: boolean | null }> => {
    h.read.mockResolvedValueOnce(reply);
    const hook = renderHook(() => useMascotAdmin());
    const first = hook.result.current;
    await flush();
    const settled = hook.result.current;
    hook.unmount();
    return { first, settled };
  };
  expect(await mountOnce(answer(true))).toEqual({ first: null, settled: true });
  expect(await mountOnce(offline)).toEqual({ first: true, settled: true });
  expect(await mountOnce(answer(false))).toEqual({ first: true, settled: false });
  expect(await mountOnce(answer(false))).toEqual({ first: false, settled: false });
});

it('冷启动 2 秒没答：先按普通账号（false）；之后读到是管理员，今天页和设置页（两处在用的）一起变成 true', async () => {
  const slow = later();
  h.read.mockReturnValueOnce(slow.p);
  const today = renderHook(() => useMascotAdmin(true));
  const settings = renderHook(() => useMascotAdmin(true));
  expect([today.result.current, settings.result.current]).toEqual([null, null]);
  await flush(ADMIN_WAIT_MS);
  expect([today.result.current, settings.result.current]).toEqual([false, false]);
  slow.give(answer(true));
  await flush();
  expect([today.result.current, settings.result.current]).toEqual([true, true]);
  // 同时在用的两处只问了一次
  expect(h.read).toHaveBeenCalledTimes(1);
});

it('读不到：过 ADMIN_RETRY_MS 再问，问到了所有用到的地方跟着变；不需要的（need=false）不发请求但照样更新', async () => {
  h.read.mockResolvedValueOnce(offline).mockResolvedValueOnce(answer(true));
  const passive = renderHook(() => useMascotAdmin(false));
  const active = renderHook(() => useMascotAdmin(true));
  await flush(ADMIN_WAIT_MS);
  expect(active.result.current).toBe(false);
  await flush(ADMIN_RETRY_MS[0]! - ADMIN_WAIT_MS);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect([active.result.current, passive.result.current]).toEqual([true, true]);
});
