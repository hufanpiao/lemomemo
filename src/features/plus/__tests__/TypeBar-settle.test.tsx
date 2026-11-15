// 打字条收起的几条路（ui/TypeBar.tsx 的 settle(reason)；剩余功能推进计划 11-13 第 8 节 前端-17）：
// 收起按钮、Esc、下滑把手、点空白（没打字）、记下后自动收起、判成别的意图、查找、展开编辑、换页（App 直接卸掉）各自的
// 收键盘、草稿（留 / 清 / 不动）、onClose / onExpand、提示条还在时只收打字条、运行日志 typebar settle reason=（只记由来，不记字）。
// 草稿读写换成桩（data/type-draft.ts），只看调用；查找那一块是别的功能，替身只记 openAssist
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import { clock } from '../../../platform/clock.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type { Writer } from '../data/capture-save.ts';
import type * as Draft from '../data/type-draft.ts';
import TypeBar, { SWIPE_CLOSE_PX } from '../ui/TypeBar.tsx';
import type * as Session from '../../../platform/session.ts';

const SID = 'sid-t';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

const fx = vi.hoisted(() => ({ write: [] as Array<{ text: string; assist?: boolean }>, clear: 0, assist: [] as string[], open: vi.fn() }));
vi.mock('../data/type-draft.ts', async (orig) => ({
  ...(await orig<typeof Draft>()),
  readTypeDraft: async () => null,
  writeTypeDraft: async (d: { text: string }) => void fx.write.push({ text: d.text }),
  clearTypeDraft: async () => void (fx.clear += 1),
  writeAssistDraft: async (d: { text: string }) => void fx.assist.push(d.text),
}));
vi.mock('../../smart-search/index.ts', () => ({ loadFindOpen: async () => ({ openAssist: fx.open }), AssistPeek: () => null }));

const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };

const lines: string[] = [];
const slots = globalThis as unknown as Record<string, unknown>;

function ui(o: { n?: number; onClose?: () => void; onExpand?: (t: string, d: string | null) => void; day?: string | null } = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
  return <TypeBar day={o.day ?? null} writer={writer} online={() => true} opened={o.n ?? 1} onExpand={o.onExpand ?? vi.fn()} onClose={o.onClose ?? vi.fn()} />;
}

const input = (): HTMLInputElement => screen.getByTestId('type-input') as HTMLInputElement;
const type = (v: string): void => void fireEvent.change(input(), { target: { value: v } });
const settles = (): string[] => lines.filter((l) => l.startsWith('typebar settle'));

/** 各条路怎么触发 */
const HOW = {
  button: () => fireEvent.click(screen.getByRole('button', { name: '收起' })),
  esc: () => fireEvent.keyDown(input(), { key: 'Escape' }),
  swipe: () => {
    const grip = screen.getByTestId('type-bar').firstElementChild as HTMLElement;
    fireEvent.pointerDown(grip, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientY: 100 + SWIPE_CLOSE_PX, pointerId: 1 });
  },
} as const;

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  fx.write = [];
  fx.clear = 0;
  fx.assist = [];
  fx.open.mockReset();
  lines.length = 0;
  slots[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete slots[RL_SLOT];
});

describe('打字条收起：收起按钮、Esc、下滑（留草稿再关）', () => {
  for (const reason of ['button', 'esc', 'swipe'] as const) {
    it(`${reason}：收键盘、已打的字留草稿、再 onClose；日志只记由来`, async () => {
      const onClose = vi.fn();
      render(ui({ onClose }));
      type('买牛奶');
      expect(document.activeElement).toBe(input());
      const el = input();
      await act(async () => HOW[reason]());
      expect(document.activeElement).not.toBe(el);
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(fx.write).toEqual([{ text: '买牛奶' }]);
      expect(fx.clear).toBe(0);
      expect(settles()).toEqual([`typebar settle reason=${reason} fold=0`]);
      expect(lines.join(' ')).not.toContain('牛奶');
    });
  }

  it('下滑不到 SWIPE_CLOSE_PX 不收起', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    const grip = screen.getByTestId('type-bar').firstElementChild as HTMLElement;
    fireEvent.pointerDown(grip, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientY: 100 + SWIPE_CLOSE_PX - 1, pointerId: 1 });
    await act(async () => undefined);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('type-bar')).toBeTruthy();
  });
});

describe('打字条收起：点空白', () => {
  it('没打字：等同收起（留草稿再关），日志 reason=blank', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    await act(async () => fireEvent.click(screen.getByTestId('type-mist')));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.write).toEqual([{ text: '' }]);
    expect(settles()).toEqual(['typebar settle reason=blank fold=0']);
  });

  it('打了字：只收键盘，不算收起（不写草稿、不 onClose、不记 settle）', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    type('买菜');
    await act(async () => fireEvent.click(screen.getByTestId('type-mist')));
    expect(document.activeElement).not.toBe(input());
    expect(onClose).not.toHaveBeenCalled();
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual([]);
  });
});

