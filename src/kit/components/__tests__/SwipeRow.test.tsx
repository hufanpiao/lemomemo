// SwipeRow：左滑露出操作的列表行（kit）。jsdom 量不出宽度：操作区宽度用 offsetWidth 桩成 144；
// 真浏览器里的手势（含竖着滚列表不误触发）由 tests/e2e/b5-anniv.spec.ts、r420-swipe-taps.spec.ts 在 chromium、webkit 上跑
// 手指、鼠标补来的 click 带 detail: 1（真浏览器的样子）；键盘的 click 前面有 keydown，滑完不吞它（R-420 审查第 12 条）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeRow } from '../SwipeRow.tsx';

afterEach(cleanup);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(144);
  // jsdom 没有指针捕获
  HTMLElement.prototype.setPointerCapture = () => undefined;
});

const noLog = (): void => undefined;

function row(id: string, onEdit = vi.fn(), onDel = vi.fn(), onOpen = vi.fn(), log: (line: string) => void = noLog) {
  return (
    <SwipeRow
      data-testid={id}
      log={log}
      actions={[
        { key: 'edit', label: '编辑', onClick: onEdit, testId: `${id}-edit` },
        { key: 'del', label: '删除', danger: true, onClick: onDel, testId: `${id}-del` },
      ]}
    >
      <button type="button" onClick={onOpen} data-testid={`${id}-main`}>
        行
      </button>
    </SwipeRow>
  );
}

const face = (id: string): HTMLElement => screen.getByTestId(`${id}-main`).parentElement as HTMLElement;

function swipe(el: HTMLElement, dx: number, dy = 0, { x0 = 200, type = 'touch' }: { x0?: number; type?: string } = {}): void {
  fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true, clientX: x0, clientY: 20, button: 0, pointerType: type });
  fireEvent.pointerMove(el, { pointerId: 1, isPrimary: true, clientX: x0 + dx / 2, clientY: 20 + dy / 2, pointerType: type });
  fireEvent.pointerMove(el, { pointerId: 1, isPrimary: true, clientX: x0 + dx, clientY: 20 + dy, pointerType: type });
  fireEvent.pointerUp(el, { pointerId: 1, isPrimary: true, clientX: x0 + dx, clientY: 20 + dy, pointerType: type });
}

/** 一次手指的点按：按下、松开（没动），再来浏览器补的 click（detail 1） */
const tap = (el: HTMLElement): void => {
  fireEvent.pointerDown(el, { pointerId: 2, isPrimary: true, clientX: 150, clientY: 20, button: 0, pointerType: 'touch' });
  fireEvent.pointerUp(el, { pointerId: 2, isPrimary: true, clientX: 150, clientY: 20, button: 0, pointerType: 'touch' });
  fireEvent.click(el, { detail: 1 });
};

