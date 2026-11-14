// 提示条的“改成搜索”和“也帮你找了一下”（ui/SavedNotice.tsx；B4b-3，架构 5.14 第 2、7 点）：notice.alt 不为 null 才出；
// 点“改成搜索”先撤销这一批再交给结果层；alt.found 时挂 smart-search 的 AssistPeek（排除这一批）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { BatchActs, BatchNotice } from '../hooks/useSavedBatch.ts';
import { SavedNotice } from '../ui/SavedNotice.tsx';

// 结果层、查找那一块是别的功能（ESLint boundaries）：替身只记怎么被调
const fx = vi.hoisted(() => ({ toAssist: vi.fn(), peek: vi.fn() }));
vi.mock('../hooks/assist-open.ts', () => ({ toAssist: (...a: unknown[]) => fx.toAssist(...a) }));
vi.mock('../../smart-search/index.ts', () => ({
  AssistPeek: (p: { exclude: readonly string[]; undoSaved(): Promise<void> }) => {
    fx.peek(p);
    return <span data-testid="peek-stub">{p.exclude.join(',')}</span>;
  },
}));

const ITEM: AiItem = {
  kind: 'todo', title: '找所有发票', date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
};
const ASK: AssistAsk = { intent: 'search', query: { text: '发票', range: null, kinds: ['event', 'todo', 'note'], done: 'any' } };

function notice(alt: BatchNotice['alt'], n = 1): BatchNotice {
  const entries = Array.from({ length: n }, (_v, i) => ({ ref: { table: 'todos' as const, id: `id-${i}`, title: `找所有发票${i}` }, item: ITEM }));
  return { lines: [{ key: 'plus.notice.saved', params: { title: '找所有发票' } }], entries, merge: false, alt, raw: '帮我找所有发票' };
}
function acts(undone = true): BatchActs & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    undo: vi.fn(async () => {
      order.push('undo');
      return undone;
    }),
    undoOne: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
    closeNotice: vi.fn(),
  } as unknown as BatchActs & { order: string[] };
}

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  fx.toAssist.mockReset();
  fx.peek.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('SavedNotice：模糊先按记下保存的', () => {
  it('alt 为 null：普通撤销条，没有“改成搜索”', () => {
    render(<SavedNotice notice={notice(null)} acts={acts()} />);
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下：找所有发票');
    expect(screen.queryByTestId('notice-to-search')).toBeNull();
    expect(screen.queryByTestId('peek-stub')).toBeNull();
  });

  it('alt 不为 null：一条也出展开式的块，有“改成搜索”；点了先撤销这一批，再按原话交给结果层', async () => {
    const a = acts();
    fx.toAssist.mockImplementation(() => a.order.push('toAssist'));
    render(<SavedNotice notice={notice({ ask: ASK, found: false })} acts={a} />);
    const btn = screen.getByTestId('notice-to-search');
    expect(btn.textContent).toBe('改成搜索');
    expect(screen.queryByTestId('peek-stub')).toBeNull();
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(a.order).toEqual(['undo', 'toAssist']);
    expect(fx.toAssist).toHaveBeenCalledWith({ ask: ASK, raw: '帮我找所有发票', aiUsed: 0, from: 'notice', day: null });
  });

  it('“改成搜索”时撤销没撤干净（撤了一半、没撤成）：不换成查找，留在提示条上', async () => {
    const a = acts(false);
    render(<SavedNotice notice={notice({ ask: ASK, found: false })} acts={a} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('notice-to-search'));
      await Promise.resolve();
    });
    expect(a.undo).toHaveBeenCalledTimes(1);
    expect(fx.toAssist).not.toHaveBeenCalled();
  });

  it('alt.found：挂 AssistPeek，排除这一批的 id；它的 undoSaved 就是撤销这一批', async () => {
    const a = acts();
    render(<SavedNotice notice={notice({ ask: ASK, found: true }, 2)} acts={a} />);
    expect(screen.getByTestId('notice-to-search')).toBeTruthy();
    expect(screen.getByTestId('peek-stub').textContent).toBe('id-0,id-1');
    const p = fx.peek.mock.calls[0]?.[0] as { undoSaved(): Promise<void> };
    await p.undoSaved();
    expect(a.undo).toHaveBeenCalledTimes(1);
  });
});