describe('打字条收起：展开编辑', () => {
  it('清草稿、把字和日子交给 onExpand；不调 onClose、不留草稿', async () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    render(ui({ onExpand, onClose, day: '2026-11-20' }));
    type('开会');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '展开编辑' })));
    expect(onExpand).toHaveBeenCalledWith('开会', '2026-11-20');
    expect(fx.clear).toBe(1);
    expect(fx.write).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(settles()).toEqual(['typebar settle reason=expand fold=0']);
  });

  it('展开以后 App 把打字条卸掉：不再按“换页”留草稿', async () => {
    const r = render(ui({ onExpand: vi.fn() }));
    type('开会');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '展开编辑' })));
    r.unmount();
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=expand fold=0']);
  });
});

describe('打字条收起：判成查找、交给结果层', () => {
  it('查找：原话进草稿（toAssist 写的 assist 草稿），收键盘、onClose；打字条自己不再写草稿', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    type('帮我找牙医的记录');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
      await Promise.resolve();
    });
    await waitFor(() => expect(fx.open).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fx.assist).toEqual(['帮我找牙医的记录']);
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=find fold=0']);
  });

  it('总结（planText 判成别的意图，onAsked）：同上，日志 reason=asked', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    type('总结一下这周的随手记');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
      await Promise.resolve();
    });
    await waitFor(() => expect(fx.open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.assist).toEqual(['总结一下这周的随手记']);
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=asked fold=0']);
  });
});

describe('打字条收起：记下后自动收起、提示条还在时只收打字条', () => {
  const saveOne = async (): Promise<void> => {
    type('明天下午3点去银行办理业务');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
  };

  it('记下后自动收起：只收打字条（fold=1），提示条满 8 秒才真正 onClose（reason=saved，那时字已清空）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const onClose = vi.fn();
      render(ui({ onClose }));
      await saveOne();
      expect(screen.queryByTestId('type-bar')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS));
      await act(async () => vi.advanceTimersByTime(0));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(fx.write.at(-1)).toEqual({ text: '' });
      expect(settles()).toEqual(['typebar settle reason=saved fold=1', 'typebar settle reason=saved fold=end']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('提示条在时 Esc（打了字）：只收打字条，字留在状态里；提示条没了才留草稿、onClose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const onClose = vi.fn();
      const r = render(ui({ onClose, n: 1 }));
      await saveOne();
      act(() => r.rerender(ui({ onClose, n: 2 })));
      type('买菜');
      await act(async () => HOW.esc());
      expect(screen.queryByTestId('type-bar')).toBeNull();
      const before = fx.write.length;
      await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS));
      await act(async () => vi.advanceTimersByTime(0));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(fx.write.slice(before)).toEqual([{ text: '买菜' }]);
      expect(settles().slice(-2)).toEqual(['typebar settle reason=esc fold=1', 'typebar settle reason=esc fold=end']);
    } finally {
      vi.useRealTimers();
    }
  });

  // 修正（前端-17）：原来提示条没了以后一律按“收起”留草稿，判成查找的那一句此时字已清空，写空草稿 = 删掉 toAssist 刚写的 assist 草稿
  it('提示条在时判成查找：只收打字条；提示条没了 onClose，不再写草稿（toAssist 写的原话草稿不被删）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const onClose = vi.fn();
      const r = render(ui({ onClose, n: 1 }));
      await saveOne();
      act(() => r.rerender(ui({ onClose, n: 2 })));
      const before = fx.write.length;
      type('帮我找牙医的记录');
      await act(async () => {
        fireEvent.submit(screen.getByTestId('type-bar'));
        await Promise.resolve();
      });
      expect(screen.queryByTestId('type-bar')).toBeNull();
      expect(fx.assist).toEqual(['帮我找牙医的记录']);
      await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS));
      await act(async () => vi.advanceTimersByTime(0));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(fx.write.slice(before)).toEqual([]);
      expect(settles().slice(-2)).toEqual(['typebar settle reason=find fold=1', 'typebar settle reason=find fold=end']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('打字条收起：换页（App 直接卸掉打字条）', () => {
  // 修正（前端-17）：原来换页卸掉时什么都不做，打了没记下的字直接丢；改成和“收起”一样留草稿
  it('打了字：卸掉时留草稿，日志 reason=route；不调 onClose（App 已经关了）', () => {
    const onClose = vi.fn();
    const r = render(ui({ onClose }));
    type('买牛奶');
    r.unmount();
    expect(fx.write).toEqual([{ text: '买牛奶' }]);
    expect(onClose).not.toHaveBeenCalled();
    expect(settles()).toEqual(['typebar settle reason=route fold=0']);
  });

  it('没打字：卸掉时不写草稿（不删已有草稿；StrictMode 挂上又卸的那一下也走这里）', () => {
    const r = render(ui());
    r.unmount();
    expect(fx.write).toEqual([]);
  });

  it('已经收起并 onClose 过的：App 再卸掉不重复留草稿', async () => {
    const onClose = vi.fn();
    const r = render(ui({ onClose }));
    type('买');
    await act(async () => HOW.button());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    r.unmount();
    expect(fx.write).toEqual([{ text: '买' }]);
    expect(settles()).toEqual(['typebar settle reason=button fold=0']);
  });
});
