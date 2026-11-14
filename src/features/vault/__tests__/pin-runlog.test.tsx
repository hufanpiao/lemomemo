// 密码键盘（ui/Pin.tsx）
// • 不进运行日志（11-14 隐私记评审第 1 条）：点一遍、按一遍实体键，日志里看不出按了哪个数；点按只记 masked，没有坐标、没有 testid
// • 只做 4 位（负责人 11-14 原话“隐私记密只做4位数”）：固定 4 个圆点，输满 4 位自动交出，没有“确定”键
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRunLog, startRunLog } from '../../../platform/run-log.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { PinPad } from '../ui/Pin.tsx';

describe('密码键盘和运行日志', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
  });

  it('点 0～9 和确定、按实体数字键：日志只有 masked，没有坐标、testid、keyCode', () => {
    const onSubmit = vi.fn();
    render(<PinPad testId="pp" msgTestId="pp-err" onSubmit={onSubmit} />);
    const stop = startRunLog(window, { version: 'test' });
    for (let i = 0; i <= 9; i++) {
      const b = screen.getByTestId(`pp-key-${i}`);
      fireEvent.pointerDown(b, { clientX: 10 * i + 3, clientY: 7 });
      fireEvent.pointerUp(b, { clientX: 10 * i + 3, clientY: 7 });
      fireEvent.click(b);
    }
    fireEvent.click(screen.getByTestId('pp-del'));
    expect(onSubmit.mock.calls).toEqual([['1234'], ['5678']]);
    fireEvent.keyDown(screen.getByTestId('pp-key-3'), { key: '7', keyCode: 55 });
    stop();
    const app = readRunLog()
      .split('\n')
      .filter((l) => !l.startsWith('===') && !/ (boot|settled)\b/.test(l));
    const taps = app.filter((l) => / (down|up|click) /.test(l));
    expect(taps.length).toBeGreaterThanOrEqual(31);
    for (const l of taps) expect(l).toMatch(/ (down|up|click) masked( \w*)?$/);
    const all = app.join('\n');
    expect(all).not.toMatch(/pp-key|pp-ok|x=\d|y=\d|code=\d/);
    expect(all).toMatch(/key (char on=)?masked/);
  });
});

describe('只做 4 位', () => {
  afterEach(cleanup);
  it('固定 4 个圆点；输满 4 位自动交出、清空；没有“确定”键；实体键盘同样满 4 位交出', () => {
    const onSubmit = vi.fn();
    render(<PinPad testId="pp" msgTestId="pp-err" onSubmit={onSubmit} />);
    const dots = () => screen.getByTestId('pp-dots').querySelectorAll('i').length;
    expect(dots()).toBe(4);
    expect(screen.queryByTestId('pp-ok')).toBeNull();
    for (const i of [0, 1, 2]) fireEvent.click(screen.getByTestId(`pp-key-${i}`));
    expect(dots()).toBe(4);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('pp-key-9'));
    expect(onSubmit).toHaveBeenCalledWith('1230');
    expect(screen.getByTestId('pp-dots').getAttribute('data-n')).toBe('0');
    for (const k of ['4', '3', '2', '1']) fireEvent.keyDown(window, { key: k });
    expect(onSubmit).toHaveBeenLastCalledWith('4321');
  });
});
