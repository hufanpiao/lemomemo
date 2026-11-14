// 查找面板（B4b-2；ui/FindPanel.tsx、hooks/useFind.ts；线框 s12、sFind）：关键词先出、意思相近随后补上、只按关键词的原因、无结果、打开一条、运行日志
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collection } from '../../../core/store.ts';
import { setConsentStale } from '../../../kit/state/consent-fresh.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type * as Session from '../../../platform/session.ts';
import FindPanel from '../ui/FindPanel.tsx';

const SID = 'sid-f';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));
const fx = vi.hoisted(() => ({
  search: vi.fn(),
  nav: vi.fn(),
  logs: [] as string[],
}));
vi.mock('../data/note-search-api.ts', () => ({ noteSearch: (...a: unknown[]) => fx.search(...a) }));
vi.mock('../../../app/router.ts', async (orig) => ({ ...(await orig<object>()), navigate: (...a: unknown[]) => fx.nav(...a) }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));

const NOW = Date.UTC(2026, 10, 14, 3);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const live = { deleted_at: null, undone: false, updated_at: NOW };
type R = { id: string } & Record<string, unknown>;
const put = (name: string, rows: R[]) => collection<R>(name).upsert(rows);

function seed(ai = true) {
  put('events', [{ id: id(1), ...live, title: '看牙医', location: '江南站', note: '', date: '2026-11-10', time: '15:00' }]);
  put('todos', [{ id: id(2), ...live, title: '预约洗牙', note: '', project: '', due: null, done: false }]);
  put('notes', [{ id: id(3), ...live, title: '牙医', body: '隐私', is_private: true, created_at: NOW }]);
  put('settings', [{ id: 'set-ai', key: 'ai.enabled', value: ai, deleted_at: null, updated_at: NOW }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  setConsentStale(false, SID);
  fx.search.mockReset();
  fx.nav.mockReset();
  fx.logs.length = 0;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});
afterEach(() => {
  cleanup();
  for (const c of ['events', 'todos', 'notes', 'settings']) collection(c).clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const typeQ = (v: string) => fireEvent.change(screen.getByTestId('find-input'), { target: { value: v } });

describe('查找面板', () => {
  it('关键词当场出；停 400 ms 后按意思找，补上来单独一组；隐私记不出；日志只记数不记字', async () => {
    seed();
    fx.search.mockResolvedValue({ ok: true, hits: [{ kind: 'todo', id: id(2), score: 0.8 }, { kind: 'note', id: id(3), score: 0.9 }] });
    render(<FindPanel query="" from="ctrlk" onClose={vi.fn()} />);
    typeQ('牙医');
    expect(screen.getAllByTestId('find-row').map((r) => r.getAttribute('data-kind'))).toEqual(['event']);
    expect(screen.getByTestId('find-group-sem').textContent).toContain('意思相近');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fx.search).toHaveBeenCalledTimes(1);
    expect(fx.search.mock.calls[0]?.[0]).toBe('牙医');
    expect(screen.getAllByTestId('find-row').map((r) => r.getAttribute('data-kind'))).toEqual(['event', 'todo']);
    const log = fx.logs.join('\n');
    expect(log).toMatch(/find open from=ctrlk len=0/);
    expect(log).toMatch(/find kw len=2 n=1 ms=\d+/);
    expect(log).toMatch(/find sem n=2 ms=\d+/);
    expect(log).toMatch(/find sem add=1 top=0/);
    expect(log).not.toContain('牙医');
  });

  it('AI 关着：只按关键词，顶上写原因、给“去打开”；不调服务器', () => {
    seed(false);
    render(<FindPanel query="牙医" from="plus" onClose={vi.fn()} />);
    const fb = screen.getByTestId('find-fallback');
    expect(fb.getAttribute('data-reason')).toBe('consent');
    expect(fb.textContent).toContain('现在只按关键词找');
    expect(fx.search).not.toHaveBeenCalled();
    expect(fx.logs.join('\n')).toContain('find fallback reason=consent code=local');
  });

  it('离线：原因 offline；服务器超时：给“再试一次”，点了重新找', async () => {
    seed();
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    render(<FindPanel query="牙医" from="plus" onClose={vi.fn()} />);
    expect(screen.getByTestId('find-fallback').getAttribute('data-reason')).toBe('offline');
    cleanup();
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    fx.search.mockResolvedValue({ ok: false, reason: 'timeout', code: 'timeout' });
    render(<FindPanel query="牙医" from="plus" onClose={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByTestId('find-fallback').getAttribute('data-reason')).toBe('timeout');
    fireEvent.click(screen.getByTestId('find-retry'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fx.search).toHaveBeenCalledTimes(2);
  });

  it('没有结果：写“没找到”；打开一条：去它的编辑页、关面板、记进最近找过', async () => {
    seed();
    fx.search.mockResolvedValue({ ok: true, hits: [] });
    const onClose = vi.fn();
    render(<FindPanel query="不存在的词" from="plus" onClose={onClose} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByTestId('find-empty').textContent).toContain('不存在的词');
    typeQ('牙医');
    fireEvent.click(screen.getAllByTestId('find-row')[0]!);
    expect(fx.nav).toHaveBeenCalledWith('event', id(1));
    expect(onClose).toHaveBeenCalled();
    expect(fx.logs.join('\n')).toContain('find pick kind=event');
  });

  it('类型胶囊只出有结果的类型，点了只看这一类', () => {
    seed(false);
    render(<FindPanel query="牙" from="plus" onClose={vi.fn()} />);
    expect(screen.getByTestId('find-kind-event')).toBeTruthy();
    expect(screen.getByTestId('find-kind-todo')).toBeTruthy();
    expect(screen.queryByTestId('find-kind-note')).toBeNull();
    fireEvent.click(screen.getByTestId('find-kind-todo'));
    expect(screen.getAllByTestId('find-row').map((r) => r.getAttribute('data-kind'))).toEqual(['todo']);
  });
});
