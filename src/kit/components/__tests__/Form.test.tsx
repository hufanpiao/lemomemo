// 表单文本框的草稿提交（代码审查 M1、S6）：失焦 / 回车交；卸载、pagehide、visibilitychange 变 hidden 时补交；同一份只交一次；和外面一样不交
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Check, dateReady, TextArea, TextInput } from '../Form.tsx';
import styles from '../Form.module.css';

afterEach(() => {
  cleanup();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('草稿补交（M1）', () => {
  it('敲了字没失焦就卸载（后退、跳走）：交一次', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput value="A" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'AB' } });
    expect(onCommit).not.toHaveBeenCalled();
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('AB');
  });

  it('visibilitychange 变成 hidden：交；变回 visible 不再交；之后卸载也不重复交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextArea value="" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: '备注' } });
    setVisibility('visible');
    expect(onCommit).not.toHaveBeenCalled();
    setVisibility('hidden');
    expect(onCommit).toHaveBeenCalledWith('备注');
    setVisibility('visible');
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('pagehide：交', () => {
    const onCommit = vi.fn();
    render(<TextInput value="" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'x' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(onCommit).toHaveBeenCalledWith('x');
  });

  it('改回和外面一样、或者根本没改：不交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput value="A" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'AB' } });
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'A' } });
    fireEvent.blur(screen.getByTestId('t'));
    window.dispatchEvent(new Event('pagehide'));
    unmount();
    expect(onCommit).not.toHaveBeenCalled();
    const other = vi.fn();
    const r2 = render(<TextInput value="B" onCommit={other} data-testid="t2" />);
    r2.unmount();
    expect(other).not.toHaveBeenCalled();
  });

  it('失焦交过一次：卸载不重复交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput value="A" onCommit={onCommit} data-testid="t" />);
    fireEvent.focus(screen.getByTestId('t'));
    fireEvent.change(screen.getByTestId('t'), { target: { value: 'AB' } });
    fireEvent.blur(screen.getByTestId('t'));
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
  });
});

describe('日期框（S6）', () => {
  it('dateReady：空串、年份 ≥ 1900 的合法格式才算定了', () => {
    expect(dateReady('')).toBe(true);
    expect(dateReady('2026-11-05')).toBe(true);
    expect(dateReady('1900-01-01')).toBe(true);
    for (const v of ['0002-11-05', '0020-11-05', '0202-11-05', '1899-12-31', '2026-1-5', 'x']) expect(dateReady(v)).toBe(false);
  });

  it('逐位敲年份：中间那几个不交，敲够了才交；卸载时没敲够的也不交', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<TextInput type="date" value="2026-11-05" onCommit={onCommit} data-testid="d" />);
    const el = screen.getByTestId('d');
    fireEvent.focus(el);
    for (const v of ['0002-11-05', '0020-11-05', '0202-11-05']) fireEvent.change(el, { target: { value: v } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(el, { target: { value: '2027-11-05' } });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('2027-11-05');
    fireEvent.change(el, { target: { value: '0003-11-05' } });
    unmount();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('年份没敲够就失焦（没存上）：框里退回外面的值，不留着 0202', () => {
    const onCommit = vi.fn();
    render(<TextInput type="date" value="2026-11-05" onCommit={onCommit} data-testid="d" />);
    const el = screen.getByTestId('d') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '0202-11-05' } });
    fireEvent.blur(el);
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.value).toBe('2026-11-05');
  });

  it('时刻框：选完就交', () => {
    const onCommit = vi.fn();
    render(<TextInput type="time" value="09:00" onCommit={onCommit} data-testid="tm" />);
    fireEvent.focus(screen.getByTestId('tm'));
    fireEvent.change(screen.getByTestId('tm'), { target: { value: '10:30' } });
    expect(onCommit).toHaveBeenCalledWith('10:30');
  });
});

