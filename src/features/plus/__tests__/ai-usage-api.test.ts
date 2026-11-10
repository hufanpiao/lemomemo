// 设置 › 语音与 AI 读用量（FA-4）：结构校验、断网 / 超时 / 出错不当 0 次、用完时记本机额度
import { describe, expect, it, vi } from 'vitest';
import { readAiUsage, usageOf, type UsageDeps } from '../data/ai-usage-api.ts';

const deps = (over: Partial<UsageDeps> = {}): UsageDeps => ({
  rpc: async () => ({ data: { ai_used: 18, ai_limit: 50, pacific_date: '2026-11-09' }, error: null }),
  online: () => true,
  remember: vi.fn(async () => {}),
  now: () => 1000,
  ...over,
});

describe('usageOf', () => {
  it('合法结构', () => expect(usageOf({ ai_used: 0, ai_limit: 50 })).toEqual({ used: 0, limit: 50 }));
  it.each([null, [], 'x', { ai_used: -1, ai_limit: 50 }, { ai_used: 1.5, ai_limit: 50 }, { ai_used: '3', ai_limit: 50 }, { ai_used: 3 }])('不合法 %j → null', (v) =>
    expect(usageOf(v)).toBeNull(),
  );
});

describe('readAiUsage', () => {
  it('读到用量；没用完不记本机额度', async () => {
    const d = deps();
    expect(await readAiUsage(d)).toEqual({ ok: true, value: { used: 18, limit: 50 } });
    expect(d.remember).not.toHaveBeenCalled();
  });

  it('用完了记本机剩余 0 次', async () => {
    const d = deps({ rpc: async () => ({ data: { ai_used: 50, ai_limit: 50 }, error: null }) });
    expect(await readAiUsage(d)).toEqual({ ok: true, value: { used: 50, limit: 50 } });
    expect(d.remember).toHaveBeenCalledWith(0, 1000);
  });

  it('用完了但记本机额度出错（代码审 S4）：照样返回用量，不当“读不出来”', async () => {
    const d = deps({ rpc: async () => ({ data: { ai_used: 50, ai_limit: 50 }, error: null }), remember: vi.fn(async () => Promise.reject(new Error('db'))) });
    expect(await readAiUsage(d)).toEqual({ ok: true, value: { used: 50, limit: 50 } });
  });

  it('离线不发请求', async () => {
    const rpc = vi.fn();
    expect(await readAiUsage(deps({ online: () => false, rpc }))).toEqual({ ok: false, err: 'offline' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('服务器出错 → failed，结构不对 → failed（不当 0 次）', async () => {
    expect(await readAiUsage(deps({ rpc: async () => ({ data: null, error: { message: 'x' } }) }))).toEqual({ ok: false, err: 'failed' });
    expect(await readAiUsage(deps({ rpc: async () => ({ data: { ai_used: 'x' }, error: null }) }))).toEqual({ ok: false, err: 'failed' });
  });

  it('网络错 → offline', async () => {
    const rpc = async (): Promise<never> => {
      throw new TypeError('Failed to fetch');
    };
    expect(await readAiUsage(deps({ rpc }))).toEqual({ ok: false, err: 'offline' });
  });

  it('超时取消 → offline', async () => {
    vi.useFakeTimers();
    try {
      const rpc = (signal: AbortSignal): Promise<{ data: unknown; error: unknown }> =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve({ data: null, error: { message: 'AbortError' } })));
      const p = readAiUsage(deps({ rpc }), 50);
      await vi.advanceTimersByTimeAsync(60);
      expect(await p).toEqual({ ok: false, err: 'offline' });
    } finally {
      vi.useRealTimers();
    }
  });
});