describe('SwipeRow', () => {
  it('收着时操作按钮 inert、读屏读不到；左滑过一半停在露出，按钮可点', () => {
    const onDel = vi.fn();
    render(row('a', vi.fn(), onDel));
    const acts = screen.getByTestId('a-del').parentElement as HTMLElement;
    expect(acts.hasAttribute('inert')).toBe(true);
    expect(acts.getAttribute('aria-hidden')).toBe('true');
    swipe(face('a'), -100);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBe('open');
    expect(face('a').style.transform).toBe('translateX(-144px)');
    expect(acts.hasAttribute('inert')).toBe(false);
    fireEvent.click(screen.getByTestId('a-del'), { detail: 1 });
    expect(onDel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
  });

  it('没拉过一半收回；滑完紧跟的 click 吞掉、不进编辑', () => {
    const onOpen = vi.fn();
    render(row('a', vi.fn(), vi.fn(), onOpen));
    swipe(face('a'), -40);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(face('a').style.transform).toBe('');
    fireEvent.click(screen.getByTestId('a-main'), { detail: 1 });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('竖着走得多（滚列表）：不滑、不吞点击', () => {
    const onOpen = vi.fn();
    render(row('a', vi.fn(), vi.fn(), onOpen));
    swipe(face('a'), -30, 80);
    expect(face('a').style.transform).toBe('');
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    fireEvent.click(screen.getByTestId('a-main'), { detail: 1 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('一次只露一行；点别处、按 Esc 收起；点露着那行的行面只收起、不进编辑', () => {
    const onOpen = vi.fn();
    render(
      <>
        {row('a', vi.fn(), vi.fn(), onOpen)}
        {row('b')}
      </>,
    );
    swipe(face('a'), -100);
    swipe(face('b'), -100);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(screen.getByTestId('b').getAttribute('data-swipe')).toBe('open');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.getByTestId('b').getAttribute('data-swipe')).toBeNull();
    swipe(face('a'), -100);
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    swipe(face('a'), -100);
    tap(screen.getByTestId('a-main'));
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('disabled（只读行）：滑不动', () => {
    render(
      <SwipeRow data-testid="r" disabled log={noLog} actions={[{ key: 'x', label: 'x', onClick: vi.fn() }]}>
        <span data-testid="r-main">行</span>
      </SwipeRow>,
    );
    swipe(face('r'), -100);
    expect(screen.getByTestId('r').getAttribute('data-swipe')).toBeNull();
  });

  it('左边缘 20 px 以内起手不起滑（让给 iPhone 侧滑返回，和月历翻页同一条）', () => {
    render(row('a'));
    swipe(face('a'), -100, 0, { x0: 10 });
    expect(face('a').style.transform).toBe('');
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
  });

  it('起滑距离和月历翻页同一个值：横着只走了 9 px 不起滑、不跟手', () => {
    render(row('a'));
    const el = face('a');
    fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 20, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(el, { pointerId: 1, isPrimary: true, clientX: 191, clientY: 20, pointerType: 'touch' });
    expect(el.style.transform).toBe('');
  });

  it('电脑上鼠标也能拖开（列表行认鼠标）', () => {
    render(row('a'));
    swipe(face('a'), -100, 0, { type: 'mouse' });
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBe('open');
  });

  it('露着时可以直接拖回去（照 iOS）：往右拖一点没过一半还露着，拖过一半收起', () => {
    render(row('a'));
    swipe(face('a'), -100);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBe('open');
    swipe(face('a'), 30);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBe('open');
    expect(face('a').style.transform).toBe('translateX(-144px)');
    swipe(face('a'), 100);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
  });

  it('一行露着时点另一行：第一下只收起露着的那行，点到的那行不打开（吞掉这一下）；再点一下才打开', () => {
    const onOpenB = vi.fn();
    render(
      <>
        {row('a')}
        {row('b', vi.fn(), vi.fn(), onOpenB)}
      </>,
    );
    swipe(face('a'), -100);
    tap(screen.getByTestId('b-main'));
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(onOpenB).not.toHaveBeenCalled();
    tap(screen.getByTestId('b-main'));
    expect(onOpenB).toHaveBeenCalledTimes(1);
  });

  it('滑开后焦点在操作按钮上按 Esc：收起，焦点交还给行面的主按钮（不掉回 body）', () => {
    render(row('a'));
    swipe(face('a'), -100);
    screen.getByTestId('a-edit').focus();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('a-main'));
  });

  it('滑完马上在行面按回车（键盘的 click，前面有 keydown）：照常打开，不当成滑完补来的那一下', () => {
    const onOpen = vi.fn();
    render(row('a', vi.fn(), vi.fn(), onOpen));
    swipe(face('a'), -40);
    fireEvent.keyDown(screen.getByTestId('a-main'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('a-main'), { detail: 0 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('运行日志：按下、定方向、松手各一行，松手记按下到松手的时长（ms=），不记内容', () => {
    const lines: string[] = [];
    render(row('a', vi.fn(), vi.fn(), vi.fn(), (l) => lines.push(l)));
    swipe(face('a'), -100);
    expect(lines.some((l) => l.startsWith('swipe down type=touch'))).toBe(true);
    expect(lines.some((l) => l.startsWith('swipe axis=h'))).toBe(true);
    expect(lines.find((l) => l.startsWith('swipe up'))).toMatch(/ ms=\d+/);
    expect(lines.join('\n')).not.toContain('行');
  });
});
