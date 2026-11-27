// 打字条光标定位日志（台账 #484）：记位置、选区下标和合成层，不记输入的文字；输入框卸掉后不再记
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { caretLine, probeCaret } from '../caret-probe.ts';

const logs = vi.hoisted(() => [] as string[]);
vi.mock('../run-log-api.ts', () => ({ RLOG_ON: true, rlog: (l: string) => logs.push(l) }));

const SECRET = '不能进日志的字';

function field(): HTMLInputElement {
  const host = document.createElement('div');
  host.style.transform = 'translateY(10px)';
  const el = document.createElement('input');
  el.value = SECRET;
  host.append(el);
  document.body.append(host);
  el.focus();
  el.setSelectionRange(2, 2);
  return el;
}

beforeEach(() => {
  logs.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('caret-probe', () => {
  it('一行里有位置、选区下标、焦点和带变换的祖先，没有输入的文字', () => {
    const line = caretLine(field(), 120);
    expect(line).toMatch(/^caretprobe \+120 field=/);
    expect(line).toContain(`sel=2/${SECRET.length}`);
    expect(line).toContain('act=1');
    expect(line).toContain('layers=div:t');
    expect(line).not.toContain(SECRET);
  });

  it('聚焦后分 4 个时刻记；输入框卸掉后不再记', () => {
    const el = field();
    probeCaret(el);
    vi.advanceTimersByTime(400);
    expect(logs).toHaveLength(3);
    el.parentElement?.remove();
    vi.advanceTimersByTime(1000);
    expect(logs).toHaveLength(3);
  });
});
