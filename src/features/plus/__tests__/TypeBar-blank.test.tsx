// 打字条点页面空白处（Q-10 / R-390，ui/TypeBar.tsx；从 TypeBar.test.tsx 拆出来，11-11）：没打字收起、记下后自动收起只留提示条（R-392）、打了字或确认行只收键盘
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { Writer } from '../data/capture-save.ts';
import TypeBar, { isBlankTap, LIFT_GAP_PX, TAP_SLOP_PX } from '../ui/TypeBar.tsx';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import type * as Session from '../../../platform/session.ts';

// S1：会话 id 固定一个非空值（consentStale 读到空 id 一律当没记过）
const SID = 'sid-t';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

// 取 UTC 中午：首尔 21:00、洛杉矶 04:00 都还是 11-02（test:tz 三个时区各跑一遍，“明天”都是 11-03）
const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };

function setup(over: { day?: string | null; insert?: Writer['insert']; online?: boolean } = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(over.insert ?? (async () => OK)), patch: vi.fn<Writer['patch']>(async () => OK) };
  const onExpand = vi.fn();
  const onClose = vi.fn();
  render(<TypeBar day={over.day ?? null} writer={writer} online={() => over.online ?? true} onExpand={onExpand} onClose={onClose} />);
  return { writer, onExpand, onClose, input: screen.getByTestId('type-input') };
}

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('点页面空白处（Q-10 / R-390）', () => {
  /** 页面上的一块空白和一个控件（底栏、普通按钮） */
  const page = () => {
    const blank = document.createElement('div');
    blank.dataset['testid'] = 'blank';
    const nav = document.createElement('nav');
    nav.dataset['testid'] = 'tabbar';
    const tab = document.createElement('span');
    nav.append(tab);
    const btn = document.createElement('button');
    document.body.append(blank, nav, btn);
    return { blank, tab, btn };
  };
  const tap = (el: Element, dx = 0) => {
    fireEvent.pointerDown(el, { clientX: 100, clientY: 100, isPrimary: true });
    fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 100, isPrimary: true });
  };
  afterEach(() => document.body.replaceChildren());

  it('没打字：点空白就收起（等同点“收起”）', async () => {
    const { onClose } = setup();
    const { blank } = page();
    await act(async () => tap(blank));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('只打了空格（去掉空白后为空）：也收起', async () => {
    const { onClose, input } = setup();
    fireEvent.change(input, { target: { value: '   　 ' } });
    const { blank } = page();
    await act(async () => tap(blank));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('打了字：点空白只收键盘（输入框失焦），打字条和字都留着', async () => {
    const { onClose, input } = setup();
    fireEvent.change(input, { target: { value: '明天买菜' } });
    expect(document.activeElement).toBe(input);
    const { blank } = page();
    await act(async () => tap(blank));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByTestId('type-bar')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('明天买菜');
  });

  /** 打一句、回车记下（出“已记下 · 撤销”提示条） */
  const saveOne = async (input: HTMLElement) => {
    fireEvent.change(input, { target: { value: '明天下午3点去银行办理业务' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
  };

  it('记下后打字条自动收起、键盘收掉，只留提示条（R-392）；点提示条不算空白；撤销可用，撤销后才真正关掉', async () => {
    const { onClose, input, writer } = setup();
    await saveOne(input);
    expect(screen.queryByTestId('type-bar')).toBeNull();
    expect(screen.queryByTestId('type-input')).toBeNull();
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下：去银行办理业务');
    await act(async () => tap(screen.getByTestId('type-notice')));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    });
    expect(writer.patch).toHaveBeenCalledWith('events', expect.any(String), { undone: true, updated_at: NOW });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('记下后再点“＋”打字条开着时提示条外壳记着打字条高 + LIFT_GAP_PX（--type-lift）、打字条变高跟着变；点空白收起后清掉（负责人 11-11“挪到打字条上方”）', async () => {
    let h = 146;
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset['testid'] === 'type-bar' ? ({ height: h, top: 0, bottom: h, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : real.call(this);
    });
    const seen: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) {
        seen.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    });
    try {
      const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
      const ui = (n: number) => <TypeBar day={null} writer={writer} online={() => true} opened={n} onExpand={vi.fn()} onClose={vi.fn()} />;
      const r = render(ui(1));
      await saveOne(screen.getByTestId('type-input'));
      expect(screen.queryByTestId('type-bar')).toBeNull();
      r.rerender(ui(2));
      const box = screen.getByTestId('type-notice').parentElement as HTMLElement;
      expect(box.style.getPropertyValue('--type-lift')).toBe(`${146 + LIFT_GAP_PX}px`);
      h = 200;
      act(() => seen.at(-1)?.());
      expect(box.style.getPropertyValue('--type-lift')).toBe(`${200 + LIFT_GAP_PX}px`);
      const { blank } = page();
      await act(async () => tap(blank));
      expect(screen.queryByTestId('type-bar')).toBeNull();
      expect(box.style.getPropertyValue('--type-lift')).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('记下自动收起后提示条照常显示满 8 秒（UNDO_TOAST_MS），到时才关；没到时再点“＋”（opened 变了）打字条重新出来并聚焦', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
      const onClose = vi.fn();
      const ui = (n: number) => <TypeBar day={null} writer={writer} online={() => true} opened={n} onExpand={vi.fn()} onClose={onClose} />;
      const r = render(ui(1));
      await saveOne(screen.getByTestId('type-input'));
      const { blank } = page();
      expect(screen.queryByTestId('type-bar')).toBeNull();
      await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS - 100));
      expect(screen.getByTestId('type-notice')).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      // 同一次渲染里就展开并聚焦（不隔宏任务；iOS 只在手势里 focus 才弹键盘）
      act(() => r.rerender(ui(2)));
      expect(document.activeElement).toBe(screen.getByTestId('type-input'));
      await act(async () => tap(blank));
      expect(screen.queryByTestId('type-bar')).toBeNull();
      await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS));
      expect(screen.queryByTestId('type-notice')).toBeNull();
      await act(async () => vi.advanceTimersByTime(0));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('确认行（补记 / 记到）开着时点空白：只收键盘，打字条和原话都留着（手上还有没落定的内容）', async () => {
    const { onClose, input } = setup();
    fireEvent.change(input, { target: { value: '10月30号下午两点和客户开会' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    const { blank } = page();
    await act(async () => tap(blank));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('type-bar')).toBeTruthy();
    expect(screen.getByRole('button', { name: '明年（2027/10/30）' })).toBeTruthy();
  });

  it('点在底栏、按钮、打字条自己身上不算空白；拖动（挪了 TAP_SLOP_PX 以上）不算点', async () => {
    const { onClose } = setup();
    const { blank, tab, btn } = page();
    await act(async () => {
      tap(tab);
      tap(btn);
      tap(screen.getByTestId('type-bar'));
      tap(blank, TAP_SLOP_PX);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('isBlankTap：空白算；控件、打字条里、不是元素不算', () => {
    const { blank, tab, btn } = page();
    const bar = document.createElement('form');
    const inside = document.createElement('div');
    bar.append(inside);
    document.body.append(bar);
    expect(isBlankTap(blank, bar)).toBe(true);
    expect(isBlankTap(tab, bar)).toBe(false);
    expect(isBlankTap(btn, bar)).toBe(false);
    expect(isBlankTap(inside, bar)).toBe(false);
    expect(isBlankTap(null, bar)).toBe(false);
  });
});
