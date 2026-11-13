// 密码键盘不进运行日志（11-14 隐私记评审第 1 条）：点一遍、按一遍实体键，日志里看不出按了哪个数
// • 点按只记 masked，没有坐标、没有 testid；实体键只记 key char，不记 keyCode
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
    render(<PinPad testId="pp" onSubmit={onSubmit} />);
    const stop = startRunLog(window, { version: 'test' });
    for (let i = 0; i <= 9; i++) {
      const b = screen.getByTestId(`pp-key-${i}`);
      fireEvent.pointerDown(b, { clientX: 10 * i + 3, clientY: 7 });
      fireEvent.pointerUp(b, { clientX: 10 * i + 3, clientY: 7 });
      fireEvent.click(b);
    }
    fireEvent.click(screen.getByTestId('pp-ok'));
    expect(onSubmit).toHaveBeenCalledWith('1234567890');
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
    expect(all).toMatch(/key char on=masked/);
  });
});