// B2-UI-b W5（D2 ①）：Check look="switch" 是开关：role="switch"、用 Form.module.css 里共用的 .switch；空格、点击切换，禁用不切
describe('TextArea 的 single、idleMs、autoGrow（R-420 审查第 9 条：随手记编辑器的标题、正文框改用它）', () => {
  it('single：粘贴进来的换行变空格；回车不换行、当作写完（失焦就交）', () => {
    const onCommit = vi.fn();
    render(<TextArea single value="" onCommit={onCommit} data-testid="t" />);
    const el = screen.getByTestId('t') as HTMLTextAreaElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '第一行\n第二行\r\n三' } });
    expect(el.value).toBe('第一行 第二行 三');
    el.focus();
    const enter = fireEvent.keyDown(el, { key: 'Enter', keyCode: 13 });
    expect(enter, '回车不换行').toBe(false);
    expect(onCommit).toHaveBeenCalledWith('第一行 第二行 三');
  });

  it('idleMs：停笔这么久交一次，接着敲字重新计时', () => {
    vi.useFakeTimers();
    try {
      const onCommit = vi.fn();
      render(<TextArea idleMs={800} value="" onCommit={onCommit} data-testid="t" />);
      const el = screen.getByTestId('t');
      fireEvent.focus(el);
      fireEvent.change(el, { target: { value: 'a' } });
      vi.advanceTimersByTime(700);
      fireEvent.change(el, { target: { value: 'ab' } });
      vi.advanceTimersByTime(700);
      expect(onCommit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(onCommit).toHaveBeenCalledExactlyOnceWith('ab');
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoGrow：高度跟着内容（量 scrollHeight 写回 height）', () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(123);
    render(<TextArea autoGrow value="x" onCommit={vi.fn()} data-testid="t" />);
    expect((screen.getByTestId('t') as HTMLTextAreaElement).style.height).toBe('123px');
    vi.restoreAllMocks();
  });
});

describe('Check look="switch"', () => {
  it('读屏是开关，带共用开关的类；点一下交出新值', () => {
    const onChange = vi.fn();
    render(<Check label="重要" checked={false} look="switch" onChange={onChange} />);
    const el = screen.getByRole('switch', { name: '重要' }) as HTMLInputElement;
    expect(el.className.split(' ')).toContain(styles.switch);
    expect(el.checked).toBe(false);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(el);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  // 禁用时浏览器不派发点击（jsdom 的 fireEvent 照派，这里只核 disabled 属性；真浏览器里的“点不动”由编辑页只读 e2e 管）
  it('开着时 checked；禁用时 input 带 disabled', () => {
    render(<Check label="全天" checked look="switch" disabled onChange={() => undefined} />);
    const el = screen.getByRole('switch', { name: '全天' }) as HTMLInputElement;
    expect(el.checked).toBe(true);
    expect(el.disabled).toBe(true);
  });

  it('默认方框、圆圈不带 role="switch"', () => {
    render(
      <>
        <Check label="方框" checked={false} onChange={() => undefined} />
        <Check label="圆圈" checked={false} look="circle" onChange={() => undefined} />
      </>,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('回车提交和输入法组字（Q-21）', () => {
  const typed = (onCommit: (v: string) => void) => {
    render(<TextInput value="" onCommit={onCommit} data-testid="t" />);
    const el = screen.getByTestId('t');
    el.focus();
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '한글' } });
    return el;
  };

  it('中文、韩文输入法组字时按回车是选字：不失焦、不交（isComposing）', () => {
    const onCommit = vi.fn();
    const el = typed(onCommit);
    fireEvent.keyDown(el, { key: 'Enter', isComposing: true });
    expect(document.activeElement).toBe(el);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Safari 选字那一下回车的 keyCode 是 229（isComposing 为假）：同样不失焦、不交', () => {
    const onCommit = vi.fn();
    const el = typed(onCommit);
    fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 });
    expect(document.activeElement).toBe(el);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('组字结束后再按回车：失焦并交', () => {
    const onCommit = vi.fn();
    const el = typed(onCommit);
    fireEvent.keyDown(el, { key: 'Enter', keyCode: 13 });
    expect(document.activeElement).not.toBe(el);
    expect(onCommit).toHaveBeenCalledWith('한글');
  });
});
