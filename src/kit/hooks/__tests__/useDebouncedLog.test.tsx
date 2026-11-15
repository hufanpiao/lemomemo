// 停下来才记一行运行日志（kit/hooks/useDebouncedLog.ts；查找面板 find kw、下拉搜索 pull find 共用）：
// 连着变只记最后一次；只有 line 变（数据重算）不推迟；line 为 null 不记；没到点就卸载时补记
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedLog } from '../useDebouncedLog.ts';

const fx = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));

const MS = 400;
function Host({ q, line }: { q: string; line: string | null }) {
  useDebouncedLog(q, line, MS);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fx.logs.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDebouncedLog', () => {
  it('trigger 连着变只记停下来那一次；只有 line 变不推迟，记的是最新的 line', () => {
    const { rerender } = render(<Host q="a" line="n=1" />);
    act(() => void vi.advanceTimersByTime(MS / 2));
    rerender(<Host q="ab" line="n=2" />);
    act(() => void vi.advanceTimersByTime(MS / 2));
    expect(fx.logs).toEqual([]);
    rerender(<Host q="ab" line="n=3" />);
    act(() => void vi.advanceTimersByTime(MS / 2));
    expect(fx.logs).toEqual(['n=3']);
  });

  it('line 为 null 不记', () => {
    render(<Host q="" line={null} />);
    act(() => void vi.advanceTimersByTime(MS * 2));
    expect(fx.logs).toEqual([]);
  });

  it('没到点就卸载：卸载时补记；到点记过的不再补', () => {
    const { unmount } = render(<Host q="a" line="n=1" />);
    unmount();
    expect(fx.logs).toEqual(['n=1']);
    const r = render(<Host q="b" line="n=2" />);
    act(() => void vi.advanceTimersByTime(MS));
    r.unmount();
    expect(fx.logs).toEqual(['n=1', 'n=2']);
  });
});
