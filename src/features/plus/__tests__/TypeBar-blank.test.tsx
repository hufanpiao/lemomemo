// 打字条点页面空白处（Q-10 / R-390，ui/TypeBar.tsx；从 TypeBar.test.tsx 拆出来，11-11）：没打字收起、记下后自动收起只留提示条（R-392）、打了字或确认行只收键盘。
// 11-12 起页面整个盖在打字条后面那层液态玻璃（type-mist，R-399）下面，“点空白”就是点这一层（它自己的 click）；点穿不点穿、各层谁在上面在 e2e r399-mist.spec.ts 里用真浏览器测
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type { Writer } from '../data/capture-save.ts';
import TypeBar, { LIFT_GAP_PX } from '../ui/TypeBar.tsx';
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
  /** 点一下打字条后面那层液态玻璃（= 点页面空白处） */
  const tapMist = (): void => {
    fireEvent.click(screen.getByTestId('type-mist'));
  };

  it('没打字：点空白就收起（等同点“收起”）', async () => {
    const { onClose } = setup();
    await act(async () => tapMist());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('只打了空格（去掉空白后为空）：也收起', async () => {
    const { onClose, input } = setup();
    fireEvent.change(input, { target: { value: '   　 ' } });
    await act(async () => tapMist());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('打了字：点空白只收键盘（输入框失焦），打字条和字都留着', async () => {
    const { onClose, input } = setup();
    fireEvent.change(input, { target: { value: '明天买菜' } });
    expect(document.activeElement).toBe(input);
    await act(async () => tapMist());
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

  it('记下后打字条自动收起、键盘收掉，只留提示条（R-392）；点提示条不收起；撤销可用，撤销后才真正关掉', async () => {
    const { onClose, input, writer } = setup();
    await saveOne(input);
    expect(screen.queryByTestId('type-bar')).toBeNull();
    expect(screen.queryByTestId('type-input')).toBeNull();
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下：去银行办理业务');
    await act(async () => fireEvent.click(screen.getByTestId('type-notice')));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    });
    expect(writer.patch).toHaveBeenCalledWith('events', expect.any(String), { deleted_at: NOW, undone: true, updated_at: NOW });
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
        await act(async () => tapMist());
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
        expect(screen.queryByTestId('type-bar')).toBeNull();
      await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS - 100));
      expect(screen.getByTestId('type-notice')).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      // 同一次渲染里就展开并聚焦（不隔宏任务；iOS 只在手势里 focus 才弹键盘）
      act(() => r.rerender(ui(2)));
      expect(document.activeElement).toBe(screen.getByTestId('type-input'));
      await act(async () => tapMist());
      expect(screen.queryByTestId('type-bar')).toBeNull();
      await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS));
      expect(screen.queryByTestId('type-notice')).toBeNull();
      await act(async () => vi.advanceTimersByTime(0));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const how of ['收起按钮', 'Esc'] as const) {
    it(`记下后再点“＋”、提示条还在时按${how}：只收打字条，提示条留着、还能撤销，到 8 秒才真正关（负责人 11-12 选“统一成留着提示条”）`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
        const onClose = vi.fn();
        const ui = (n: number) => <TypeBar day={null} writer={writer} online={() => true} opened={n} onExpand={vi.fn()} onClose={onClose} />;
        const r = render(ui(1));
        await saveOne(screen.getByTestId('type-input'));
        act(() => r.rerender(ui(2)));
        expect(screen.getByTestId('type-bar')).toBeTruthy();
        await act(async () => {
          if (how === 'Esc') fireEvent.keyDown(screen.getByTestId('type-input'), { key: 'Escape' });
          else fireEvent.click(screen.getByRole('button', { name: '收起' }));
        });
        expect(screen.queryByTestId('type-bar')).toBeNull();
        expect(screen.queryByTestId('type-mist')).toBeNull();
        expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS));
        await act(async () => vi.advanceTimersByTime(0));
        expect(screen.queryByTestId('type-notice')).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('确认行（补记 / 记到）开着时点空白：只收键盘，打字条和原话都留着（手上还有没落定的内容）', async () => {
    const { onClose, input } = setup();
    fireEvent.change(input, { target: { value: '10月30号下午两点和客户开会' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    await act(async () => tapMist());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('type-bar')).toBeTruthy();
    expect(screen.getByRole('button', { name: '明年（2027/10/30）' })).toBeTruthy();
  });

  it('每次点空白记一行运行日志 typebar blank：没打字 act=close，打了字 act=blur，只记字数不记字', async () => {
    const slots = globalThis as unknown as Record<string, unknown>;
    const lines: string[] = [];
    slots[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
    try {
      const { input } = setup();
      fireEvent.change(input, { target: { value: '明天买菜' } });
      await act(async () => tapMist());
      fireEvent.change(input, { target: { value: '  ' } });
      await act(async () => tapMist());
      const blank = lines.filter((l) => l.startsWith('typebar blank'));
      expect(blank).toEqual(['typebar blank act=blur len=4 asking=0 status=idle', 'typebar blank act=close len=0 asking=0 status=idle']);
      expect(lines.join(' ')).not.toContain('买菜');
    } finally {
      delete slots[RL_SLOT];
    }
  });

  it('点打字条自己身上（不是后面那层）不收起', async () => {
    const { onClose } = setup();
    await act(async () => fireEvent.click(screen.getByTestId('type-bar')));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('type-mist')).toBeTruthy();
  });
});
