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

  it('打字后不到 400 ms 就关面板：关键词那一行照样补记（不记查询文字）', () => {
    seed(false);
    const { unmount } = render(<FindPanel query="" from="ctrlk" onClose={vi.fn()} />);
    typeQ('牙医');
    unmount();
    const log = fx.logs.join('\n');
    expect(log).toMatch(/find kw len=2 n=1 ms=\d+/);
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
    const [first] = screen.getAllByTestId('find-row');
    if (!first) throw new Error('没有结果行');
    fireEvent.click(first);
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

// 第三方审查前端第 2 条（11-14）：电脑上 Tab 交还浏览器（键盘能走到结果行、“⋯”、类型胶囊、底部按钮），切类型改成 Ctrl / ⌘ + ←→；
// 读屏：输入框 combobox，aria-controls 指向结果 listbox，aria-activedescendant 指向当前选中的 option
describe('查找面板：电脑键盘和读屏', () => {
  /** 电脑宽度（MQ_SIDEBAR 成立） */
  const stubDesk = () =>
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('width >= 900px'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
  afterEach(() => vi.unstubAllGlobals());
  const kindOn = () => screen.getAllByRole('button', { pressed: true }).map((b) => b.getAttribute('data-testid'));

  it('Tab 不拦（不切类型）；Ctrl + → / ⌘ + → 切到下一类，Ctrl + ← 切回上一类；不按修饰键的 ←→ 不切', () => {
    stubDesk();
    seed(false);
    render(<FindPanel query="牙" from="ctrlk" onClose={vi.fn()} />);
    const input = screen.getByTestId('find-input');
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(kindOn()).toEqual(['find-kind-all']);
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(kindOn()).toEqual(['find-kind-all']);
    expect(fireEvent.keyDown(input, { key: 'ArrowRight', ctrlKey: true })).toBe(false);
    expect(kindOn()).toEqual(['find-kind-event']);
    fireEvent.keyDown(input, { key: 'ArrowRight', metaKey: true });
    expect(kindOn()).toEqual(['find-kind-todo']);
    fireEvent.keyDown(input, { key: 'ArrowLeft', ctrlKey: true });
    expect(kindOn()).toEqual(['find-kind-event']);
    fireEvent.keyDown(input, { key: 'ArrowLeft', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'ArrowLeft', ctrlKey: true });
    expect(kindOn()).toEqual(['find-kind-todo']);
    // 键位提示跟着改
    expect(screen.getByText('↑↓ 选择 · Enter 打开 · Ctrl / ⌘ + ←→ 切换类型 · Esc 关闭')).toBeTruthy();
  });

  it('输入框 role=combobox、aria-controls 指向 listbox；每条结果 role=option；aria-activedescendant 跟着 ↑↓ 走', () => {
    stubDesk();
    seed(false);
    render(<FindPanel query="牙" from="ctrlk" onClose={vi.fn()} />);
    const input = screen.getByRole('combobox');
    expect(input).toBe(screen.getByTestId('find-input'));
    const boxes = (input.getAttribute('aria-controls') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id));
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b?.getAttribute('role')).toBe('listbox');
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(screen.getAllByTestId('find-row').length);
    for (const o of opts) expect(boxes.some((b) => b?.contains(o))).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0]?.id);
    expect(opts[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[1]?.id);
    expect(opts[1]?.getAttribute('aria-selected')).toBe('true');
    expect(opts[0]?.getAttribute('aria-selected')).toBe('false');
  });
});
